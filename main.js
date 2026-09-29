function supportLanguages() {
  return ['auto', 'zh-Hans', 'en', 'zh-Hant', 'ja', 'ko', 'fr', 'pl', 'nl', 'ru', 'it', 'pt'];
}

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
 * 配置响应超时时长（秒）
 */
function pluginTimeoutInterval() {
  return 180;
}

/**
 * 创建单次翻译生命周期的上下文
 */
function createContext() {
  return {
    targetText: '',        // 已解析出的正文（单调累积全文）
    reasoningText: '',     // 独立推理字段累积的思考过程（如 agent_thought / reasoning_content）
    hasReasoningField: false, // 是否由独立推理字段传入思考内容
    fallbackText: '',      // 兜底正文（workflow_finished / node_finished）
    buffer: '',            // SSE 行缓冲：跨网络分片拼装完整 data 行
    lastPushAt: 0,         // 上一次调用 onStream 的时间戳
    eventCount: 0,         // 累计收到的合法 SSE 事件数
    lastEvent: '',         // 最后一个收到的事件名
    streamError: null,     // 接口流中明确抛出的 error 内容
    done: false            // 确保 onCompletion 仅触发一次
  };
}

/**
 * 解析单个 SSE 行的数据
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
 * 消费 SSE 网络分片，以 
 切割并保留未闭合的尾部在缓冲区
 */
function consumeSseChunk(query, ctx, chunkText) {
  ctx.buffer += chunkText || '';
  let newlineIndex;
  while ((newlineIndex = ctx.buffer.indexOf('\n')) !== -1) {
    const line = ctx.buffer.slice(0, newlineIndex).replace(/\r$/, '');
    ctx.buffer = ctx.buffer.slice(newlineIndex + 1);
    const responseObj = parseStreamData(line);
    if (responseObj) {
      handleResponse(query, ctx, responseObj);
    }
  }
}

/**
 * 流结束收尾：处理缓冲区残留的最后一行
 */
function flushSseBuffer(query, ctx) {
  if (!ctx.buffer) return;
  const responseObj = parseStreamData(ctx.buffer.replace(/\r$/, ''));
  if (responseObj) {
    handleResponse(query, ctx, responseObj);
  }
  ctx.buffer = '';
}

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
 * 构建符合 Bob 1.21.0 规范的 thinkInfo
 * - 当存在独立推理字段时通过 content 传回
 * - 否则开启 splitThinkTag 让 Bob 1.21.0 原生在 Markdown 渲染中自动分离 <think> 思考框
 */
function buildThinkInfo(ctx) {
  if (ctx.hasReasoningField && ctx.reasoningText) {
    return { content: ctx.reasoningText };
  }
  return { splitThinkTag: true };
}

/**
 * 组装符合 Bob 1.21.0 标准的 translate result 对象
 */
function buildResult(query, ctx) {
  const result = {
    content: {
      format: 'markdown',
      text: ctx.targetText
    },
    toParagraphs: [ctx.targetText],
    thinkInfo: buildThinkInfo(ctx)
  };
  if (query.detectFrom) result.from = query.detectFrom;
  if (query.detectTo) result.to = query.detectTo;
  return result;
}

/**
 * 实时推送流式数据给 Bob（onStream）
 * 遵循 Bob 1.21.0：每次推送累计的 Markdown 全文与思考配置
 */
function pushStream(query, ctx) {
  if (!query || typeof query.onStream !== 'function') return;
  if (!ctx.targetText && !ctx.reasoningText) return;

  const now = Date.now();
  if (now - ctx.lastPushAt < 25) return;
  ctx.lastPushAt = now;

  const result = buildResult(query, ctx);
  const streamPayload = Object.assign({ result: result }, result);
  query.onStream(streamPayload);
}

/**
 * 处理 Chatflow 模式事件
 */
