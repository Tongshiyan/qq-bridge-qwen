/**
 * 入站图片处理单测（QQ 图片 → 本地文件 → 交给 agent 的 read_image）
 *
 * 关注点：
 *   1. 抽取：只认 image/*，两个来源（attachments / msg_elements）都要覆盖，去重。
 *   2. 下载：成功的落地成文件、失败的不抛异常且带原因；大小上限、超时、HTTP 错误。
 *   3. 任务文本块：把绝对路径写清楚（否则 agent 不知道去看图）。
 *
 * 用法: bin\node.cmd tests\images.test.js
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractImages, downloadImages, formatImageBlock } from '../src/qq/inbound-images.js';
import { composeTaskText } from '../src/dsh/runner.js';

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

const root = mkdtempSync(join(tmpdir(), 'dsh-images-'));
const dir = () => join(root, Math.random().toString(36).slice(2));

/** 造一个假的 fetch，返回给定字节。 */
const fakeFetch = ({ bytes = Buffer.from([1, 2, 3]), status = 200, delayMs = 0, throwErr = null } = {}) =>
  async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (throwErr) throw throwErr;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => bytes,
    };
  };

console.log('\n=== 抽取 ===');

await test('只挑 image/*，忽略文件与语音', () => {
  const imgs = extractImages({
    attachments: [
      { content_type: 'image/png', url: 'https://x/a.png', size: 100 },
      { content_type: 'application/pdf', url: 'https://x/a.pdf' },
      { content_type: 'voice', url: 'https://x/a.silk' },
    ],
  });
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].url, 'https://x/a.png');
  assert.equal(imgs[0].contentType, 'image/png');
});

await test('msg_elements 里的附件也能拿到（引用/富媒体场景）', () => {
  const imgs = extractImages({
    msg_elements: [{ msg_idx: '1', attachments: [{ content_type: 'image/jpeg', url: 'https://x/b.jpg' }] }],
  });
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].url, 'https://x/b.jpg');
});

await test('同一张图重复出现只算一次', () => {
  const one = { content_type: 'image/png', url: 'https://x/same.png' };
  const imgs = extractImages({ attachments: [one], msg_elements: [{ attachments: [one] }] });
  assert.equal(imgs.length, 1);
});

await test('畸形输入不抛异常', () => {
  for (const bad of [null, undefined, {}, 'x', 123, { attachments: 'nope' }, { msg_elements: [null] }]) {
    assert.deepEqual(extractImages(bad), []);
  }
  assert.deepEqual(extractImages({ attachments: [{ content_type: 'image/png' }] }), [], '缺 url 应忽略');
});

console.log('\n=== 下载 ===');

await test('成功落地：文件名安全、内容一致、扩展名按 content_type', async () => {
  const d = dir();
  const bytes = Buffer.from('PNGDATA');
  const res = await downloadImages({
    images: [{ url: 'https://x/a.png', contentType: 'image/png' }],
    dir: d,
    fetchImpl: fakeFetch({ bytes }),
  });
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, true);
  assert.match(res[0].path, /\.png$/);
  assert.ok(res[0].path.startsWith(d), '必须落在指定目录内');
  assert.equal(readFileSync(res[0].path, 'utf8'), 'PNGDATA');
});

await test('HTTP 失败：不抛异常、带原因、不产生文件', async () => {
  const d = dir();
  const res = await downloadImages({
    images: [{ url: 'https://x/a.png', contentType: 'image/png' }],
    dir: d,
    fetchImpl: fakeFetch({ status: 403 }),
  });
  assert.equal(res[0].ok, false);
  assert.match(res[0].reason, /403/);
  assert.ok(!existsSync(res[0].path ?? join(d, 'x')));
});

await test('超过大小上限直接拒绝（不下载）', async () => {
  const d = dir();
  let called = 0;
  const res = await downloadImages({
    images: [{ url: 'https://x/big.png', contentType: 'image/png', size: 999 }],
    dir: d,
    maxBytes: 100,
    fetchImpl: async () => { called++; return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(0) }; },
  });
  assert.equal(res[0].ok, false);
  assert.match(res[0].reason, /too-large/);
  assert.equal(called, 0, '已经超限就不该再去下载');
});

await test('网络异常/超时被吞掉并记录', async () => {
  const d = dir();
  const boom = await downloadImages({
    images: [{ url: 'https://x/a.png', contentType: 'image/png' }],
    dir: d,
    fetchImpl: fakeFetch({ throwErr: new Error('socket hang up') }),
  });
  assert.equal(boom[0].ok, false);
  assert.match(boom[0].reason, /socket hang up/);

  const slow = await downloadImages({
    images: [{ url: 'https://x/a.png', contentType: 'image/png' }],
    dir: d,
    timeoutMs: 1000,
    fetchImpl: async (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(slow[0].ok, false, '超时必须返回失败而不是挂住');
});

await test('多张图部分失败：成功的仍然可用', async () => {
  const d = dir();
  let n = 0;
  const res = await downloadImages({
    images: [
      { url: 'https://x/ok.png', contentType: 'image/png' },
      { url: 'https://x/bad.png', contentType: 'image/png' },
    ],
    dir: d,
    fetchImpl: async () => {
      n++;
      if (n === 1) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('A') };
      return { ok: false, status: 500, arrayBuffer: async () => Buffer.alloc(0) };
    },
  });
  assert.equal(res.filter((r) => r.ok).length, 1);
  assert.equal(res.filter((r) => !r.ok).length, 1);
});

console.log('\n=== 任务文本 ===');

await test('图片块含绝对路径与 read_image 提示', () => {
  const block = formatImageBlock(['C:\\a\\1.png', 'C:\\a\\2.jpg']);
  assert.match(block, /【用户随发来的图片】|【用户随消息发来的图片】/);
  assert.ok(block.includes('C:\\a\\1.png'));
  assert.ok(block.includes('read_image'));
});

await test('没有图片时不产生空块', () => {
  assert.equal(formatImageBlock([]), '');
  assert.equal(formatImageBlock(null), '');
  assert.equal(formatImageBlock(['  ']), '');
});

await test('composeTaskText 把图片块拼进任务文本（且用户原话仍独立成段）', () => {
  const t = composeTaskText('这张图里是什么？', { imagePaths: ['C:\\a\\1.png'] });
  assert.ok(t.includes('C:\\a\\1.png'));
  assert.ok(t.includes('【用户请求】\n这张图里是什么？'));
  assert.ok(t.indexOf('1.png') < t.indexOf('【用户请求】'), '图片信息在请求之前');
});

await test('没有图片时任务文本不变（不影响既有行为）', () => {
  const a = composeTaskText('hi');
  const b = composeTaskText('hi', { imagePaths: [] });
  assert.equal(a, b);
});

rmSync(root, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
