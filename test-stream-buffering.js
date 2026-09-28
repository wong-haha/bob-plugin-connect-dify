/**
 * 回归脚本：Dify 流式解析的端到端回归测试。
 *
 * 覆盖两代问题：
 *  1. v0.7.1 修掉的「跨网络分片丢行」——把同一条 SSE 流按不同「箱子大小」喂进去。
 *  2. v0.8.0 修掉的「插件未返回有效结果」——思考阶段推给 Bob 的正文为空、
 *     onCompletion 可能不被调用、node 事件重复拼接等。
 *
 * 用法：
 *   node test-stream-buffering.js                        # 测当前目录 ./main.js
 *   node test-stream-buffering.js /path/to/old-main.js    # 对比测旧版
 *
 * 退出码：全部通过为 0，存在失败为 1。
 */

const path = require('path');
const assert = require('assert');

const modulePath = path.resolve(process.argv[2] || path.join(__dirname, 'main.js'));

// 与 main.js 中的常量保持一致：思考阶段推给 Bob 的正文占位文案
const THINKING_PLACEHOLDER = '思考中…';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/**
 * 把整段 SSE 文本按「字节」切成 chunk，并用流式解码（stream:true）模拟真实
 * HTTP 客户端：多字节字符被切在分片边界时会被解码器缓冲，emit 的始终是合法
 * 文本增量——这正是 Bob `streamHandler(streamData)` 收到的 `streamData.text`。
 */
function feedStream(streamHandler, fullText, chunkSizeBytes) {
  const bytes = new TextEncoder().encode(fullText);
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < bytes.length; i += chunkSizeBytes) {
    const text = decoder.decode(bytes.subarray(i, i + chunkSizeBytes), { stream: true });
    if (text) streamHandler({ text });
  }
  const tail = decoder.decode();
  if (tail) streamHandler({ text: tail });
}

/**
 * 模拟 Bob 拿到 result 之后真正显示给用户的正文。
 *
 * 当插件声明 `thinkInfo.splitThinkTag === true` 时，Bob 会自己从正文里摘掉
 * `<think>...</think>`；标签**未闭合**时，从 `<think>` 起的内容全部算思考，
 * 于是可显示正文可能为空——这正是「插件未返回有效结果」的由来。
 */
function renderLikeBob(result) {
  const text = (result.toParagraphs || []).join('\n');
  if (result.thinkInfo && result.thinkInfo.splitThinkTag) {
    const open = text.indexOf('<think>');
    if (open !== -1) {
      const close = text.indexOf('</think>', open);
      return close === -1
        ? text.slice(0, open)
        : text.slice(0, open) + text.slice(close + '</think>'.length);
    }
  }
  return text;
}

/**
 * 运行单个用例：装好 mock 全局，调用 translate，收集所有 onStream / onCompletion。
 *
 * `transport` 决定 mock 的 $http 行为，用来模拟 Bob 各种回调时序：
 *  - 'both'        ：既回调 handler 又 resolve 结果（Bob 常规行为）
 *  - 'promiseOnly' ：只 resolve，不回调 handler
 *  - 'handlerOnly' ：只回调 handler，resolve undefined
 *  - 'throw'       ：请求直接抛错
 */
