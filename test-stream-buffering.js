/**
 * 回归脚本：复现并验证「Dify SSE 流式跨网络分片丢行」修复。
 *
 * 思路：把同一条 Dify SSE 流按不同「箱子大小」（字节）喂进 main.js 的
 * 流式解析。网络分片的边界由网络栈决定、与 SSE 换行无关，因此小箱子会把
 * 一条 `data:` 行切成两半。修复前半行会被静默丢弃（尤其丢掉 `</think>`
 * 那一行，导致合并式思考标签未闭合）；修复后按「完整行」缓冲解析，全部通过。
 *
 * 用法：
 *   node test-stream-buffering.js            # 测当前目录 ./main.js（修复后）
 *   node test-stream-buffering.js /path/to/old-main.js   # 对比测旧版
 *
 * 退出码：全部通过为 0，存在失败为 1。
 */

const path = require('path');

const modulePath = path.resolve(process.argv[2] || path.join(__dirname, 'main.js'));

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

/** 运行单个用例：装好 mock 全局，调用 translate，拿到最终 onCompletion 结果。 */
function runCase(c) {
  return new Promise((resolve) => {
    global.$option = Object.assign(
      { apiKey: 'test-key', apiUrl: 'https://example.com/v1/chat-messages' },
      c.option
    );

    let finalResult = null;
    global.$http = {
      streamRequest: async ({ streamHandler, handler }) => {
        feedStream(streamHandler, c.sse, c.chunkSize);
        handler({ response: { statusCode: 200 }, data: {} });
      },
      request: async () => {}
    };

    // 每个用例重新加载模块，避免任何模块级状态污染。
    delete require.cache[require.resolve(modulePath)];
    const { translate } = require(modulePath);

    const query = {
      text: 'hi',
      onStream: () => {},
      onCompletion: (r) => { finalResult = r; },
      cancelSignal: null
    };

    translate(query);
    // translate 内部是 async IIFE；mock 的 streamRequest 同步完成并触发
    // onCompletion，setImmediate 等微任务队列清空后结果必定就绪。
    setImmediate(() => resolve(finalResult));
  });
}

