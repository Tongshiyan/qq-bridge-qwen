/**
 * 结果落盘与文件直发单测
 *
 * 关注点：
 *   - 落盘内容必须原样往返（不能悄悄改字节）
 *   - 文件直发失败时必须降级为摘要+路径，绝不能把用户的结果弄丢
 *   - 任何异常都不得向调用方传播（这是回复路径，抛异常=用户收不到结果）
 *   - 100MB 平台上限的守卫必须真实生效，且不能"总是跳过"
 *
 * 用法: bin\node.cmd tests\artifacts.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveArtifact, sendArtifact, probeFileSize, MAX_FILE_BYTES,
  wantsFileDelivery, extractSendablePath, sendExistingFile,
} from '../src/output/artifacts.js';
import { summarizeForChat } from '../src/output/chunk.js';

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

const sandbox = mkdtempSync(join(tmpdir(), 'artifact-test-'));
let seq = 0;
const freshDir = () => join(sandbox, `d${++seq}`);

/** 造一个假 bot，可控制 sendFile / sendText 的成功与失败。 */
function fakeBot({ fileFails = false, textFails = false } = {}) {
  const calls = { file: [], text: [] };
  return {
    calls,
    async sendFile(target, source, opts) {
      calls.file.push({ target, source, opts });
      if (fileFails) throw new Error('11244 no permission to send file message');
      return { upload: {}, message: {} };
    },
    async sendText(target, text) {
      calls.text.push({ target, text });
      if (textFails) throw new Error('被动回复窗口已过');
      return {};
    },
  };
}

function makeCtx(overrides = {}) {
  const bot = overrides.bot ?? fakeBot();
  return {
    ctx: {
      bot,
      target: { scope: 'c2c', targetId: 'user-1', msgId: 'm1' },
      sendText: async (text) => { bot.calls.text.push({ viaBridge: true, text }); },
      dir: freshDir(),
      thresholdChars: 200,
      sendFileWhenLarge: true,
      summarize: summarizeForChat,
      log: () => {},
      ...overrides,
    },
    bot,
  };
}

console.log('\n=== saveArtifact ===');

await test('写盘成功且内容原样往返', async () => {
  const dir = freshDir();
  const text = '第一行\n第二行 with ASCII\n第三行 🎉';
  const r = saveArtifact(text, '分析日志', { dir });
  assert.ok(r, '应返回结果');
  assert.ok(existsSync(r.path), '文件应存在');
  assert.equal(readFileSync(r.path, 'utf8'), text, '内容必须完全一致');
  assert.ok(r.bytes > 0);
  assert.ok(r.fileName.endsWith('.txt'));
});

await test('目录不存在时自动创建', async () => {
  const dir = join(freshDir(), 'nested', 'deep');
  const r = saveArtifact('x', '任务', { dir });
  assert.ok(r && existsSync(r.path));
});

