/**
 * 关思考代理单测
 *
 * 关注点：
 *   1. 改写只动 chat_template_kwargs.enable_thinking，其它字段一字不改；
 *   2. 只对 POST /chat/completions 改写，别的请求原样转发；
 *   3. 真起一个代理 + 假上游，验证"注入的内容确实到了上游、响应原样回来"。
 *
 * 用法: bin\node.cmd tests/proxy.test.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { withThinkingOff, shouldRewrite, createThinkingOffProxy } from '../src/proxy/thinking-off.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message.split('\n')[0]}`);
  }
}

console.log('\n=== 改写（纯函数） ===');

await test('注入 enable_thinking=false，其它字段保持不变', () => {
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 10 });
  const out = JSON.parse(withThinkingOff(body));
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false });
  assert.equal(out.model, 'm');
  assert.equal(out.max_completion_tokens, 10);
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
});

await test('已有 chat_template_kwargs 不会被覆盖，只补一项', () => {
  const body = JSON.stringify({ chat_template_kwargs: { foo: 1 } });
  const out = JSON.parse(withThinkingOff(body));
  assert.deepEqual(out.chat_template_kwargs, { foo: 1, enable_thinking: false });
});

await test('非法 JSON / 非对象原样返回（不猜）', () => {
  assert.equal(withThinkingOff('not json'), 'not json');
  assert.equal(withThinkingOff('[1,2]'), '[1,2]');
  assert.equal(withThinkingOff('"str"'), '"str"');
});

await test('可自定义 kwarg 名与值', () => {
  const out = JSON.parse(withThinkingOff('{}', { kwargName: 'thinking_budget', value: 0 }));
  assert.deepEqual(out.chat_template_kwargs, { thinking_budget: 0 });
});

await test('只改写 chat/completions 的 POST', () => {
  assert.equal(shouldRewrite('POST', '/v1/chat/completions'), true);
  assert.equal(shouldRewrite('post', '/v1/chat/completions?x=1'), true);
  assert.equal(shouldRewrite('GET', '/v1/chat/completions'), false);
  assert.equal(shouldRewrite('POST', '/v1/models'), false);
  assert.equal(shouldRewrite('POST', '/v1/embeddings'), false);
});

console.log('\n=== 端到端（代理 → 假上游） ===');

await test('代理注入参数并原样回传响应', async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, got: seen.chat_template_kwargs }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const proxy = createThinkingOffProxy({
    listenPort: 0,
    upstreamBase: `http://127.0.0.1:${upPort}`,
    log: () => {},
  });
  await new Promise((r) => proxy.once('listening', r));
  const pxPort = proxy.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${pxPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(seen.chat_template_kwargs, { enable_thinking: false }, '上游收到的必须是关思考后的请求');
    assert.deepEqual(j.got, { enable_thinking: false });

    // 非 chat 路径不应被注入
    seen = null;
    await fetch(`http://127.0.0.1:${pxPort}/v1/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'x' }),
    });
    assert.equal(seen.chat_template_kwargs, undefined, '别的路径不该被动');
  } finally {
    proxy.close();
    upstream.close();
  }
});

await test('上游不可用时返回 502 而不是挂住', async () => {
  const proxy = createThinkingOffProxy({ listenPort: 0, upstreamBase: 'http://127.0.0.1:1', log: () => {} });
  await new Promise((r) => proxy.once('listening', r));
  const pxPort = proxy.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${pxPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }),
    });
    assert.equal(res.status, 502);
  } finally {
    proxy.close();
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