/** 校验单个用例的最终结果是否符合预期。 */
function checkCase(c, result) {
  if (!result || !result.result) {
    return { ok: false, detail: `没有有效结果：${JSON.stringify(result)}` };
  }
  const paragraphs = result.result.toParagraphs || [];
  const got = paragraphs[0];
  if (got !== c.expectTarget) {
    return { ok: false, detail: `正文不匹配，实际=${JSON.stringify(got)}` };
  }
  const think = result.result.thinkInfo || {};
  if (c.expectReasoning != null) {
    if (think.content !== c.expectReasoning) {
      return { ok: false, detail: `reasoning 不匹配，实际=${JSON.stringify(think.content)}` };
    }
  } else if (think.splitThinkTag !== true) {
    return { ok: false, detail: `期望 splitThinkTag=true，实际=${JSON.stringify(think)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

// 合并式 <think>（chatflow）：推理与正文都塞在 answer 里，由 Bob 的
// splitThinkTag 自行拆分。包含 </think> 的那条事件一旦丢失就会泄漏到正文。
const MERGED_THINK_LF =
  'data: {"event":"message","answer":"\\n<think>\\n"}\n\n' +
  'data: {"event":"message","answer":"用户在打招呼，"}\n\n' +
  'data: {"event":"message","answer":"应当礼貌回应。\\n"}\n\n' +
  'data: {"event":"message","answer":"</think>\\n"}\n\n' +
  'data: {"event":"message","answer":"# 回复\\n你好！很高兴见到你。"}\n\n' +
  'data: {"event":"message_end"}\n\n';
const MERGED_THINK_TARGET = '\n<think>\n用户在打招呼，应当礼貌回应。\n</think>\n# 回复\n你好！很高兴见到你。';

// CRLF 变体：把行分隔符换成 \r\n，验证对被代理规范化成 CRLF 的流的兼容。
const MERGED_THINK_CRLF = MERGED_THINK_LF.replace(/\n/g, '\r\n');

// Workflow 的 text_chunk 流。
const WORKFLOW_SSE =
  'data: {"event":"text_chunk","data":{"text":"Hello "}}\n\n' +
  'data: {"event":"text_chunk","data":{"text":"流式 "}}\n\n' +
  'data: {"event":"text_chunk","data":{"text":"world!"}}\n\n' +
  'data: {"event":"workflow_finished","data":{"outputs":{"text":"Hello 流式 world!"}}}\n\n';
const WORKFLOW_TARGET = 'Hello 流式 world!';

// 分离式 reasoning_content（chatflow）：推理走独立字段，用 thinkInfo.content 传递。
const REASONING_SSE =
  'data: {"event":"message","reasoning_content":"先分析问题，"}\n\n' +
  'data: {"event":"message","reasoning_content":"再组织语言。"}\n\n' +
  'data: {"event":"message","answer":"这是最终回答。"}\n\n' +
  'data: {"event":"message_end"}\n\n';
const REASONING_TARGET = '这是最终回答。';
const REASONING_THINK = '先分析问题，再组织语言。';

const CHATFLOW = { appType: 'chatflow' };
const WORKFLOW = { appType: 'workflow', inputKey: 'query', apiUrl: 'https://example.com/v1/workflows/run' };

const CASES = [
  // 合并 <think>，从「一个大箱子」到「逐字节」——只有大箱子在旧版能侥幸通过。
  { name: '合并<think> · chunk=9999', option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 9999, expectTarget: MERGED_THINK_TARGET },
  { name: '合并<think> · chunk=32',   option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 32,   expectTarget: MERGED_THINK_TARGET },
  { name: '合并<think> · chunk=16',   option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 16,   expectTarget: MERGED_THINK_TARGET },
  { name: '合并<think> · chunk=8',    option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 8,    expectTarget: MERGED_THINK_TARGET },
  { name: '合并<think> · chunk=4',    option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 4,    expectTarget: MERGED_THINK_TARGET },
  { name: '合并<think> · chunk=2',    option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 2,    expectTarget: MERGED_THINK_TARGET },
  { name: '合并<think> · chunk=1',    option: CHATFLOW, sse: MERGED_THINK_LF, chunkSize: 1,    expectTarget: MERGED_THINK_TARGET },
  // CRLF 换行：旧版即便大箱子也会因行尾 \r 整行解析失败。
  { name: 'CRLF合并<think> · chunk=16', option: CHATFLOW, sse: MERGED_THINK_CRLF, chunkSize: 16, expectTarget: MERGED_THINK_TARGET },
  { name: 'CRLF合并<think> · chunk=4',  option: CHATFLOW, sse: MERGED_THINK_CRLF, chunkSize: 4,  expectTarget: MERGED_THINK_TARGET },
  // Workflow text_chunk（小箱子）。
  { name: 'Workflow text_chunk · chunk=8', option: WORKFLOW, sse: WORKFLOW_SSE, chunkSize: 8, expectTarget: WORKFLOW_TARGET },
  // 分离式 reasoning_content（小箱子）。
  { name: '分离式 reasoning · chunk=8', option: CHATFLOW, sse: REASONING_SSE, chunkSize: 8, expectTarget: REASONING_TARGET, expectReasoning: REASONING_THINK },
];

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

(async () => {
  console.log(`被测模块：${modulePath}\n`);
  let passed = 0;
  for (const c of CASES) {
    const result = await runCase(c);
    const { ok, detail } = checkCase(c, result);
    if (ok) passed++;
    console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${c.name}${ok ? '' : '  → ' + detail}`);
  }
  const total = CASES.length;
  console.log(`\n结果：${passed}/${total} 通过${passed === total ? '' : `，${total - passed} 失败`}`);
  process.exitCode = passed === total ? 0 : 1;
})();