await test('Windows 非法字符被替换', async () => {
  const r = saveArtifact('x', 'a<b>c:d/e\\f|g?h*i', { dir: freshDir() });
  assert.ok(r, '应成功');
  assert.ok(!/[<>:"/\\|?*]/.test(r.fileName), `文件名含非法字符: ${r.fileName}`);
  assert.ok(existsSync(r.path), '含非法字符的任务名不应导致落盘失败');
});

await test('同一任务名连续落盘不互相覆盖', async () => {
  const dir = freshDir();
  const paths = [];
  for (let i = 0; i < 5; i++) {
    const r = saveArtifact(`内容 ${i}`, '同一个任务', { dir });
    paths.push(r.path);
  }
  assert.equal(new Set(paths).size, 5, `5 次落盘应产生 5 个不同文件，实得 ${new Set(paths).size}`);
  // 内容也必须各自正确
  for (let i = 0; i < 5; i++) {
    assert.equal(readFileSync(paths[i], 'utf8'), `内容 ${i}`);
  }
});

await test('空文本可落盘', async () => {
  const r = saveArtifact('', '空任务', { dir: freshDir() });
  assert.ok(r, '空文本也应能落盘');
  assert.equal(readFileSync(r.path, 'utf8'), '');
});

await test('dir 无效时返回 null 而不抛异常', async () => {
  let r;
  assert.doesNotThrow(() => { r = saveArtifact('x', 'y', { dir: '\0invalid' }); });
  assert.equal(r, null);
});

await test('opts 缺失时返回 null 而不抛异常', async () => {
  assert.doesNotThrow(() => saveArtifact('x', 'y'));
  assert.doesNotThrow(() => saveArtifact('x', 'y', {}));
});

console.log('\n=== probeFileSize ===');

await test('已存在文件返回真实大小', async () => {
  const r = saveArtifact('0123456789', 'size', { dir: freshDir() });
  assert.equal(probeFileSize(r.path), 10);
});

await test('不存在的文件返回 -1', async () => {
  assert.equal(probeFileSize(join(sandbox, 'nope-does-not-exist.txt')), -1);
});

await test('畸形路径返回 -1 而不抛异常', async () => {
  assert.doesNotThrow(() => probeFileSize(null));
  assert.doesNotThrow(() => probeFileSize(''));
  assert.equal(probeFileSize(null), -1);
});

console.log('\n=== sendArtifact：正常路径 ===');

await test('低于阈值直接发原文，不落盘', async () => {
  const dir = freshDir();
  const { ctx, bot } = makeCtx({ dir, thresholdChars: 1000 });
  const r = await sendArtifact('短结果', '任务', ctx);
  assert.equal(r.delivered, 'text');
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, '不应产生文件');
  assert.ok(bot.calls.text.some((c) => c.text === '短结果'));
});

await test('超过阈值且 sendFile 成功 → delivered: file', async () => {
  const { ctx, bot } = makeCtx({ thresholdChars: 200 });
  const long = 'x'.repeat(5000);
  const r = await sendArtifact(long, '长任务', ctx);
  assert.equal(r.delivered, 'file', JSON.stringify(r));
  assert.equal(bot.calls.file.length, 1, '应调用一次 sendFile');
  assert.ok(r.path && existsSync(r.path), '文件应已落盘');
});

await test('文件落盘内容与原文一致（不丢内容）', async () => {
  const { ctx } = makeCtx({ thresholdChars: 200 });
  const long = `开头\n${'y'.repeat(5000)}\n结尾标记`;
  const r = await sendArtifact(long, '任务', ctx);
  assert.equal(readFileSync(r.path, 'utf8'), long);
});

console.log('\n=== sendArtifact：降级路径（关键）===');

await test('sendFile 被拒 → 降级为摘要+路径，不抛异常', async () => {
  const bot = fakeBot({ fileFails: true });
  const { ctx } = makeCtx({ bot, thresholdChars: 200 });
  const long = 'x'.repeat(5000);

  let r;
  await assert.doesNotReject(async () => { r = await sendArtifact(long, '长任务', ctx); });

  assert.equal(r.delivered, 'summary', `应降级，实得 ${r.delivered}`);
  assert.ok(r.reason, '应说明降级原因');
  assert.ok(r.path, '仍应保留落盘路径');
  assert.ok(bot.calls.text.length > 0, '应通过文本推送结果');
  const joined = bot.calls.text.map((c) => c.text).join('\n');
  assert.ok(joined.includes(r.path), '回退文本应包含文件路径');
});

await test('降级原因出现在首条消息里（不能被摘要挤到后面）', async () => {
  const bot = fakeBot({ fileFails: true });
  const { ctx } = makeCtx({ bot, thresholdChars: 200 });
  // 单行长文本，会让摘要占据多条消息
  const r = await sendArtifact('z'.repeat(9000), '任务', ctx);
  assert.equal(r.delivered, 'summary');
  const first = bot.calls.text[0]?.text ?? '';
  assert.match(first, /未作为文件发送|无法/, `首条消息应说明降级原因，实际: ${first.slice(0, 120)}`);
});

await test('bot 不可用 → 不抛异常，仍落盘', async () => {
  const { ctx } = makeCtx({ bot: undefined, thresholdChars: 200 });
  let r;
  await assert.doesNotReject(async () => { r = await sendArtifact('x'.repeat(5000), '任务', ctx); });
  assert.ok(r, '应返回结果对象');
  assert.ok(r.path && existsSync(r.path), '仍应落盘');
});

await test('落盘失败 → 不抛异常，尽力以文本送达', async () => {
  const bot = fakeBot();
  const { ctx } = makeCtx({ bot, dir: '\0invalid', thresholdChars: 10 });
  let r;
  await assert.doesNotReject(async () => { r = await sendArtifact('x'.repeat(500), '任务', ctx); });
  assert.ok(r, '应返回结果对象');
  assert.equal(r.path, null);
});

await test('sendText 也失败 → 仍不抛异常', async () => {
  const bot = fakeBot({ fileFails: true, textFails: true });
  const { ctx } = makeCtx({ bot, thresholdChars: 200, sendText: async () => { throw new Error('窗口已过'); } });
  await assert.doesNotReject(async () => { await sendArtifact('x'.repeat(5000), '任务', ctx); });
});

console.log('\n=== sendArtifact：配置与守卫 ===');

await test('sendFileWhenLarge=false → 不调用 sendFile', async () => {
  const { ctx, bot } = makeCtx({ thresholdChars: 200, sendFileWhenLarge: false });
  const r = await sendArtifact('x'.repeat(5000), '任务', ctx);
  assert.equal(bot.calls.file.length, 0, '不应尝试文件发送');
  assert.notEqual(r.delivered, 'file');
});

await test('超过平台上限的文件不作为文件发送', async () => {
  // 不真的写 100MB：注入更小的上限，驱动同一段比较逻辑
  const bot = fakeBot();
  const { ctx } = makeCtx({ bot, thresholdChars: 10, maxFileBytes: 10_000 });
  const r = await sendArtifact('x'.repeat(40_000), '超大任务', ctx);
  assert.equal(bot.calls.file.length, 0, '超限不应尝试 sendFile');
  assert.notEqual(r.delivered, 'file');
});

await test('上限守卫不是「总是跳过」：低于上限时仍会发送', async () => {
  const bot = fakeBot();
  const { ctx } = makeCtx({ bot, thresholdChars: 10, maxFileBytes: 10_000 });
  const r = await sendArtifact('x'.repeat(5_000), '正常任务', ctx);
  assert.equal(bot.calls.file.length, 1, '低于上限应正常尝试发送');
  assert.equal(r.delivered, 'file');
});

await test('MAX_FILE_BYTES 为平台文档所述的 100MB', () => {
  assert.equal(MAX_FILE_BYTES, 100 * 1024 * 1024);
});

console.log('\n=== sendArtifact：健壮性 ===');

await test('ctx 缺失 / 文本畸形均不抛异常', async () => {
  await assert.doesNotReject(async () => { await sendArtifact('x', 'y', undefined); });
  await assert.doesNotReject(async () => { await sendArtifact(null, 'y', makeCtx().ctx); });
  await assert.doesNotReject(async () => { await sendArtifact(undefined, 'y', makeCtx().ctx); });
  await assert.doesNotReject(async () => { await sendArtifact('', '', makeCtx().ctx); });
});

await test('没有 summarize 时仍能给出回退文本', async () => {
  const bot = fakeBot({ fileFails: true });
  const { ctx } = makeCtx({ bot, thresholdChars: 100, summarize: undefined });
  await assert.doesNotReject(async () => { await sendArtifact('x'.repeat(3000), '任务', ctx); });
});

console.log('\n=== wantsFileDelivery（真实设计错误）===');

// 背景：真实场景「把桌面的简历发给我」——
// agent 没有投递通道，改把 PDF 全文提取成文字（1295 字符 < 阈值 6000），
// 于是桥接按文本发走，用户要文件却收到一堆文字。
// 正确的触发条件是"用户要文件"，与结果长短无关。

test('真实触发语句都能识别', () => {
  const yes = [
    '帮我吧桌面的个人简历发给我',
    '把桌面的简历发给我',
    '把那个 PDF 发我',
    '传给我',
    '给我发一下桌面的截图',
    '打包发给我',
    'send me the resume',
    'send it to me',
    'attach the file',
  ];
  for (const t of yes) {
    assert.equal(wantsFileDelivery(t), true, `应识别为要文件: ${t}`);
  }
});

test('只是要结论/分析的语句不应误判', () => {
  const no = [
    '帮我看看 D 盘剩余空间',
    '分析一下这个日志',
    '桌面上有哪些文件',
    '统计代码行数',
    '解释一下这段代码',
    '',
    null,
    undefined,
  ];
  for (const t of no) {
    assert.equal(wantsFileDelivery(t), false, `不应判为要文件: ${JSON.stringify(t)}`);
  }
});

console.log('\n=== extractSendablePath（不可信输入）===');

const EXISTS = (p) => [
  'C:\\Users\\<your-username>\\Desktop\\个人简历-工作.pdf',
  'C:\\tmp\\report.docx',
].includes(p);

test('优先识别显式 SEND_FILE 标记', () => {
  const text = '找到了，这就发。\nSEND_FILE: C:\\Users\\<your-username>\\Desktop\\个人简历-工作.pdf';
  assert.equal(extractSendablePath(text, EXISTS), 'C:\\Users\\<your-username>\\Desktop\\个人简历-工作.pdf');
});

test('SEND_FILE 支持反引号包裹', () => {
  const text = 'SEND_FILE: `C:\\tmp\\report.docx`';
  assert.equal(extractSendablePath(text, EXISTS), 'C:\\tmp\\report.docx');
});

test('SEND_FILE 标记指向不存在的文件时不采信', () => {
  const text = 'SEND_FILE: C:\\nope\\ghost.pdf';
  assert.equal(extractSendablePath(text, EXISTS), null, '不能把虚构路径当文件发出去');
});

test('无标记时从正文里兜底提取真实存在的绝对路径', () => {
  const text = '桌面上只有一份：`C:\\Users\\<your-username>\\Desktop\\个人简历-工作.pdf`（351 KB）';
  assert.equal(extractSendablePath(text, EXISTS), 'C:\\Users\\<your-username>\\Desktop\\个人简历-工作.pdf');
});

test('兜底提取遇到的多个路径中取真实存在的一个', () => {
  const text = '参考 C:\\fake\\a.pdf，实际是 C:\\tmp\\report.docx';
  assert.equal(extractSendablePath(text, EXISTS), 'C:\\tmp\\report.docx');
});

test('没有任何路径时返回 null', () => {
  assert.equal(extractSendablePath('我没有文件可以给你', EXISTS), null);
  assert.equal(extractSendablePath('', EXISTS), null);
  assert.equal(extractSendablePath(null, EXISTS), null);
});

test('不把相对路径或非文件扩展名当路径', () => {
  assert.equal(extractSendablePath('文件在 .\\Desktop\\a.pdf', EXISTS), null, '相对路径不采信');
  assert.equal(extractSendablePath('见 C:\\Windows\\system32\\cmd.exe', () => true), null,
    '.exe 不在可投递扩展名白名单内');
});

test('畸形输入不崩溃', () => {
  for (const v of [null, undefined, '', 123, {}, []]) {
    assert.doesNotThrow(() => extractSendablePath(v, EXISTS));
  }
  assert.equal(extractSendablePath(null, EXISTS), null);
});

console.log('\n=== sendExistingFile ===');

await test('成功时返回 ok', async () => {
  const calls = [];
  const bot = { sendFile: async (t, src, opts) => { calls.push({ t, src, opts }); } };
  const r = await sendExistingFile(bot, { targetId: 'u1' }, 'C:\\x\\a.pdf', { content: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].src.localPath, 'C:\\x\\a.pdf');
});

await test('sendFile 抛错时返回原因而不抛', async () => {
  const bot = { sendFile: async () => { throw new Error('11244 no permission'); } };
  let r;
  await assert.doesNotReject(async () => { r = await sendExistingFile(bot, { targetId: 'u1' }, 'C:\\x\\a.pdf'); });
  assert.equal(r.ok, false);
  assert.match(r.reason, /11244/);
});

await test('bot 不可用 / 缺目标时明确失败', async () => {
  assert.equal((await sendExistingFile(null, { targetId: 'u1' }, 'C:\\x')).ok, false);
  assert.equal((await sendExistingFile({}, { targetId: 'u1' }, 'C:\\x')).ok, false);
  assert.equal((await sendExistingFile({ sendFile: async () => {} }, null, 'C:\\x')).ok, false);
  assert.equal((await sendExistingFile({ sendFile: async () => {} }, {}, 'C:\\x')).ok, false);
});

console.log('\n=== 收尾 ===');

await test('清理临时目录', async () => {
  rmSync(sandbox, { recursive: true, force: true });
  assert.ok(!existsSync(sandbox));
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
