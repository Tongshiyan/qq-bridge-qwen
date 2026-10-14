/**
 * 长期记忆库单测
 *
 * 关注点：
 *   1. 写入：追加一条带时间戳的 markdown 条目；空内容/超限要拒绝而不是写坏文件。
 *   2. 注入：每次任务开始时把记忆塞进 prompt —— 这是"它记得住"的唯一途径，
 *      所以必须验证**内容真的进去了**，以及超长时保留的是**最新**那一段
 *      （记忆按时间追加，越新越相关）。
 *   3. 绝不抛异常：记忆库读不到/写不进都不能让任务挂掉。
 *
 * 用法: bin\node.cmd tests\memory.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryBank, MEMORY_HEADER } from '../src/memory/index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message.split('\n')[0]}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-'));
const fresh = (opts = {}) => new MemoryBank({ dir: join(root, Math.random().toString(36).slice(2)), ...opts });
const fixedNow = () => new Date(2026, 9, 12, 3, 30); // 2026-10-12 03:30

console.log('\n=== 写入 ===');

test('首次写入会创建目录与带表头的文件', () => {
  const m = fresh();
  assert.equal(m.read(), '', '文件还不存在时应返回空串而不是抛异常');
  const res = m.append('我的项目都在 D:\\work', { at: fixedNow() });
  assert.equal(res.ok, true);
  const raw = readFileSync(m.filePath, 'utf8');
  assert.ok(raw.startsWith('# DSH-QQ 机器人长期记忆'), '应写入表头');
  assert.equal(raw.slice(0, MEMORY_HEADER.length), MEMORY_HEADER);
  assert.match(raw, /## 2026-10-12 03:30/);
  assert.match(raw, /我的项目都在 D:\\work/);
});

test('多条记忆按时间追加，条数正确', () => {
  const m = fresh();
  m.append('第一条', { at: fixedNow() });
  m.append('第二条', { at: fixedNow() });
  const res = m.append('第三条', { at: fixedNow() });
  assert.equal(res.entries, 3);
  const raw = m.read();
  assert.ok(raw.indexOf('第一条') < raw.indexOf('第二条'), '应保持时间顺序');
  assert.ok(raw.indexOf('第二条') < raw.indexOf('第三条'));
});

test('多行内容原样写入', () => {
  const m = fresh();
  m.append('偏好：\n- 发文件直接发\n- 不要贴文字', { at: fixedNow() });
  assert.match(m.read(), /- 发文件直接发/);
});

test('空内容被拒绝（不会写入空条目）', () => {
  const m = fresh();
  assert.equal(m.append('').ok, false);
  assert.equal(m.append('   \n ').reason, 'empty');
  assert.equal(m.read(), '');
});

test('enabled=false 时既不写入也不注入', () => {
  const m = fresh({ enabled: false });
  assert.equal(m.append('x').reason, 'disabled');
  assert.equal(m.injectText(), '');
});

test('文件超过上限时拒绝追加', () => {
  const m = fresh({ maxFileChars: 200 });
  const first = m.append('x'.repeat(100), { at: fixedNow() });
  assert.equal(first.ok, true);
  // 此时文件已超过 200 字符（含表头），后续追加必须被拒
  const second = m.append('y'.repeat(100), { at: fixedNow() });
  assert.equal(second.ok, false);
  assert.ok(['file-too-large', 'would-exceed'].includes(second.reason), `实得 ${second.reason}`);
  assert.ok(!m.read().includes('yyy'), '被拒的内容不得写入');
});

console.log('\n=== 注入 ===');

test('空记忆库不注入任何东西', () => {
  const m = fresh();
  assert.equal(m.injectText(), '');
  m.append('  ', { at: fixedNow() });
  assert.equal(m.injectText(), '');
});

test('注入内容含说明头与实际记忆', () => {
  const m = fresh();
  m.append('我的项目都在 D:\\work', { at: fixedNow() });
  const text = m.injectText();
  assert.match(text, /【长期记忆】/);
  assert.match(text, /我的项目都在 D:\\work/);
});

test('超长时保留最新的一段并标注省略', () => {
  const m = fresh({ maxInjectChars: 120 });
  for (let i = 1; i <= 20; i++) m.append(`记忆条目编号 ${i} ${'x'.repeat(20)}`, { at: fixedNow() });
  const text = m.injectText();
  assert.match(text, /更早的记忆已省略/);
  assert.match(text, /记忆条目编号 20/, '最新的必须留下');
  assert.ok(!text.includes('记忆条目编号 1 '), '最旧的应被截掉');
  assert.ok(text.length <= 400, `注入不应远超上限，实得 ${text.length}`);
});

test('注入不会把 markdown 表头撑成正文重点（截断后仍可读）', () => {
  const m = fresh({ maxInjectChars: 80 });
  m.append('短记忆', { at: fixedNow() });
  const text = m.injectText();
  assert.ok(text.startsWith('【长期记忆】'), '说明头必须在最前面');
});

test('手写前言（第一个 ## 之前）不会被注入', () => {
  const m = fresh();
  m.ensure();
  writeFileSync(m.filePath, [
    '# 我自己的标题',
    '',
    '这段是给人看的说明，不该进 prompt。',
    '',
    '## 2026-10-12 04:00',
    '',
    '我的项目都在 D:\\work',
    '',
  ].join('\n'), 'utf8');
  const text = m.injectText();
  assert.ok(!text.includes('这段是给人看的说明'), '前言不应被注入');
  assert.ok(text.includes('我的项目都在 D:\\work'), '条目应被注入');
});

test('只有前言、没有条目时等于空库（不注入样板文字）', () => {
  const m = fresh();
  m.ensure();
  writeFileSync(m.filePath, '# 只有标题\n\n一些说明文字\n', 'utf8');
  assert.equal(m.injectText(), '');
  assert.equal(m.stats().entries, 0);
});

console.log('\n=== 健壮性 ===');

test('目录不存在/不可写也不抛异常', () => {
  const m = new MemoryBank({ dir: '', file: 'MEMORY.md' });
  assert.equal(m.filePath, null);
  assert.equal(m.read(), '');
  assert.equal(m.injectText(), '');
  assert.equal(m.append('x').reason, 'no-dir');
});

test('文件内容被手工清空后注入为空', () => {
  const m = fresh();
  m.append('一条', { at: fixedNow() });
  writeFileSync(m.filePath, '', 'utf8');
  assert.equal(m.injectText(), '');
});

test('文件被删掉后仍能重新创建', () => {
  const m = fresh();
  m.append('一条', { at: fixedNow() });
  const p = m.filePath;
  rmSync(p);
  const res = m.append('两条', { at: fixedNow() });
  assert.equal(res.ok, true);
  assert.match(readFileSync(p, 'utf8'), /两条/);
});

test('stats 报告条数/大小/路径', () => {
  const m = fresh();
  m.append('甲', { at: fixedNow() });
  m.append('乙', { at: fixedNow() });
  const s = m.stats();
  assert.equal(s.enabled, true);
  assert.equal(s.entries, 2);
  assert.ok(s.chars > 0);
  assert.equal(s.path, m.filePath);
});

test('损坏的目录路径（同名文件占位）不抛异常', () => {
  const dir = join(root, 'as-file');
  mkdirSync(root, { recursive: true });
  writeFileSync(dir, 'not a directory', 'utf8');
  const m = new MemoryBank({ dir });
  const res = m.append('x');
  assert.equal(res.ok, false, '应返回失败而不是抛异常');
});

rmSync(root, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
