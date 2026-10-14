/**
 * 端到端验证：runDshTask 真的把 DSH_PERMISSION_MODE 传进子进程了吗？
 *
 * 背景：agent 报告子进程里 DSH_PERMISSION_MODE = 未设置，于是 DSH 走了
 * `?? 'workspace-write'` 兜底，权限没放开。而静态检查显示整条链路都在。
 * 所以必须在**真实 spawn** 上验证，而不是读代码 —— 这正是本项目反复吃亏的地方。
 *
 * 做法：用一个假 CLI（打印自身环境变量的 .cmd）替代 dsh，
 * 让 runDshTask 真的 spawn 它，再看它收到的环境。
 *
 * 用法: bin\node.cmd tests\env-injection.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDshTask } from '../src/dsh/runner.js';

let passed = 0;
let failed = 0;
const skipped = [];

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

const sandbox = mkdtempSync(join(tmpdir(), 'env-inject-'));

// 能不能 spawn？不能就整体跳过（沙箱内 EPERM）
//
// 注意：必须用 **.cmd** 探测，而不是 process.execPath。
// 早先只测 execPath 会误判为"可 spawn"，结果三条断言里两条假失败、
// 一条假通过 —— 探测本身错了，结论就全是噪声。
const canSpawn = (() => {
  try {
    const probe = join(sandbox, '_probe.cmd');
    writeFileSync(probe, '@echo off\r\nexit /b 0\r\n', 'ascii');
    const r = spawnSync(probe, [], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
})();

console.log('\n=== runDshTask 的环境注入（端到端）===\n');

if (!canSpawn) {
  console.log('  \x1b[33m○ SKIP\x1b[0m 本环境不允许 spawn 子进程（DSH 沙箱限制）');
  console.log('         请在沙箱之外的普通 cmd 窗口运行本测试。');
  console.log('         跳过 ≠ 通过。\n');
  skipped.push('全部端到端注入断言');
  console.log(`${'='.repeat(52)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped.length} 项`);
  console.log('='.repeat(52) + '\n');
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(0);
}

// 造一个"假 dsh"：它把自身环境里关心的变量写成文件，并输出一行合法 JSON 事件
const envOut = join(sandbox, 'child-env.txt');
const stub = join(sandbox, 'stub.cmd');
writeFileSync(stub, [
  '@echo off',
  `echo MODE=%%DSH_PERMISSION_MODE%%> "${envOut}"`,
  `echo PROFILE=%%DSH_PROFILE%%>> "${envOut}"`,
  `echo ELECTRON=%%ELECTRON_RUN_AS_NODE%%>> "${envOut}"`,
  'echo {"type":"final","text":"ok"}',
  'exit /b 0',
].join('\r\n'), 'ascii');

function readEnvOut() {
  try { return readFileSync(envOut, 'utf8'); } catch { return ''; }
}

await test('DSH_PERMISSION_MODE 被注入子进程', async () => {
  rmSync(envOut, { force: true });
  const r = await runDshTask('hi', {
    cliPath: stub,
    workspace: sandbox,
    timeoutMs: 15000,
    permissionMode: 'danger-full-access',
  });
  const out = readEnvOut();
  if (!out) {
    // 把真实失败原因暴露出来 —— 这本身就是"只读代码"永远看不到的信息
    throw new Error(
      `子进程没有写出环境文件。runDshTask 返回: ` +
      `ok=${r.ok} exit=${r.exitCode} err=${r.errorMessage ?? '无'} stderr=${JSON.stringify((r.stderr ?? '').slice(0, 300))}`
    );
  }
  assert.match(out, /MODE=danger-full-access/,
    `子进程收到的 DSH_PERMISSION_MODE 不对。实际输出:\n${out}`);
});

await test('DSH_PROFILE 等桌面版变量被剥离', async () => {
  rmSync(envOut, { force: true });
  await runDshTask('hi', {
    cliPath: stub,
    workspace: sandbox,
    timeoutMs: 15000,
    permissionMode: 'danger-full-access',
    env: { DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: 'x' },
  });
  const out = readEnvOut();
  assert.match(out, /PROFILE=\r?\n|PROFILE=\s*$|PROFILE=$/m,
    `DSH_PROFILE 应被剥离（为空）。实际:\n${out}`);
  assert.ok(!/PROFILE=desktop/.test(out), 'DSH_PROFILE 不应是 desktop');
});

await test('不传 permissionMode 时不注入该变量', async () => {
  rmSync(envOut, { force: true });
  await runDshTask('hi', {
    cliPath: stub,
    workspace: sandbox,
    timeoutMs: 15000,
  });
  const out = readEnvOut();
  assert.ok(!/MODE=danger-full-access/.test(out),
    `未传 permissionMode 时不应出现 danger-full-access。实际:\n${out}`);
});

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(52) + '\n');

rmSync(sandbox, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
