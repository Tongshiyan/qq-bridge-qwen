/**
 * 单例守卫单测
 *
 * 关注点：
 *   - 第二个实例必须被拒绝（否则任务会被执行两遍）
 *   - 崩溃/强杀留下的孤儿锁必须能被抢占（否则服务再也起不来）
 *   - PID 复用不能把活着的别人的实例误判成自己人
 *   - 释放锁时不能误删抢占者的锁
 *
 * 全部注入假的存活探测，不真的创建进程。
 *
 * 用法: bin\node.cmd tests\guard.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SingletonGuard, probeProcess } from '../src/guard/index.js';

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

const sandbox = mkdtempSync(join(tmpdir(), 'guard-test-'));
let seq = 0;
const lockPath = () => join(sandbox, `lock-${++seq}.json`);

/** 构造一个可控制"谁活着"的守卫。 */
function guard(alivePids = [], times = {}) {
  return new SingletonGuard(lockPath(), {
    isAlive: (pid) => alivePids.includes(pid),
    startTime: (pid) => times[pid] ?? null,
  });
}

console.log('\n=== 基本获取与释放 ===');

test('无锁时可获取', () => {
  const g = guard();
  const r = g.acquire();
  assert.equal(r.ok, true);
  assert.equal(r.tookOver, false);
  assert.ok(existsSync(g.lockPath));
});

test('锁文件记录自己的 PID', () => {
  const g = guard();
  g.acquire();
  const o = JSON.parse(readFileSync(g.lockPath, 'utf8'));
  assert.equal(o.pid, process.pid);
  assert.ok(o.startedAt, '应记录启动时刻');
});

test('释放后锁文件消失', () => {
  const g = guard();
  g.acquire();
  assert.equal(g.release(), true);
  assert.ok(!existsSync(g.lockPath));
});

test('未获取就释放返回 false', () => {
  const g = guard();
  assert.equal(g.release(), false);
});

console.log('\n=== 拒绝第二个实例（核心目的）===');