function handleChatflowEvent(query, ctx, responseObj) {
  const event = responseObj.event;

  // 1. Agent 思考过程
  if (event === "agent_thought") {
    const thought = responseObj.thought || "";
    if (thought) {
      ctx.reasoningText += thought;
      ctx.hasReasoningField = true;
      pushStream(query, ctx);
    }
    return;
  }

  // 2. 文本消息与带独立推理的消息
  if (event === "message" || event === "agent_message") {
    const reasoning = responseObj.reasoning_content || responseObj.thought;
    if (reasoning) {
      ctx.reasoningText += reasoning;
      ctx.hasReasoningField = true;
    }
    if (responseObj.answer) {
      ctx.targetText += responseObj.answer;
    }
    pushStream(query, ctx);
    return;
  }

  // 3. 内容审核或消息替换
  if (event === "message_replace") {
    if (responseObj.answer) {
      ctx.targetText = responseObj.answer;
      pushStream(query, ctx);
    }
    return;
  }

  if (event === "node_finished") {
    captureNodeFallback(ctx, responseObj);
  }
}

/**
 * 处理 Workflow 模式事件
 */
function handleWorkflowEvent(query, ctx, responseObj) {
  if (responseObj.event === "text_chunk") {
    const data = responseObj.data || {};
    const reasoning = data.reasoning_content || data.thought;
    if (reasoning) {
      ctx.reasoningText += reasoning;
      ctx.hasReasoningField = true;
    }
    if (data.text) {
      ctx.targetText += data.text;
    }
    pushStream(query, ctx);
    return;
  }

  if (responseObj.event === "node_finished") {
    captureNodeFallback(ctx, responseObj);
  }
}

/**
 * 捕获节点完成事件中的兜底输出
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
    const reasoning = outputs.reasoning_content || outputs.thought;
    if (reasoning && !ctx.reasoningText) {
      ctx.reasoningText = reasoning;
      ctx.hasReasoningField = true;
    }
  }
}

/**
 * 从 outputs 对象中提取文本内容（兜底）
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
 * 将网络与 HTTP 状态码错误转化为 Bob 的 error 对象
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
 * 翻译生命周期完成回调（保证触发且仅触发一次）
 */
function finish(query, ctx, result) {
  if (ctx.done) return;
  ctx.done = true;

  flushSseBuffer(query, ctx);

  const statusCode = (result && result.response && result.response.statusCode) || 0;
  if ((result && result.error) || statusCode >= 400) {
    query.onCompletion({ error: buildHttpError(result || {}, statusCode) });
    return;
  }

  if (ctx.streamError) {
    query.onCompletion({ error: { type: 'api', message: `Dify 返回错误：${ctx.streamError}` } });
    return;
  }

  if (!ctx.targetText.trim() && ctx.fallbackText) {
    ctx.targetText = ctx.fallbackText;
  }

  if (!ctx.targetText.trim() && ctx.reasoningText) {
    ctx.targetText = ctx.reasoningText;
    ctx.reasoningText = '';
  }

  if (!ctx.targetText.trim()) {
    ctx.targetText = `[未收到有效输出：请检查 Dify 应用配置]`;
  }

  const finalResult = buildResult(query, ctx);
  query.onCompletion({ result: finalResult });
}

/**
 * 主翻译函数
 */
function translate(query) {
  const validationError = validateOptions();
  if (validationError) {
    return query.onCompletion({ error: { type: 'param', message: validationError } });
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${$option.apiKey}`,
    "Accept": "text/event-stream"
  };

  const body = buildRequestBody(query.text, "streaming");
  const ctx = createContext();

  try {
    $http.streamRequest({
      method: 'POST',
      url: $option.apiUrl,
      header: headers,
      body: body,
      cancelSignal: query.cancelSignal,
      streamHandler: (streamData) => {
        try {
          consumeSseChunk(query, ctx, streamData && streamData.text);
        } catch (error) {
          // 单个分片解析异常不阻断整流
        }
      },
      handler: (handlerResult) => {
        finish(query, ctx, handlerResult);
      },
    });
  } catch (err) {
    finish(query, ctx, { error: err });
  }
}

/**
 * 自定义验证函数
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
        } else if (result.response && (result.response.statusCode === 401 || result.response.statusCode === 403)) {
          completion({
            result: false,
            error: { message: "API 密钥无效，请检查后重试。" }
          });
        } else if (result.response && result.response.statusCode >= 400) {
          const detail = (result.data && (result.data.detail || result.data.message)) || `HTTP ${result.response.statusCode}`;
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
      error: { message: (err && (err._message || err.message)) || "验证过程发生未知错误" }
    });
  });
}

module.exports = { translate, pluginValidate };