function runCase(c) {
  return new Promise((resolve) => {
    global.$option = Object.assign(
      { appType: 'chatflow', apiKey: 'test-key', apiUrl: 'https://example.com/v1/chat-messages' },
      c.option
    );

    const streams = [];
    const completions = [];
    const httpResult = c.httpResult || { response: { statusCode: 200 }, data: {} };
    const transport = c.transport || 'both';

    global.$http = {
      streamRequest: async ({ streamHandler, handler }) => {
        if (transport === 'throw') {
          throw { _type: 'network', _message: '模拟网络中断' };
        }
        feedStream(streamHandler, c.sse || '', c.chunkSize || 9999);
        if (transport === 'both' || transport === 'handlerOnly') handler(httpResult);
        return transport === 'handlerOnly' ? undefined : httpResult;
      },
      request: async () => {}
    };

    // 每个用例重新加载模块，避免任何模块级状态污染。
    delete require.cache[require.resolve(modulePath)];
    const { translate } = require(modulePath);

    const query = {
      text: 'hi',
      detectFrom: 'auto',
      detectTo: 'zh-Hans',
      onStream: (payload) => streams.push(payload),
      onCompletion: (payload) => completions.push(payload),
      cancelSignal: null
    };

    translate(query);
    // translate 内部是 async IIFE；mock 的 $http 同步完成，清空微任务队列后结果就绪。
    setImmediate(() => setImmediate(() => resolve({ streams, completions })));
  });
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

function checkCase(c, { streams, completions }) {
  // 1. onCompletion 必须恰好一次——少了 Bob 报「插件未返回有效结果」，多了会乱刷结果
  assert.strictEqual(completions.length, 1, `onCompletion 调用了 ${completions.length} 次，期望 1 次`);
  const final = completions[0];

  if (c.expectErrorLike) {
    assert.ok(final.error, `期望返回 error，实际=${JSON.stringify(final).slice(0, 200)}`);
    assert.ok(
      new RegExp(c.expectErrorLike).test(final.error.message || ''),
      `error.message 不匹配 /${c.expectErrorLike}/，实际=${JSON.stringify(final.error)}`
    );
    return;
  }

  assert.ok(final.result, `期望返回 result，实际=${JSON.stringify(final).slice(0, 200)}`);

  // 2. 任何一次推送给 Bob 的可显示正文都不能为空
  const payloads = streams.concat([final]);
  payloads.forEach((payload, i) => {
    const rendered = renderLikeBob(payload.result);
    assert.ok(
      rendered.trim().length > 0,
      `第 ${i + 1}/${payloads.length} 次推送给 Bob 的可显示正文为空` +
        `（toParagraphs=${JSON.stringify(payload.result.toParagraphs)}, ` +
        `thinkInfo=${JSON.stringify(payload.result.thinkInfo)}）`
    );
  });

  // 3. 正文与思考内容符合预期
  assert.strictEqual(
    renderLikeBob(final.result),
    c.expectTarget,
    `正文不匹配，实际=${JSON.stringify(renderLikeBob(final.result))}`
  );

  if (c.expectReasoning != null) {
    const think = final.result.thinkInfo || {};
    assert.strictEqual(
      think.content,
      c.expectReasoning,
      `思考内容不匹配，实际=${JSON.stringify(think.content)}`
    );
  }

  // 4. 流式中间态必须是最终正文的前缀（不能出现回退 / 重复拼接）。
  //    message_replace 会整段替换已输出内容，天然不满足前缀关系，单独豁免。
  if (c.allowRewrite) return;
  streams.forEach((payload, i) => {
    const partial = renderLikeBob(payload.result);
    // 思考阶段的占位文案不参与前缀比较
    if (partial === THINKING_PLACEHOLDER) return;
    assert.ok(
      c.expectTarget.startsWith(partial),
      `第 ${i + 1} 次流式正文不是最终正文的前缀，实际=${JSON.stringify(partial.slice(0, 120))}`
    );
  });
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const CHATFLOW = { appType: 'chatflow' };
const WORKFLOW = {
  appType: 'workflow',
  inputKey: 'query',
  apiUrl: 'https://example.com/v1/workflows/run'
};

// 合并式 <think>（chatflow）：推理与正文都塞在 answer 里。
const MERGED_THINK_LF =
  'data: {"event":"message","answer":"\\n<think>\\n"}\n\n' +
  'data: {"event":"message","answer":"用户在打招呼，"}\n\n' +
  'data: {"event":"message","answer":"应当礼貌回应。\\n"}\n\n' +
  'data: {"event":"message","answer":"</think>\\n"}\n\n' +
  'data: {"event":"message","answer":"# 回复\\n你好！很高兴见到你。"}\n\n' +
  'data: {"event":"message_end"}\n\n';
const MERGED_THINK_TARGET = '\n\n# 回复\n你好！很高兴见到你。';
const MERGED_THINK_REASONING = '\n用户在打招呼，应当礼貌回应。\n';

// CRLF 变体：验证对被代理规范化成 CRLF 的流的兼容。
const MERGED_THINK_CRLF = MERGED_THINK_LF.replace(/\n/g, '\r\n');

// 标签被 Dify 切在**两个 SSE 事件**之间（模型逐 token 吐出 "</think>"）。
const SPLIT_TAG_SSE =
  'data: {"event":"message","answer":"<"}\n\n' +
  'data: {"event":"message","answer":"think"}\n\n' +
  'data: {"event":"message","answer":">"}\n\n' +
  'data: {"event":"message","answer":"先想一下"}\n\n' +
  'data: {"event":"message","answer":"</thi"}\n\n' +
  'data: {"event":"message","answer":"nk>"}\n\n' +
  'data: {"event":"message","answer":"最终答案"}\n\n' +
  'data: {"event":"message_end"}\n\n';

// <think> 一直没闭合（模型被截断）：此时正文为空，必须退化成展示思考内容而不是报错。
const UNCLOSED_THINK_SSE =
  'data: {"event":"message","answer":"\\n<think>\\n"}\n\n' +
  'data: {"event":"message","answer":"我正在推理，然后被截断了"}\n\n' +
  'data: {"event":"message_end"}\n\n';

// 只有 workflow_finished 带着完整回答（message 事件全部缺失的极端情况）。
// outputs 的形状与用户 Dify 后台日志里看到的一致：{"answer": ..., "files": []}
const ONLY_WORKFLOW_FINISHED_SSE =
  'data: {"event":"workflow_started","data":{}}\n\n' +
  'data: {"event":"workflow_finished","data":{"outputs":{"answer":"\\n<think>推理过程</think>\\n最终回答","files":[]}}}\n\n';

// message 事件 + LLM 节点的 node_finished 同时出现：node 事件只能兜底，不能重复拼接。
const MESSAGE_PLUS_NODE_SSE =
  'data: {"event":"message","answer":"你好，"}\n\n' +
  'data: {"event":"message","answer":"世界。"}\n\n' +
  'data: {"event":"node_finished","data":{"outputs":{"text":"你好，世界。"},' +
  '"process_data":{"messages":[{"role":"assistant","content":"你好，世界。"}]}}}\n\n' +
  'data: {"event":"workflow_finished","data":{"outputs":{"answer":"你好，世界。","files":[]}}}\n\n';

// 内容审查：message_replace 用一整段新文本替换已输出内容。
const MESSAGE_REPLACE_SSE =
  'data: {"event":"message","answer":"原始回答"}\n\n' +
  'data: {"event":"message_replace","answer":"内容已被替换"}\n\n' +
  'data: {"event":"message_end"}\n\n';

// SSE 里的 error 事件。
const ERROR_EVENT_SSE =
  'data: {"event":"message","answer":"部分"}\n\n' +
  'data: {"event":"error","status":500,"code":"completion_request_error","message":"模型调用失败"}\n\n';

// Workflow 的 text_chunk 流。
const WORKFLOW_SSE =
  'data: {"event":"text_chunk","data":{"text":"Hello "}}\n\n' +
  'data: {"event":"text_chunk","data":{"text":"流式 "}}\n\n' +
  'data: {"event":"text_chunk","data":{"text":"world!"}}\n\n' +
  'data: {"event":"workflow_finished","data":{"outputs":{"text":"Hello 流式 world!"}}}\n\n';

// 分离式 reasoning_content（chatflow）：推理走独立字段。
const REASONING_SSE =
  'data: {"event":"message","reasoning_content":"先分析问题，"}\n\n' +
  'data: {"event":"message","reasoning_content":"再组织语言。"}\n\n' +
  'data: {"event":"message","answer":"这是最终回答。"}\n\n' +
  'data: {"event":"message_end"}\n\n';

// ---------------------------------------------------------------------------
// 真实线上样本：用户 Dify 后台日志里的长回答（answer 以 "\n<think>" 开头）
// ---------------------------------------------------------------------------

const REAL_THINK = '\n' + [
  'The user is making a profound statement about the iPhone Duo.',
  'Let me analyze this from multiple dimensions:',
  '1. **产品维度** - 折叠屏的工程取舍',
  '2. **品牌文化维度** - 乔布斯的遗产',
  '3. **战略维度** - 苹果在折叠市场的定位',
  'I should structure a comprehensive response with headers and blockquotes.'
].join('\n') + '\n';

const REAL_BODY = '\n\n# iPhone Duo：当一款产品成为一份答卷\n\n' + [
  '这句话之所以动人，是因为它把一个商业产品拔高到了一个**哲学命题**的高度。',
  '',
  '## 一、首先是那个"迟到"的答案',
  '',
  '> 苹果花了 15 年证明折叠屏能造，又花了 5 年说服自己折叠屏得造。',
  '',
  '| 技术选择 | 体现的理念 |',
  '|---------|----------|',
  '| 纳米纹理玻璃处理折痕 | 追求视觉上的不可见 |',
  '| 取消 Face ID 回归 Touch ID | 服从于折叠形态的物理逻辑 |',
  '',
  '## 结语',
  '',
  '这场答案，才刚刚开始写。'
].join('\n');

const REAL_ANSWER = '\n' + '<think>' + REAL_THINK + '</think>' + REAL_BODY;

/** 把一整段 answer 按 token 粒度（默认 6 字符）切成 message 事件流。 */
function buildMessageSse(answer, tokenSize = 6) {
  let sse = '';
  for (let i = 0; i < answer.length; i += tokenSize) {
    sse += `data: ${JSON.stringify({ event: 'message', answer: answer.slice(i, i + tokenSize) })}\n\n`;
  }
  sse += 'data: {"event":"workflow_finished","data":' +
    JSON.stringify({ outputs: { answer: answer, files: [] } }) + '}\n\n';
  sse += 'data: {"event":"message_end"}\n\n';
  return sse;
}

const REAL_SSE = buildMessageSse(REAL_ANSWER);

// ---------------------------------------------------------------------------
// 用例表
// ---------------------------------------------------------------------------

const CASES = [
  // --- 跨网络分片丢行（v0.7.1 的回归保护） ---
  { name: '合并<think> · chunk=9999', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 9999, expectTarget: MERGED_THINK_TARGET, expectReasoning: MERGED_THINK_REASONING },
  { name: '合并<think> · chunk=32', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 32, expectTarget: MERGED_THINK_TARGET, expectReasoning: MERGED_THINK_REASONING },
  { name: '合并<think> · chunk=8', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 8, expectTarget: MERGED_THINK_TARGET, expectReasoning: MERGED_THINK_REASONING },
  { name: '合并<think> · chunk=1', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 1, expectTarget: MERGED_THINK_TARGET, expectReasoning: MERGED_THINK_REASONING },
  { name: 'CRLF合并<think> · chunk=16', option: CHATFLOW, sse: MERGED_THINK_CRLF, chunkSize: 16, expectTarget: MERGED_THINK_TARGET, expectReasoning: MERGED_THINK_REASONING },
  { name: 'CRLF合并<think> · chunk=4', option: CHATFLOW, sse: MERGED_THINK_CRLF, chunkSize: 4, expectTarget: MERGED_THINK_TARGET, expectReasoning: MERGED_THINK_REASONING },

  // --- 「插件未返回有效结果」（v0.8.0 的核心修复） ---
  { name: '真实长回答（思考在前）· chunk=64', option: CHATFLOW, sse: REAL_SSE, chunkSize: 64, expectTarget: '\n' + REAL_BODY, expectReasoning: REAL_THINK },
  { name: '真实长回答（思考在前）· chunk=3', option: CHATFLOW, sse: REAL_SSE, chunkSize: 3, expectTarget: '\n' + REAL_BODY, expectReasoning: REAL_THINK },
  { name: '标签跨 SSE 事件被切开', option: CHATFLOW, sse: SPLIT_TAG_SSE, chunkSize: 7, expectTarget: '最终答案', expectReasoning: '先想一下' },
  { name: '<think> 未闭合 → 退化展示思考内容', option: CHATFLOW, sse: UNCLOSED_THINK_SSE, chunkSize: 11, expectTarget: '\n我正在推理，然后被截断了' },
  { name: '仅 workflow_finished 兜底', option: CHATFLOW, sse: ONLY_WORKFLOW_FINISHED_SSE, chunkSize: 13, expectTarget: '\n\n最终回答', expectReasoning: '推理过程' },
  { name: 'message + node_finished 不重复拼接', option: CHATFLOW, sse: MESSAGE_PLUS_NODE_SSE, chunkSize: 17, expectTarget: '你好，世界。' },
  { name: 'message_replace 整段替换', option: CHATFLOW, sse: MESSAGE_REPLACE_SSE, chunkSize: 9, expectTarget: '内容已被替换', allowRewrite: true },

  // --- 回调时序：无论 Bob 走哪条路，onCompletion 都必须恰好一次 ---
  { name: '仅 handler 回调', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 16, transport: 'handlerOnly', expectTarget: MERGED_THINK_TARGET },
  { name: '仅 Promise resolve（handler 从不触发）', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 16, transport: 'promiseOnly', expectTarget: MERGED_THINK_TARGET },
  { name: 'handler + Promise 双触发（去重）', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 16, transport: 'both', expectTarget: MERGED_THINK_TARGET },

  // --- 错误路径 ---
  { name: '请求抛错', option: CHATFLOW, transport: 'throw', expectErrorLike: '模拟网络中断' },
  { name: 'result.error 且没有 response 字段', option: CHATFLOW, sse: '', httpResult: { error: { localizedDescription: '连接被拒绝' } }, expectErrorLike: '连接被拒绝' },
  { name: 'HTTP 401', option: CHATFLOW, sse: '', httpResult: { response: { statusCode: 401 }, data: { message: 'invalid token' } }, expectErrorLike: 'invalid token' },
  { name: 'HTTP 500', option: CHATFLOW, sse: '', httpResult: { response: { statusCode: 500 }, data: { message: 'internal' } }, expectErrorLike: 'internal' },
  { name: 'SSE error 事件', option: CHATFLOW, sse: ERROR_EVENT_SSE, chunkSize: 20, expectErrorLike: '模型调用失败' },

  // --- Workflow 模式 ---
  { name: 'Workflow text_chunk · chunk=8', option: WORKFLOW, sse: WORKFLOW_SSE, chunkSize: 8, expectTarget: 'Hello 流式 world!' },

  // --- 分离式 reasoning_content ---
  { name: '分离式 reasoning · chunk=8', option: CHATFLOW, sse: REASONING_SSE, chunkSize: 8, expectTarget: '这是最终回答。', expectReasoning: '先分析问题，再组织语言。' },
];

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

(async () => {
  console.log(`被测模块：${modulePath}\n`);
  let passed = 0;
  for (const c of CASES) {
    let ok = true;
    let detail = '';
    try {
      const outcome = await runCase(c);
      checkCase(c, outcome);
    } catch (error) {
      ok = false;
      detail = (error && error.message) || String(error);
    }
    if (ok) passed++;
    console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${c.name}${ok ? '' : '\n         → ' + detail}`);
  }
  const total = CASES.length;
  console.log(`\n结果：${passed}/${total} 通过${passed === total ? '' : `，${total - passed} 失败`}`);
  process.exitCode = passed === total ? 0 : 1;
})();
