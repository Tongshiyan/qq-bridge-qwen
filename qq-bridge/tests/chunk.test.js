/**
 * 纯函数单测：输出分段
 *
 * 分段最容易出的两类问题：
 *   1. 丢内容（用户看到的比实际结果少）
 *   2. 把代码块切成两半（可读性崩坏）
 * 因此这里除了常规断言，还做了"重建校验"：把所有分段的非围栏内容
 * 拼回去，必须能还原出原文的全部行。
 *
 * 用法: bin\node.cmd tests\chunk.test.js
 */

import assert from 'node:assert/strict';
import { chunkText, withParts, summarizeForChat, safeFileName, shouldSendAsFile } from '../src/output/chunk.js';

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
    console.log(`    ${e.message}`);
  }
}

/** 去掉纯围栏行与序号前缀，得到参与比较的内容行。 */
function contentLines(s) {
  return s
    .split('\n')
    .filter((l) => l.trim() !== '```')
    .map((l) => l.replace(/^\(\d+\/\d+\)$/, ''))
    .filter((l) => l.trim() !== '');
}

console.log('\n=== chunkText 基本行为 ===');

test('空输入返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
});

test('短文本不切分', () => {
  assert.deepEqual(chunkText('hello', 100), ['hello']);
});

test('恰好等于上限时不切分', () => {
  const s = 'a'.repeat(100);
  assert.deepEqual(chunkText(s, 100), [s]);
});

test('每段都不超过上限', () => {
  const s = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const chunks = chunkText(s, 300);
  assert.ok(chunks.length > 1, '应当被切成多段');
  for (const c of chunks) {
    assert.ok(c.length <= 300, `存在超限片段: ${c.length} > 300`);
  }
});

test('无内容丢失（重建校验）', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `第 ${i} 行内容 content-${i}`);
  const s = lines.join('\n');
  const chunks = chunkText(s, 400);
  const rebuilt = chunks.flatMap(contentLines);
  for (const line of lines) {
    assert.ok(rebuilt.includes(line), `丢失了行: ${line}`);
  }
});

console.log('\n=== 代码块处理 ===');

test('每个分段内围栏成对（不出现半截代码块）', () => {
  const code = Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i};`).join('\n');
  const s = `这是说明\n\n\`\`\`js\n${code}\n\`\`\`\n\n结束语`;
  const chunks = chunkText(s, 400);
  assert.ok(chunks.length > 1, '样本应产生多段');
  for (const [i, c] of chunks.entries()) {
    const n = (c.match(/```/g) ?? []).length;
    assert.equal(n % 2, 0, `第 ${i + 1} 段围栏数为奇数 (${n})：\n${c.slice(0, 200)}`);
  }
});

test('被拆开的代码块会在新段重开围栏', () => {
  const code = 'x'.repeat(50);
  const s = '```\n' + Array.from({ length: 40 }, () => code).join('\n') + '\n```';
  const chunks = chunkText(s, 300);
  assert.ok(chunks.length > 1);
  // 除最后一段外，其余段都应以闭合围栏结束（因为它们是从代码块中断开的）
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.ok(
      chunks[i].trimEnd().endsWith('```'),
      `第 ${i + 1} 段未以围栏收尾:\n${chunks[i].slice(-100)}`
    );
  }
});

test('代码块内容的每一行都保留', () => {
  const codeLines = Array.from({ length: 80 }, (_, i) => `line_${i} = ${i}`);
  const s = '```\n' + codeLines.join('\n') + '\n```';
  const chunks = chunkText(s, 250);
  const rebuilt = chunks.flatMap(contentLines);
  for (const l of codeLines) {
    assert.ok(rebuilt.includes(l), `代码行丢失: ${l}`);
  }
});

console.log('\n=== 极端输入 ===');

test('单行超长时被硬切且不丢失', () => {
  const s = 'A'.repeat(1000);
  const chunks = chunkText(s, 100);
  assert.ok(chunks.length >= 10);
  const joined = chunks.join('');
  assert.equal(joined.length, 1000, '硬切后总长度应守恒');
  assert.equal(joined, s, '硬切内容应完整且有序');
});

test('超长单行中含中文不破坏字符', () => {
  const s = '中'.repeat(500);
  const chunks = chunkText(s, 60);
  const joined = chunks.join('');
  assert.equal(joined, s);
});

test('全空白输入返回空数组', () => {
  assert.deepEqual(chunkText('   \n\n  \n'), []);
});

test('不抛异常（各种畸形输入）', () => {
  assert.doesNotThrow(() => chunkText('```\n未闭合'));
  assert.doesNotThrow(() => chunkText('\n\n\n'));
  assert.doesNotThrow(() => chunkText('```'));
  assert.doesNotThrow(() => chunkText('a', 0));
  assert.doesNotThrow(() => chunkText('a', -1));
});

console.log('\n=== withParts ===');

test('单段不加序号', () => {
  assert.deepEqual(withParts(['only']), ['only']);
});

test('多段加 (n/N) 前缀', () => {
  const r = withParts(['a', 'b', 'c']);
  assert.equal(r[0], '(1/3)\na');
  assert.equal(r[2], '(3/3)\nc');
});

console.log('\n=== 摘要与文件名 ===');

test('summarizeForChat 保留头部并说明省略行数', () => {
  const s = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
  const out = summarizeForChat(s, 10);
  assert.ok(out.includes('l0'));
  assert.ok(out.includes('l9'));
  assert.ok(!out.includes('l20'), '超出头部的行不应出现');
  assert.match(out, /40 行/);
});

test('短文本摘要原样返回', () => {
  assert.equal(summarizeForChat('a\nb', 10), 'a\nb');
});

test('safeFileName 替换 Windows 非法字符', () => {
  const n = safeFileName('a<b>c:d/e\\f|g?h*i');
  assert.ok(!/[<>:"/\\|?*]/.test(n), `仍含非法字符: ${n}`);
  assert.ok(n.endsWith('.txt'));
});

test('safeFileName 处理空串与超长输入', () => {
  assert.ok(safeFileName('').endsWith('.txt'));
  assert.ok(safeFileName(null).endsWith('.txt'));
  assert.ok(safeFileName('x'.repeat(500)).length <= 70);
});

test('shouldSendAsFile 按阈值判定', () => {
  assert.equal(shouldSendAsFile('short', { fileThresholdChars: 10 }), false);
  assert.equal(shouldSendAsFile('x'.repeat(11), { fileThresholdChars: 10 }), true);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
