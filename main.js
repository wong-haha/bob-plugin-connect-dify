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
 * 配置响应超时时长
 */
function pluginTimeoutInterval() {
  return 180;
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

/**
 * 构建请求体
 */
function buildRequestBody(text) {
  if (isWorkflowMode()) {
    const inputs = {};
    inputs[$option.inputKey] = text;
    return {
      inputs: inputs,
      response_mode: "streaming",
      user: "bob-plugin-user"
    };
  }
  // Chatflow 模式
  return {
    inputs: {},
    query: text,
    response_mode: "streaming",
    conversation_id: "",
    user: "bob-plugin-user",
    files: []
  };
}

/**
 * 构建 thinkInfo 对象
 * - 如果有独立的 reasoning_content，使用 content 字段传递
 * - 否则使用 splitThinkTag 自动解析 <think> 标签
 */
function buildThinkInfo(reasoningText) {
  if (reasoningText) {
    return { content: reasoningText };
  }
  return { splitThinkTag: true };
}

/**
 * 推送流式结果
 */
function pushStream(query, ctx) {
  query.onStream({
    result: {
      toParagraphs: [ctx.targetText],
      thinkInfo: buildThinkInfo(ctx.hasReasoningField ? ctx.reasoningText : null)
    }
  });
}

/**
 * 处理 Chatflow 模式的响应事件
 */
function handleChatflowEvent(query, ctx, responseObj) {
  if (responseObj.event === "message") {
    if (responseObj.reasoning_content) {
      ctx.reasoningText += responseObj.reasoning_content;
      ctx.hasReasoningField = true;
    }
    if (responseObj.answer) {
      ctx.targetText += responseObj.answer;
    }
    if (responseObj.answer || responseObj.reasoning_content) {
      pushStream(query, ctx);
    }
  } else if (responseObj.event === "node_finished" && responseObj.data?.process_data?.messages) {
    responseObj.data.process_data.messages.forEach(message => {
      if (message.role === "assistant") {
        if (message.reasoning_content) {
          ctx.reasoningText += message.reasoning_content;
          ctx.hasReasoningField = true;
        }
        if (message.content) {
          ctx.targetText += message.content;
        }
        pushStream(query, ctx);
      }
    });
  }
}

/**
 * 处理 Workflow 模式的响应事件
 *
 * Workflow 流式事件类型：
 * - text_chunk: 流式文本片段，data.text 为文本内容
 * - workflow_finished: 工作流结束，data.outputs 为最终输出（兜底用）
 */
function handleWorkflowEvent(query, ctx, responseObj) {
  if (responseObj.event === "text_chunk") {
    const text = responseObj.data?.text || "";
    if (text) {
      ctx.targetText += text;
      pushStream(query, ctx);
    }
  } else if (responseObj.event === "node_finished") {
    // 某些 LLM 节点可能在 node_finished 中带有 reasoning_content
    const outputs = responseObj.data?.outputs;
    if (outputs && outputs.reasoning_content) {
      ctx.reasoningText += outputs.reasoning_content;
      ctx.hasReasoningField = true;
      pushStream(query, ctx);
    }
  } else if (responseObj.event === "workflow_finished") {
    // 兜底：如果流式过程中没有收到 text_chunk，从最终 outputs 中尝试提取文本
    if (!ctx.targetText && responseObj.data?.outputs) {
      const outputs = responseObj.data.outputs;
      // 尝试从 outputs 中提取文本内容（取第一个非空字符串值）
      const fallbackText = extractTextFromOutputs(outputs);
      if (fallbackText) {
        ctx.targetText = fallbackText;
        pushStream(query, ctx);
      }
    }
  }
}

/**
 * 从 Workflow outputs 对象中提取文本内容（兜底）
 * 优先取 text/output/result 等常见 key，否则取第一个非空字符串
 */
function extractTextFromOutputs(outputs) {
  if (!outputs || typeof outputs !== "object") return "";

  // 优先尝试常见的输出变量名
  const commonKeys = ["text", "output", "result", "answer", "content", "response"];
  for (const key of commonKeys) {
    if (typeof outputs[key] === "string" && outputs[key].trim()) {
      return outputs[key];
    }
  }

  // 兜底：取第一个非空字符串值
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
  if (isWorkflowMode()) {
    handleWorkflowEvent(query, ctx, responseObj);
  } else {
    handleChatflowEvent(query, ctx, responseObj);
  }
}

/**
 * 错误处理
 */
function handleError(query, result) {
  const statusCode = result.response?.statusCode || 0;
  const reason = statusCode >= 400 && statusCode < 500 ? 'param' : 'api';
  const message = result.data?.detail || '接口响应错误';
  query.onCompletion({ error: { type: reason, message } });
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

  const body = buildRequestBody(query.text);

  (async () => {
    const ctx = {
      targetText: '',
      reasoningText: '',
      hasReasoningField: false,
      buffer: ''
    };

    await $http.streamRequest({
      method: 'POST',
      url: $option.apiUrl,
      header: headers,
      body: body,
      cancelSignal: query.cancelSignal,
      streamHandler: (streamData) => {
        consumeSseChunk(query, ctx, streamData.text);
      },
      handler: (result) => {
        if (result.error || result.response.statusCode >= 400) {
          handleError(query, result);
        } else {
          // 收尾：处理缓冲区里残留的最后一行
          flushSseBuffer(query, ctx);
          // 如果流式过程中没收到任何内容，给出友好提示
          if (!ctx.targetText) {
            ctx.targetText = "[未收到有效输出，请检查 Dify 应用配置]";
          }
          query.onCompletion({
            result: {
              toParagraphs: [ctx.targetText],
              thinkInfo: buildThinkInfo(ctx.hasReasoningField ? ctx.reasoningText : null)
            }
          });
        }
      },
    });
  })().catch(err => {
    query.onCompletion({ error: { type: err._type || 'unknown', message: err._message || '未知错误' } });
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

  // 构建一个最简请求，用 blocking 模式快速验证连通性和鉴权
  const body = isWorkflowMode()
    ? {
        inputs: { [$option.inputKey]: "hi" },
        response_mode: "blocking",
        user: "bob-plugin-validate"
      }
    : {
        inputs: {},
        query: "hi",
        response_mode: "blocking",
        conversation_id: "",
        user: "bob-plugin-validate",
        files: []
      };

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