test('已有活实例时拒绝启动', () => {
  const p = lockPath();
  // 先造一个"活着的别人"
  writeFileSync(p, JSON.stringify({ pid: 99999, startedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');

  const g = new SingletonGuard(p, {
    isAlive: (pid) => pid === 99999,
    startTime: () => '2026-01-01T00:00:00.000Z',
  });
  const r = g.acquire();
  assert.equal(r.ok, false, '第二个实例必须被拒绝');
  assert.match(r.reason, /已有实例在运行/);
  assert.equal(r.holder.pid, 99999);
});

test('被拒绝时不覆盖原锁文件', () => {
  const p = lockPath();
  const original = JSON.stringify({ pid: 99999, startedAt: 't' });
  writeFileSync(p, original, 'utf8');

  const g = new SingletonGuard(p, { isAlive: () => true, startTime: () => 't' });
  g.acquire();
  assert.equal(readFileSync(p, 'utf8'), original, '原锁不应被覆盖');
});

console.log('\n=== 抢占孤儿锁（崩溃恢复）===');

test('持有者已死时可抢占', () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 88888, startedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');

  const g = new SingletonGuard(p, {
    isAlive: () => false, // 已死
    startTime: () => null,
  });
  const r = g.acquire();
  assert.equal(r.ok, true, '崩遗的锁必须能被抢占，否则服务再也起不来');
  assert.equal(r.tookOver, true);
  const o = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(o.pid, process.pid, '锁应更新为自己');
});

test('锁文件损坏时视为无锁并抢占', () => {
  const p = lockPath();
  writeFileSync(p, '{ 这不是合法 JSON', 'utf8');
  const g = new SingletonGuard(p, { isAlive: () => true, startTime: () => null });
  const r = g.acquire();
  assert.equal(r.ok, true, '损坏的锁不应永久阻塞启动');
});

test('空锁文件不崩溃，且视为可抢占', () => {
  const p = lockPath();
  writeFileSync(p, '', 'utf8');
  const g = new SingletonGuard(p, { isAlive: () => true, startTime: () => null });
  let r;
  assert.doesNotThrow(() => { r = g.acquire(); });
  assert.equal(r.ok, true, '空锁文件不应永久阻塞启动');
});

test('同一实例重复 acquire 会被自己的锁拒绝', () => {
  // 生产代码只调用一次，但这条断言锁定了语义：
  // 只要锁里是活着的进程，就不放行 —— 包括自己。
  const p = lockPath();
  const g = new SingletonGuard(p, { isAlive: () => true, startTime: () => null });
  assert.equal(g.acquire().ok, true);
  assert.equal(g.acquire().ok, false, '不应重复获取（否则守卫形同虚设）');
});

test('带 BOM 的锁文件可解析并正确拒绝', () => {
  const p = lockPath();
  writeFileSync(p, '\uFEFF' + JSON.stringify({ pid: 77777, startedAt: 't' }), 'utf8');
  const g = new SingletonGuard(p, { isAlive: () => true, startTime: () => 't' });
  const r = g.acquire();
  assert.equal(r.ok, false, 'BOM 不应导致锁失效（否则会跑出两份）');
});

console.log('\n=== PID 复用防护 ===');

test('同一 PID 但启动时刻不同 → 视为旧进程已死，可抢占', () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 55555, startedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');

  const g = new SingletonGuard(p, {
    isAlive: () => true,                            // PID 存在
    startTime: () => '2026-06-01T12:00:00.000Z',    // 但启动时刻不同 → 是另一个进程
  });
  const r = g.acquire();
  assert.equal(r.ok, true, 'PID 被复用时应允许启动，不能被永久卡住');
  assert.equal(r.tookOver, true);
});

test('同一 PID 且启动时刻一致 → 拒绝（真的是同一个实例）', () => {
  const p = lockPath();
  const t = '2026-01-01T00:00:00.000Z';
  writeFileSync(p, JSON.stringify({ pid: 55556, startedAt: t }), 'utf8');

  const g = new SingletonGuard(p, { isAlive: () => true, startTime: () => t });
  assert.equal(g.acquire().ok, false);
});

test('旧锁无 startedAt 时，只要 PID 活着就保守拒绝', () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 55557 }), 'utf8');
  const g = new SingletonGuard(p, { isAlive: () => true, startTime: () => null });
  assert.equal(g.acquire().ok, false, '无法确认时应保守拒绝');
});

console.log('\n=== 释放安全性 ===');

test('锁被他人接管后，自己不删别人的锁', () => {
  const p = lockPath();
  const g = new SingletonGuard(p, { isAlive: () => false, startTime: () => null });
  g.acquire();
  assert.equal(g.acquired, true);

  // 模拟：另一个进程抢占了锁（例如自己被认为是僵尸后被接管）
  writeFileSync(p, JSON.stringify({ pid: 44444, startedAt: 'later' }), 'utf8');

  const released = g.release();
  assert.equal(released, false, '不应报告成功释放');
  assert.ok(existsSync(p), '不能删掉别人的锁（否则两个进程都以为自己是唯一的）');
  const o = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(o.pid, 44444, '别人的锁应完好');
});

console.log('\n=== probeProcess（真实探测）===');

test('当前进程判定为存活', () => {
  assert.equal(probeProcess(process.pid), true);
});

test('不存在的 PID 判定为不存活', () => {
  // 挑一个几乎不可能存在的 PID（超出 Windows 常见范围）
  assert.equal(probeProcess(999999), false);
});

test('畸形 PID 判定为不存活且不抛异常', () => {
  for (const v of [0, -1, null, undefined, NaN, 'abc', {}, []]) {
    assert.doesNotThrow(() => probeProcess(v));
    assert.equal(probeProcess(v), false, `应拒绝: ${JSON.stringify(v)}`);
  }
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
