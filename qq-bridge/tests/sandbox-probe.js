/**
 * 沙箱能力探测：子进程 + 管道 stdio 是否可用
 *
 * 背景：本项目的桥接服务需要 spawn `dsh` 子进程并捕获其 stdout。
 * 有资料指出受限沙箱下带管道 stdio 的 spawn 会失败（EPERM），
 * 若属实，则桥接服务必须运行在沙箱之外。
 *
 * 本脚本用最小用例确认这一点，避免把部署方式搞错。
 *
 * 用法: bin\node.cmd tests\sandbox-probe.js
 */

import { spawn, spawnSync } from 'node:child_process';

const results = [];

function record(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: true, detail: r });
    console.log(`  \x1b[32m✓\x1b[0m ${name}  ${r ?? ''}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.code || e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}  ${e.code || e.message}`);
  }
}

console.log('\n=== 沙箱子进程能力探测 ===\n');
console.log(`平台      : ${process.platform}`);
console.log(`Node      : ${process.version}`);
console.log(`执行文件  : ${process.execPath}`);
console.log('');

// 1) 同步 spawn（无管道捕获）
record('spawnSync 执行 node -v', () => {
  const r = spawnSync(process.execPath, ['-v'], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.stdout.trim();
});

// 2) 带管道 stdio 的异步 spawn —— 桥接服务的核心需求
console.log('\n  --- 异步 spawn + 管道捕获（桥接服务依赖此能力）---');

await new Promise((resolve) => {
  let settled = false;
  const done = (ok, detail) => {
    if (settled) return;
    settled = true;
    results.push({ name: 'spawn + pipe stdio', ok, detail });
    if (ok) console.log(`  \x1b[32m✓\x1b[0m spawn + pipe stdio  ${detail}`);
    else console.log(`  \x1b[31m✗\x1b[0m spawn + pipe stdio  ${detail}`);
    resolve();
  };

  let child;
  try {
    child = spawn(process.execPath, ['-e', 'process.stdout.write("PIPE_OK")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    done(false, `${e.code || e.message}`);
    return;
  }

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', () => {});
  child.on('error', (e) => done(false, `${e.code || e.message}`));
  child.on('close', (code) => {
    done(code === 0 && out.includes('PIPE_OK'), `captured=${JSON.stringify(out)} exit=${code}`);
  });

  setTimeout(() => done(false, 'timeout'), 15000);
});

console.log('\n' + '='.repeat(56));
const pipeOk = results.find((r) => r.name === 'spawn + pipe stdio')?.ok;
console.log('结论');
console.log('='.repeat(56));
if (pipeOk) {
  console.log('✅ 子进程 + 管道捕获可用。');
  console.log('   → 桥接服务可以在此环境直接运行与端到端测试。');
} else {
  console.log('❌ 子进程 + 管道捕获不可用。');
  console.log('   → 桥接服务必须运行在 DSH 沙箱之外（普通 cmd / 计划任务）。');
  console.log('   → 这不影响代码正确性：沙箱外运行时该能力正常。');
  console.log('   → 但仍可通过纯函数单测验证解析与策略逻辑。');
}
console.log('');
console.log('全部探测结果:');
for (const r of results) {
  console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}  ->  ${r.detail}`);
}
console.log('');

process.exit(0);
