function supportLanguages() {
  return ['auto', 'zh-Hans', 'en', 'zh-Hant', 'ja', 'ko', 'fr', 'pl', 'nl', 'ru', 'it', 'pt'];
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * 两次 onStream 之间的最小间隔（毫秒）。
 *
 * 每次 onStream 都要把「累计全文」跨 JS↔原生边界序列化一遍，逐 token 推送时
 * 总流量是 O(n²)；长回答（上万字）下这既拖慢 Bob 也放大失败面。节流后正文的
 * 最终完整性由 onCompletion 保证。
 */
const STREAM_PUSH_INTERVAL_MS = 60;

/**
 * 思考阶段的正文占位文案。
 *
 * 模型先输出一大段 <think> 时，正文要等思考结束才开始，中间若不推送任何内容，
 * Bob 窗口会长时间空白；若推送空正文，Bob 又会报「插件未返回有效结果」。
 * 用一句占位文案顶住，思考面板就能边生成边看，正文一到就被覆盖。
 */
const THINKING_PLACEHOLDER = '思考中…';

/**
 * 检查配置项是否完整
 */
function validateOptions() {
  if (!$option.apiKey) return "API 密钥未配置，请在插件设置中填写 API 密钥。";
  if (!$option.apiUrl) return "API 地址未配置，请在插件设置中填写 API 地址。";
  if ($option.appType === "workflow" && !$option.inputKey) {
    return "Workflow 模式下需要配置输入变量名，请在插件设置中填写。";
  }
  return null;
}

/**
 * 判断当前是否为 Workflow 模式
 */
function isWorkflowMode() {
  return $option.appType === "workflow";
}

/**
 * 配置响应超时时长
 */
function pluginTimeoutInterval() {
  return 180;
}

/**
 * 一次翻译请求的全部可变状态
 */
function createContext() {
  return {
    targetText: '',      // 已解析出的正文
    reasoningText: '',   // 已解析出的思考内容
    fallbackText: '',    // 兜底正文（来自 workflow_finished / node_finished）
    buffer: '',          // SSE 行缓冲：跨网络分片拼完整行
    tagBuffer: '',       // <think> 标签缓冲：跨事件拼完整标签
    inThink: false,      // 当前是否处在 <think> ... </think> 之内
    eventCount: 0,       // 收到的事件总数（用于诊断）
    lastEvent: '',       // 最后一个事件名（用于诊断）
    streamError: null,   // SSE 里的 error 事件
    lastPushAt: 0,       // 上次 onStream 的时间戳
    done: false          // onCompletion 是否已调用
  };
}

/**
 * 解析流事件数据
 */
function parseStreamData(line) {
  const dataMatch = line.match(/^data:\s*(.*)$/);
  if (dataMatch) {
    try {
      return JSON.parse(dataMatch[1]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 消费一个 SSE 网络分片。
 *
 * 网络分片（chunk）的边界由网络栈决定，与 SSE 的换行无关，因此一条
 * `data: {...}` 行完全可能被切成两半、分布在相邻两次回调里。这里用
 * 跨回调的缓冲区 `ctx.buffer` 累积文本，只解析「以 \n 结尾的完整行」，
 * 把最后那段可能不完整的尾巴留在缓冲区，等下一个分片来补全，从而避免
 * 半行被 JSON.parse 丢弃导致的「丢行」。
 */
function consumeSseChunk(query, ctx, chunkText) {
  ctx.buffer += chunkText || '';
  let newlineIndex;
  while ((newlineIndex = ctx.buffer.indexOf('\n')) !== -1) {
    // 去掉结尾的 \r，兼容被代理规范化成 CRLF（\r\n）的 SSE 流
    const line = ctx.buffer.slice(0, newlineIndex).replace(/\r$/, '');
    ctx.buffer = ctx.buffer.slice(newlineIndex + 1);
    const responseObj = parseStreamData(line);
    if (responseObj) {
      handleResponse(query, ctx, responseObj);
    }
  }
}

/**
 * 流结束后，处理缓冲区里残留的最后一行（末尾可能没有 \n）。
 */
function flushSseBuffer(query, ctx) {
  if (!ctx.buffer) return;
  const responseObj = parseStreamData(ctx.buffer.replace(/\r$/, ''));
  if (responseObj) {
    handleResponse(query, ctx, responseObj);
  }
  ctx.buffer = '';
}

// ---------------------------------------------------------------------------
// <think> 标签的增量拆分
// ---------------------------------------------------------------------------

/**
 * 返回 text 末尾「有可能是 tag 前缀」的长度。
 *
 * 例如 tag = "</think>"、text = "正文</thi" 时返回 5：末尾的 "</thi" 还不能
 * 下结论，得留到下个片段拼上再判断。若末尾完全不可能是标签前缀则返回 0，
 * 这部分文本就可以立刻输出。
 */
function partialTagLength(text, tag) {
  const max = Math.min(tag.length - 1, text.length);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

/**
 * 按当前 inThink 状态，把一段纯文本归入正文或思考内容
 */
function appendPlainText(ctx, text) {
  if (!text) return;
  if (ctx.inThink) {
    ctx.reasoningText += text;
  } else {
    ctx.targetText += text;
  }
}

/**
 * 增量消费一段 answer 文本，边走边把 <think> ... </think> 剥离到思考内容里。
 *
 * 之所以自己拆而不交给 Bob 的 `thinkInfo.splitThinkTag`：流式过程中 `</think>`
 * 还没到，Bob 拿到的是一段「未闭合的 <think>」，剥完之后正文为空，Bob 会判定
 * 插件没有返回有效结果。自己拆就能保证推给 Bob 的永远是「干净且非空的正文」。
 */
function appendAnswerChunk(ctx, chunk) {
  if (!chunk) return;
  ctx.tagBuffer += chunk;

  for (;;) {
    const tag = ctx.inThink ? THINK_CLOSE : THINK_OPEN;
    const index = ctx.tagBuffer.indexOf(tag);
    if (index === -1) break;
    appendPlainText(ctx, ctx.tagBuffer.slice(0, index));
    ctx.tagBuffer = ctx.tagBuffer.slice(index + tag.length);
    ctx.inThink = !ctx.inThink;
  }

  // 没有完整标签了：只把「确定不是标签前缀」的部分吐出去，尾巴留着等下一片
  const tag = ctx.inThink ? THINK_CLOSE : THINK_OPEN;
  const keep = partialTagLength(ctx.tagBuffer, tag);
  if (keep < ctx.tagBuffer.length) {
    appendPlainText(ctx, ctx.tagBuffer.slice(0, ctx.tagBuffer.length - keep));
    ctx.tagBuffer = ctx.tagBuffer.slice(ctx.tagBuffer.length - keep);
  }
}

/**
 * 流结束后把标签缓冲区里残留的尾巴（半个标签 / 未闭合内容）归位
 */
function flushAnswerBuffer(ctx) {
  if (!ctx.tagBuffer) return;
  appendPlainText(ctx, ctx.tagBuffer);
  ctx.tagBuffer = '';
}

/**
 * 重新解析一整段 answer（用于 message_replace 与兜底文本）
 */
function reparseAnswer(ctx, text) {
  ctx.targetText = '';
  ctx.tagBuffer = '';
  ctx.inThink = false;
  const previousReasoning = ctx.reasoningText;
  ctx.reasoningText = '';
  appendAnswerChunk(ctx, text);
  flushAnswerBuffer(ctx);
  // 整段文本里没有 <think> 时，保留此前从 reasoning_content 字段收到的思考内容
  if (!ctx.reasoningText) ctx.reasoningText = previousReasoning;
}

// ---------------------------------------------------------------------------
// 请求与结果
// ---------------------------------------------------------------------------

/**
 * 构建请求体
 */
function buildRequestBody(text, responseMode) {
  if (isWorkflowMode()) {
    const inputs = {};
    inputs[$option.inputKey] = text;
    return {
      inputs: inputs,
      response_mode: responseMode,
      user: "bob-plugin-user"
    };
  }
  // Chatflow 模式
  return {
    inputs: {},
    query: text,
    response_mode: responseMode,
    conversation_id: "",
    user: "bob-plugin-user",
    files: []
  };
}

/**
 * 组装交给 Bob 的 result 对象
 */
function buildResult(query, ctx) {
  const result = { toParagraphs: [ctx.targetText] };
  if (query.detectFrom) result.from = query.detectFrom;
  if (query.detectTo) result.to = query.detectTo;
  if (ctx.reasoningText) result.thinkInfo = { content: ctx.reasoningText };
  return result;
}

/**
 * 推送流式结果。
 *
 * 两条铁律：
 * 1. 交给 Bob 的正文永不为空——空结果会被 Bob 判为「插件未返回有效结果」。
 *    思考阶段正文天然是空的，此时用占位文案顶住，让思考面板能边生成边显示。
 * 2. 推送有节流，避免长回答把「累计全文」重复搬运上万次。
 */
function pushStream(query, ctx) {
  const hasBody = ctx.targetText.trim().length > 0;
  if (!hasBody && !ctx.reasoningText) return;

  const now = Date.now();
  if (now - ctx.lastPushAt < STREAM_PUSH_INTERVAL_MS) return;
  ctx.lastPushAt = now;

  const result = buildResult(query, ctx);
  if (!hasBody) result.toParagraphs = [THINKING_PLACEHOLDER];
  query.onStream({ result });
}

/**
 * 处理 Chatflow 模式的响应事件
 */
function handleChatflowEvent(query, ctx, responseObj) {
  const event = responseObj.event;

  if (event === "message" || event === "agent_message") {
    if (responseObj.reasoning_content) {
      ctx.reasoningText += responseObj.reasoning_content;
    }
    appendAnswerChunk(ctx, responseObj.answer);
    pushStream(query, ctx);
    return;
  }

  // 内容审查等场景下 Dify 会用一整段新文本替换已输出的回答
  if (event === "message_replace") {
    reparseAnswer(ctx, responseObj.answer || '');
    pushStream(query, ctx);
    return;
  }

  if (event === "node_finished") {
    captureNodeFallback(ctx, responseObj);
  }
}

/**
 * 处理 Workflow 模式的响应事件
 *
 * - text_chunk: 流式文本片段，data.text 为文本内容
 * - node_finished / workflow_finished: 只记录为兜底，不直接拼进正文
 */
function handleWorkflowEvent(query, ctx, responseObj) {
  if (responseObj.event === "text_chunk") {
    appendAnswerChunk(ctx, responseObj.data && responseObj.data.text);
    pushStream(query, ctx);
    return;
  }

  if (responseObj.event === "node_finished") {
    captureNodeFallback(ctx, responseObj);
  }
}

/**
 * 从 node_finished 事件里收集「兜底正文」。
 *
 * 注意这里只是**记录**而不是拼接：节点事件与 message / text_chunk 描述的是同一段
 * 内容，直接拼接会让正文翻倍。只有当流式过程完全没拿到正文时才会用上。
 */
function captureNodeFallback(ctx, responseObj) {
  const data = responseObj.data || {};

  const messages = data.process_data && data.process_data.messages;
  if (Array.isArray(messages)) {
    const assistantText = messages
      .filter(message => message && message.role === "assistant")
      .map(message => message.content || '')
      .join('');
    if (assistantText) ctx.fallbackText = assistantText;
  }

  const outputs = data.outputs;
  if (outputs && typeof outputs === "object") {
    const outputText = extractTextFromOutputs(outputs);
    if (outputText) ctx.fallbackText = outputText;
    if (outputs.reasoning_content && !ctx.reasoningText) {
      ctx.reasoningText = outputs.reasoning_content;
    }
  }
}

/**
 * 从 outputs 对象中提取文本内容（兜底）
 * 优先取 answer/text/output/result 等常见 key，否则取第一个非空字符串
 */
function extractTextFromOutputs(outputs) {
  if (!outputs || typeof outputs !== "object") return "";

  const commonKeys = ["answer", "text", "output", "result", "content", "response"];
  for (const key of commonKeys) {
    if (typeof outputs[key] === "string" && outputs[key].trim()) {
      return outputs[key];
    }
  }

  for (const key of Object.keys(outputs)) {
    if (typeof outputs[key] === "string" && outputs[key].trim()) {
      return outputs[key];
    }
  }

  return "";
}

/**
 * 统一的流式事件分发
 */
function handleResponse(query, ctx, responseObj) {
  if (!responseObj || typeof responseObj !== "object") return;

  ctx.eventCount++;
  if (responseObj.event) ctx.lastEvent = responseObj.event;

  if (responseObj.event === "error") {
    ctx.streamError = responseObj.message || responseObj.code || "Dify 返回了 error 事件";
    return;
  }

  // Chatflow / Workflow 都会以 workflow_finished 收尾，其 outputs 里带着完整回答，
  // 是最可靠的兜底来源（正是 Dify 后台日志里看到的那段 JSON）。
  if (responseObj.event === "workflow_finished") {
    const outputText = extractTextFromOutputs(responseObj.data && responseObj.data.outputs);
    if (outputText) ctx.fallbackText = outputText;
    return;
  }

  if (isWorkflowMode()) {
    handleWorkflowEvent(query, ctx, responseObj);
  } else {
    handleChatflowEvent(query, ctx, responseObj);
  }
}

/**
 * 把 HTTP 层 / 状态码错误翻译成 Bob 的 error 对象
 */
function buildHttpError(result, statusCode) {
  if (statusCode >= 400) {
    const data = result.data || {};
    const detail = data.message || data.detail || `HTTP ${statusCode}`;
    if (statusCode === 401 || statusCode === 403) {
      return { type: 'secretKey', message: `鉴权失败，请检查 API 密钥：${detail}` };
    }
    const type = statusCode < 500 ? 'param' : 'api';
    return { type, message: `Dify 接口返回错误：${detail}` };
  }

  const error = (result && result.error) || {};
  const message = error._message || error.localizedDescription || error.message || '网络请求失败，请检查 API 地址是否可达';
  return { type: error._type || 'network', message };
}

/**
 * 根据当前 ctx 与 HTTP 结果，算出最终交给 Bob 的 completion 载荷
 */
function buildCompletionPayload(query, ctx, result) {
  flushSseBuffer(query, ctx);
  flushAnswerBuffer(ctx);

  const statusCode = (result && result.response && result.response.statusCode) || 0;
  if ((result && result.error) || statusCode >= 400) {
    return { error: buildHttpError(result || {}, statusCode) };
  }

  if (ctx.streamError) {
    return { error: { type: 'api', message: `Dify 返回错误：${ctx.streamError}` } };
  }

  // 流式没拿到正文时，用 workflow_finished / node_finished 里的完整回答兜底
  if (!ctx.targetText.trim() && ctx.fallbackText) {
    reparseAnswer(ctx, ctx.fallbackText);
  }

  // 只拿到了思考内容（例如 <think> 始终没闭合）：把它当正文展示，总比报错好
  if (!ctx.targetText.trim() && ctx.reasoningText) {
    ctx.targetText = ctx.reasoningText;
    ctx.reasoningText = '';
  }

  if (!ctx.targetText.trim()) {
    ctx.targetText = `[未解析到文本内容：共收到 ${ctx.eventCount} 个事件，最后一个事件为 ${ctx.lastEvent || '（无）'}。` +
      `请检查 Dify 应用是否配置了输出节点（Chatflow 需要「直接回复」节点，Workflow 需要「结束」节点）]`;
  }

  return { result: buildResult(query, ctx) };
}

/**
 * 收尾：保证 onCompletion 恰好被调用一次，且一定带着可用的载荷。
 *
 * Bob 会在插件「没有调用 onCompletion」或「结果为空」时提示「插件未返回有效结果」，
 * 所以这里既做去重（done 标志），也做兜底（内部异常也要转成 error 返回）。
 */
function finish(query, ctx, result) {
  if (ctx.done) return;
  ctx.done = true;

  let payload;
  try {
    payload = buildCompletionPayload(query, ctx, result);
  } catch (error) {
    payload = {
      error: {
        type: 'unknown',
        message: `插件内部错误：${(error && (error._message || error.message)) || error}`
      }
    };
  }
  query.onCompletion(payload);
}

/**
 * 主函数
 */
function translate(query) {
  const validationError = validateOptions();
  if (validationError) {
    return query.onCompletion({ error: { type: 'param', message: validationError } });
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${$option.apiKey}`,
  };

  const body = buildRequestBody(query.text, "streaming");
  const ctx = createContext();

  (async () => {
    // $http.streamRequest 既会回调 handler，也会 resolve 出同一个结果。
    // 两条路都接到 finish 上，哪条先到都能正常收尾（finish 自带去重）。
    const result = await $http.streamRequest({
      method: 'POST',
      url: $option.apiUrl,
      header: headers,
      body: body,
      cancelSignal: query.cancelSignal,
      streamHandler: (streamData) => {
        try {
          consumeSseChunk(query, ctx, streamData && streamData.text);
        } catch (error) {
          // 单个分片解析失败不应中断整条流，收尾时还有兜底路径
        }
      },
      handler: (handlerResult) => {
        finish(query, ctx, handlerResult);
      },
    });
    finish(query, ctx, result);
  })().catch(err => {
    finish(query, ctx, { error: err });
  });
}

/**
 * 验证配置是否有效
 * Bob 会在服务配置页展示「验证」按钮，点击后调用此函数
 */
function pluginValidate(completion) {
  const configError = validateOptions();
  if (configError) {
    completion({ result: false, error: { message: configError } });
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${$option.apiKey}`,
  };

  // 用 blocking 模式快速验证连通性和鉴权
  const body = buildRequestBody("hi", "blocking");
  body.user = "bob-plugin-validate";

  (async () => {
    await $http.request({
      method: "POST",
      url: $option.apiUrl,
      header: headers,
      body: body,
      handler: (result) => {
        if (result.error) {
          completion({
            result: false,
            error: { message: `网络请求失败：${result.error.localizedDescription || "请检查 API 地址是否可达"}` }
          });
        } else if (result.response.statusCode === 401 || result.response.statusCode === 403) {
          completion({
            result: false,
            error: { message: "API 密钥无效，请检查后重试。" }
          });
        } else if (result.response.statusCode >= 400) {
          const detail = result.data?.detail || result.data?.message || `HTTP ${result.response.statusCode}`;
          completion({
            result: false,
            error: { message: `请求失败：${detail}` }
          });
        } else {
          completion({ result: true });
        }
      }
    });
  })().catch(err => {
    completion({
      result: false,
      error: { message: err._message || "验证过程发生未知错误" }
    });
  });
}

module.exports = { translate, pluginValidate };
