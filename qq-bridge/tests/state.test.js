/**
 * 会话持久化单测
 *
 * 重点验证：
 *   - 能持久化并被新实例读回（进程重启后上下文不丢）
 *   - 原子写入（强杀不留半个文件）
 *   - 损坏文件不能让服务崩掉（降级为空而非抛异常）
 *   - BOM 容忍（PowerShell 常见产物）
 *   - 过期会话被丢弃
 *
 * 📌 待确认令牌的测试已迁移到 `tests/approval.test.js` ——
 *    那部分实现现在唯一存在于 `src/qq/approval.js`。
 *    本文件末尾有一条防回归断言：`state/index.js` 不得再导出重复实现。
 *
 * 用法: bin\node.cmd tests\state.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/state/index.js';
import * as stateModule from '../src/state/index.js';

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

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-bridge-state-'));

console.log('\n=== SessionStore ===');

test('初始为空，get 返回 null', () => {
  const s = new SessionStore(join(sandbox, 's1.json'));
  assert.equal(s.get('user-a'), null);
  assert.equal(s.size(), 0);
});

test('set/get 往返', () => {
  const s = new SessionStore(join(sandbox, 's2.json'));
  s.set('user-a', 'session-123');
  assert.equal(s.get('user-a'), 'session-123');
});

test('持久化后可被新实例读回', () => {
  const p = join(sandbox, 's3.json');
  const s1 = new SessionStore(p);
  s1.set('user-a', 'session-abc');

  const s2 = new SessionStore(p);
  assert.equal(s2.get('user-a'), 'session-abc', '新实例应读到已保存的会话');
});

test('clear 移除单个用户', () => {
  const s = new SessionStore(join(sandbox, 's4.json'));
  s.set('user-a', 'sa');
  s.set('user-b', 'sb');
  s.clear('user-a');
  assert.equal(s.get('user-a'), null);
  assert.equal(s.get('user-b'), 'sb', '不应影响其他用户');
});

test('set(null) 不记录', () => {
  const s = new SessionStore(join(sandbox, 's5.json'));
  s.set('user-a', null);
  assert.equal(s.get('user-a'), null);
});

test('损坏的会话文件不抛异常，且降级为空', () => {
  const p = join(sandbox, 's6.json');
  writeFileSync(p, '{ this is not json', 'utf8');
  let s;
  assert.doesNotThrow(() => { s = new SessionStore(p); });
  assert.equal(s.get('user-a'), null);
});

test('带 BOM 的会话文件可读（PowerShell 常见产物）', () => {
  const p = join(sandbox, 's7.json');
  const body = JSON.stringify({
    version: 1,
    sessions: { 'user-a': { sessionId: 'sbom', updatedAt: Date.now() } },
  });
  writeFileSync(p, '\uFEFF' + body, 'utf8');
  const s = new SessionStore(p);
  assert.equal(s.get('user-a'), 'sbom');
});

test('过期会话被丢弃', () => {
  const p = join(sandbox, 's8.json');
  const old = Date.now() - 10 * 24 * 3600_000;
  writeFileSync(p, JSON.stringify({
    sessions: { 'user-a': { sessionId: 'sold', updatedAt: old } },
  }), 'utf8');
  const s = new SessionStore(p, { ttlMs: 7 * 24 * 3600_000 });
  assert.equal(s.get('user-a'), null, '超过 TTL 的会话应失效');
});

test('写入是原子的（临时文件不残留）', () => {
  const p = join(sandbox, 's9.json');
  const s = new SessionStore(p);
  s.set('user-a', 'session-atom');
  assert.ok(existsSync(p), '目标文件应存在');
  assert.ok(!existsSync(p + '.tmp'), '不应残留临时文件');
});

test('保存内容为合法 JSON', () => {
  const p = join(sandbox, 's10.json');
  const s = new SessionStore(p);
  s.set('user-a', 'session-json');
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(parsed.sessions['user-a'].sessionId, 'session-json');
});

test('多个用户互不干扰', () => {
  const p = join(sandbox, 's11.json');
  const s = new SessionStore(p);
  for (let i = 0; i < 20; i++) s.set(`u${i}`, `sess-${i}`);
  const s2 = new SessionStore(p);
  for (let i = 0; i < 20; i++) {
    assert.equal(s2.get(`u${i}`), `sess-${i}`, `用户 u${i} 的会话应保留`);
  }
});

test('clearAll 清空全部', () => {
  const s = new SessionStore(join(sandbox, 's12.json'));
  s.set('u1', 'a');
  s.set('u2', 'b');
  s.clearAll();
  assert.equal(s.size(), 0);
  assert.equal(s.get('u1'), null);
});

test('数字型 userId 与字符串型等价', () => {
  const s = new SessionStore(join(sandbox, 's13.json'));
  s.set(12345, 'sess-num');
  assert.equal(s.get('12345'), 'sess-num', '数字与字符串 userId 应视为同一个键');
});

test('会话文件里的注释键被忽略（不会被当成用户 id）', () => {
  // 实际踩到：往 sessions.json 里加 _说明 做文档，若不跳过，
  // 它会被当成一个用户 id 存进表里，白白占位且语义混乱。
  const p = join(sandbox, 's14.json');
  writeFileSync(p, JSON.stringify({
    version: 1,
    _说明: ['这个文件是给人看的'],
    sessions: {
      _说明: '嵌套注释键也不应被当成用户',
      'real-user': { sessionId: 'sess-real', updatedAt: Date.now() },
    },
  }), 'utf8');
  const s = new SessionStore(p);
  assert.equal(s.size(), 1, `应只加载 1 个真实会话，实得 ${s.size()}`);
  assert.equal(s.get('real-user'), 'sess-real');
  assert.equal(s.get('_说明'), null, '注释键不应可被查询');
});

console.log('\n=== 防回归：不得存在重复的令牌实现 ===');

test('state/index.js 不再导出 PendingConfirmations', () => {
  // 重复实现会漂移，且旧的那份缺少字母表校验（0→O 可伪装绕过）。
  // 唯一权威实现是 src/qq/approval.js 的 ApprovalManager。
  assert.equal(
    stateModule.PendingConfirmations, undefined,
    'state/index.js 不应再导出 PendingConfirmations —— 令牌逻辑统一在 src/qq/approval.js'
  );
});

test('state/index.js 仍导出 SessionStore', () => {
  assert.equal(typeof stateModule.SessionStore, 'function');
});

console.log('\n=== 收尾 ===');

test('清理临时目录', () => {
  rmSync(sandbox, { recursive: true, force: true });
  assert.ok(!existsSync(sandbox));
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
