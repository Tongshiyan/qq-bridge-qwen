/**
 * 集成测试：真实子进程路径（runDshTask / resolveSpawn / killTree）
 *
 * 为什么需要这个文件：
 *   tests/pipeline.test.js 把 executeTask 整个 mock 掉了，于是最容易出问题、
 *   也最危险的那段代码 —— 参数构造 → spawn → stdout 事件流解析 → 进程树清理
 *   —— 完全没有回归保护。已经踩到的真实 bug（直接 spawn .cmd 的 EINVAL、
 *   经 cmd.exe 时的命令注入、缺凭证时的报错形态）全都出在这一段。
 *
 * 两种启动方式，本文件都覆盖：
 *   1. direct-node（生产首选，安全）：`nodeExe + jsEntry`
 *      → 完全不经 cmd.exe，任务文本永远只是 argv 元素。安全用例断言这条路径。
 *   2. cmd-fallback（降级，unsafe）：只有 `cliPath` 且是 .cmd
 *      → 必须标记 safe=false 并打印告警；仍要能正常启动（EINVAL 回归保护）。
 *
 * 设计原则：
 *   1. 不依赖模型凭证、不依赖网络：用运行时生成的桩（.cjs / .cmd）驱动真实的
 *      子进程、真实的管道、真实的 NDJSON 事件流、真实的 taskkill /T /F 路径。
 *   2. 子进程不可用时（DSH 文件沙箱下 spawn 会 EPERM）必须【优雅跳过】而不是
 *      失败：打印明确的 SKIP 说明、失败数 0、退出码 0。这是环境限制，不是缺陷。
 *      纯函数断言（resolveSpawn / 参数数组 / 结果形状）在任何环境下都运行。
 *   3. 每个真实进程都用 try/finally + taskkill 兜底清理，不留下孤儿。
 *   4. 孤儿检测以「孙进程心跳文件是否停止增长」为主证据 —— 不需要 WMI、
 *      tasklist 或任何额外工具；WMI/tasklist/taskkill 不可用时打印提示后跳过
 *      对应复核（taskkill 不可用则整个进程树用例跳过），绝不误报失败。
 *
 * 用法（子进程部分必须在沙箱之外的普通 cmd 窗口里跑）:
 *   cd D:\dsh-workspace\qq-bridge
 *   bin\node.cmd tests\integration.test.js
 *
 * 可选环境变量：
 *   DSH_IT_REAL_CLI=1             额外跑一次真实 DSH CLI（需要凭证/网络）
 *   DSH_CLI_PATH / DSH_NODE_EXE / DSH_JS_ENTRY   指定真实 DSH 入口
 *
 * 注意：所有桩文件与载荷都刻意只用 ASCII —— cmd.exe 用 OEM 代码页
 * （中文机器上是 936）写文件，非 ASCII 字节会被读成乱码，导致假失败。
 */

import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDshTask, resolveSpawn, killTree, composeTaskText } from '../src/dsh/runner.js';
import { RunAccumulator, buildDshArgs, describeResult } from '../src/dsh/events.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(HERE, '..');
const IS_WIN = process.platform === 'win32';
const TOKEN = Math.random().toString(36).slice(2, 10);

/** 真实 DSH 入口（仅 opt-in 用例使用；默认值取自 src/config/index.js）。 */
const REAL = {
  cliPath: process.env.DSH_CLI_PATH || 'D:\\softwares\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd',
  nodeExe: process.env.DSH_NODE_EXE || 'D:\\softwares\\dsh\\DeepSeek Harness.exe',
  jsEntry: process.env.DSH_JS_ENTRY
    || 'D:\\softwares\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
};

/** RunAccumulator.result() 文档化的字段集合。 */
const RESULT_KEYS = [
  'ok', 'sessionId', 'cwd', 'text', 'errorMessage', 'errorCode', 'missingCredential',
  'turns', 'steps', 'exitCode', 'timedOut', 'killed', 'stderr', 'progress', 'eventCount',
];

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${String(e.message).split('\n')[0]}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  \x1b[33m○ SKIP\x1b[0m ${name}  \x1b[33m(${reason})\x1b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== 真实子进程集成测试 ===');
console.log(`平台     : ${process.platform}`);
console.log(`Node     : ${process.version}`);
console.log(`执行文件 : ${process.execPath}`);
console.log(`标记     : ${TOKEN}`);

// ══════════════════════════════════════════════════════════════════
// 能力探测：本环境是否允许「带管道 stdio 的子进程」（桥接服务的前提）
// ══════════════════════════════════════════════════════════════════

function probeSyncPipeSpawn() {
  try {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("DSH_IT_PROBE_OK")'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    if (r.error) return { ok: false, detail: `${r.error.code ?? 'error'} ${r.error.message}` };
    return {
      ok: r.status === 0 && String(r.stdout).includes('DSH_IT_PROBE_OK'),
      detail: `exit=${r.status}`,
    };
  } catch (e) {
    return { ok: false, detail: `throw ${e.code ?? e.message}` };
  }
}

function probeAsyncPipeSpawn() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("DSH_IT_PROBE_OK")'], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, detail: `throw ${e.code ?? e.message}` });
      return;
    }

    let out = '';
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail });
    };

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', (e) => done(false, `${e.code ?? 'error'} ${e.message}`));
    child.on('close', (code) => {
      done(code === 0 && out.includes('DSH_IT_PROBE_OK'), `exit=${code} captured=${JSON.stringify(out.slice(0, 64))}`);
    });
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done(false, '探测超时 10s');
    }, 10000);
  });
}

console.log('\n=== 子进程能力探测（决定后续是否跳过）===');
const probeSync = probeSyncPipeSpawn();
const probeAsync = await probeAsyncPipeSpawn();
const cap = { ok: probeSync.ok && probeAsync.ok };
console.log(`  spawnSync + 管道 : ${probeSync.ok ? '\x1b[32m可用\x1b[0m' : '\x1b[31m不可用\x1b[0m'}  (${probeSync.detail})`);
console.log(`  spawn + 管道     : ${probeAsync.ok ? '\x1b[32m可用\x1b[0m' : '\x1b[31m不可用\x1b[0m'}  (${probeAsync.detail})`);
console.log(`  → 真实子进程测试 : ${cap.ok ? '\x1b[32m将执行\x1b[0m' : '\x1b[33m将跳过\x1b[0m'}`);

// ══════════════════════════════════════════════════════════════════
// 1) 启动方式与参数构造（纯函数，任何环境都跑）
// ══════════════════════════════════════════════════════════════════

console.log('\n=== 启动方式：direct-node 优先，cmd.exe 仅兜底 ===');

await test('.cmd 兜底：经 cmd.exe 启动，且被明确标记为 unsafe', async () => {
  const args = buildDshArgs('check disk space', { sessionId: 's-1' });
  const r = resolveSpawn('D:\\softwares\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd', args);

  if (!IS_WIN) {
    assert.equal(r.viaCmd, false, '非 Windows 平台不改写启动方式');
    return;
  }
  assert.equal(r.viaCmd, true, '.cmd 必须标记为经 cmd 启动');
  assert.match(r.file, /cmd\.exe$/i, `启动器应为 cmd.exe，实得 ${r.file}`);
  assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.deepEqual(r.args.slice(3), ['D:\\softwares\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd', ...args]);
  // 关键：经 cmd.exe 的路径必须被标成不安全，调用方才能告警
  assert.equal(r.safe, false, 'cmd.exe 路径必须标记 safe=false（命令注入风险）');
  assert.equal(r.note, 'cmd-fallback');
});

await test('direct-node：nodeExe + jsEntry 完全绕开 cmd.exe', async () => {
  const args = buildDshArgs('explain %PATH% & echo pwned');
  const r = resolveSpawn('C:\\x\\dsh.cmd', args, {
    nodeExe: 'C:\\node\\node.exe',
    jsEntry: 'C:\\dsh\\cli.js',
  });

  assert.equal(r.viaCmd, false, 'direct-node 不得经过 cmd.exe');
  assert.equal(r.safe, true, 'direct-node 必须标记为安全');
  assert.equal(r.note, 'direct-node');
  assert.equal(r.file, 'C:\\node\\node.exe');
  assert.deepEqual(r.args, ['--expose-internals', 'C:\\dsh\\cli.js', ...args]);
  assert.equal(r.args.at(-1), 'explain %PATH% & echo pwned', '任务仍是单个 argv 元素');
});

await test('普通可执行文件：直接启动且标记安全', async () => {
  const r = resolveSpawn('C:\\x\\dsh.exe', ['a', 'b']);
  assert.equal(r.viaCmd, false);
  assert.equal(r.safe, true);
  assert.equal(r.note, 'direct');
  assert.deepEqual(r.args, ['a', 'b']);
});

await test('大小写不敏感（.CMD / .Bat），非批处理文件不改写', async () => {
  if (IS_WIN) {
    assert.equal(resolveSpawn('C:\\x\\DSH.CMD', []).viaCmd, true);
    assert.equal(resolveSpawn('C:\\x\\run.Bat', []).viaCmd, true);
  }
  // 路径里含 "cmd" 但后缀不是批处理，不得误判
  assert.equal(resolveSpawn('C:\\cmd-tools\\runner.exe', ['x']).viaCmd, false);
  assert.equal(resolveSpawn('/usr/bin/node', ['-v']).viaCmd, false);
  assert.equal(resolveSpawn(null, ['x']).viaCmd, false);
  assert.doesNotThrow(() => resolveSpawn(undefined, []));
  assert.doesNotThrow(() => resolveSpawn('C:\\x\\dsh.cmd', [], { nodeExe: undefined, jsEntry: undefined }));

  // 边界观察（不计入成败）：显式传 null 会抛异常，属轻微健壮性问题
  try {
    resolveSpawn('C:\\x\\dsh.cmd', [], null);
  } catch (e) {
    console.log('    \x1b[33m(提示) resolveSpawn(cliPath, args, null) 会抛异常: '
      + `${String(e.message).split('\n')[0]} —— 建议 use \`opts ?? {}\` 兜底\x1b[0m`);
  }
});

await test('任务文本始终是独立的 argv 元素，绝不拼进命令字符串', async () => {
  const task = 'check the remaining space on D drive';
  const args = buildDshArgs(task);
  assert.equal(args.at(-1), task, '任务必须是最后一个 argv 元素');
  assert.equal(args.filter((a) => a === task).length, 1);

  const direct = resolveSpawn('C:\\x\\dsh.cmd', args, { nodeExe: 'n.exe', jsEntry: 'c.js' });
  assert.equal(direct.args.at(-1), task, 'direct-node 时任务仍是独立元素');

  if (!IS_WIN) return;
  const fallback = resolveSpawn('C:\\x\\dsh.cmd', args);
  assert.equal(fallback.args.at(-1), task, 'cmd 兜底时任务仍是独立元素');
  assert.equal(fallback.args.length, 3 + 1 + args.length);
  for (const a of fallback.args) {
    assert.equal(typeof a, 'string');
    assert.ok(!a.includes('cmd.exe /d'), '任何元素都不应包含拼接痕迹');
  }
});

await test('ComSpec 生效；未设置时回退 cmd.exe', async () => {
  if (!IS_WIN) return;
  const keys = Object.keys(process.env).filter((k) => k.toLowerCase() === 'comspec');
  const saved = keys.map((k) => [k, process.env[k]]);
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(resolveSpawn('C:\\x\\dsh.cmd', []).file, 'cmd.exe', '无 ComSpec 时应回退');
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    assert.equal(resolveSpawn('C:\\x\\dsh.cmd', []).file, 'C:\\Windows\\System32\\cmd.exe');
  } finally {
    for (const k of Object.keys(process.env)) {
      if (k.toLowerCase() === 'comspec') delete process.env[k];
    }
    for (const [k, v] of saved) process.env[k] = v;
  }
});

// ══════════════════════════════════════════════════════════════════
// 2) 结果对象形状契约（纯函数 + 故意无效的 CLI 路径）
// ══════════════════════════════════════════════════════════════════

console.log('\n=== 结果形状契约 ===');

await test('成功情形：字段齐备且语义正确', async () => {
  const acc = new RunAccumulator();
  acc.apply({ type: 'session', sessionId: 's-ok', cwd: 'C:\\w' });
  acc.apply({ type: 'status', phase: 'turn_start', turn: 1 });
  acc.apply({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
  acc.apply({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  acc.apply({ type: 'final', text: 'done' });

  const r = acc.result({ exitCode: 0, stderr: '', timedOut: false, killed: false });
  for (const k of RESULT_KEYS) assert.ok(k in r, `结果缺少字段 ${k}`);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.sessionId, 's-ok');
  assert.equal(r.text, 'done');
  assert.equal(r.errorMessage, null);
  assert.equal(r.errorCode, null);
  assert.equal(r.missingCredential, false);
  assert.equal(r.turns, 1);
  assert.equal(r.steps, 1);
  assert.equal(r.eventCount, 5);
  assert.ok(Array.isArray(r.progress));
  assert.equal(describeResult(r), 'done');
});

await test('缺凭证情形：MISSING_CREDENTIAL 被识别为结构化错误', async () => {
  const acc = new RunAccumulator();
  acc.apply({ type: 'session', sessionId: 's-cred', cwd: 'C:\\w' });
  acc.apply({
    type: 'status', phase: 'turn_end', turn: 1,
    reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key configured' } },
  });

  const r = acc.result({ exitCode: 1, stderr: 'boom', timedOut: false, killed: false });
  for (const k of RESULT_KEYS) assert.ok(k in r, `结果缺少字段 ${k}`);
  assert.equal(r.ok, false);
  assert.equal(r.missingCredential, true, '缺少凭证必须被显式标记');
  assert.equal(r.errorCode, 'MISSING_CREDENTIAL');
  assert.match(String(r.errorMessage), /no API key/i);
  assert.match(describeResult(r), /缺少模型 API Key/, '面向用户的回复必须可读');
});

await test('故意无效的入口：快速返回结构化失败，不挂死、不抛异常', async () => {
  const bogus = join('C:\\', `no-such-dsh-${TOKEN}`, 'dsh.cmd');
  const startedAt = Date.now();
  const r = await runDshTask('IT_BOGUS_CLI', {
    cliPath: bogus,
    workspace: process.cwd(),
    timeoutMs: 4000,
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 12000, `必须快速失败，实测 ${elapsed}ms`);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.killed, false);
  assert.equal(r.text, '');
  assert.equal(typeof r.taskId, 'string');
  assert.ok(r.exitCode === null || typeof r.exitCode === 'number', 'exitCode 必须是 null 或数字');

  // 启动失败有两种归因：沙箱下 spawn 直接抛错（errorMessage），
  // 或者 cmd.exe 起来了但找不到目标（错误进 stderr）。两者都必须有可读诊断。
  const diagnostic = [r.errorMessage, r.stderr].filter(Boolean).join(' ').trim();
  assert.ok(diagnostic.length > 0, `失败必须带可读原因，实得 errorMessage=${r.errorMessage} stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(typeof describeResult(r), 'string', 'describeResult 不能因畸形结果而抛错');

  if (cap.ok) {
    // spawn 真的可用时，走的是完整结果形状（而不是同步抛错时的短路对象）
    for (const k of RESULT_KEYS) assert.ok(k in r, `结果缺少字段 ${k}`);
    assert.ok(r.durationMs > 0, 'durationMs 应为正数');
  }
});

// ══════════════════════════════════════════════════════════════════
// 3) 真实子进程测试（spawn 可用时才跑）
// ══════════════════════════════════════════════════════════════════

/** 生成纯 ASCII 文本文件（.cmd 需 CRLF；.cjs 用 LF）。 */
function writeStubFile(file, lines, { crlf = false, ext = '.cjs' } = {}) {
  const text = `${lines.join(crlf ? '\r\n' : '\n')}${crlf ? '\r\n' : '\n'}`;
  assert.ok(/^[\x00-\x7F]*$/.test(text), `生成的桩必须是纯 ASCII: ${file}`);
  assert.ok(file.endsWith(ext), `桩扩展名应为 ${ext}: ${file}`);
  writeFileSync(file, text, 'ascii');
  return file;
}

/** 执行一个工具进程并捕获输出（异步，不阻塞事件循环）。 */
function capture(file, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, {
        encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch (e) {
      resolve({ err: e, stdout: '', stderr: '' });
    }
  });
}

/**
 * 枚举命令行里带标记的进程（返回 pid 数组；工具不可用时返回 null）。
 * 排除 PowerShell 自己（它的命令行里也含标记）。
 */
async function findTreePids(psExe, token) {
  if (!psExe) return null;
  const script = [
    "$ErrorActionPreference='Stop';",
    'Get-CimInstance Win32_Process',
    `| Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${token}*' }`,
    '| ForEach-Object { $_.ProcessId }',
  ].join(' ');
  const r = await capture(psExe, ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (r.err) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}

/** tasklist 复核某个 pid 是否仍存在；工具不可用/被拒绝时返回 null。 */
async function tasklistHasPid(pid) {
  const r = await capture('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
  if (r.err && !r.stdout.trim()) return null; // ENOENT 或直接失败
  if (/access is denied|拒绝访问|not recognized/i.test(`${r.stdout}\n${r.stderr}`)) return null;
  return new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(r.stdout);
}

/** 进程枚举自检：必须能查到「自己」这个进程，否则整条 pid 校验路径不可信。 */
async function selfTestPidEnum(psExe) {
  if (!psExe) return false;
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process "
    + `| Where-Object { $_.ProcessId -eq ${process.pid} } | ForEach-Object { $_.ProcessId }`;
  const r = await capture(psExe, ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (r.err) return false;
  return r.stdout.split(/\r?\n/).some((s) => Number(s.trim()) === process.pid);
}

/** 心跳文件行数：孙进程每约 0.3 秒写一行，用来证明它是否还活着。 */
function countLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length;
}

/** 等心跳出现（证明孙进程确实起来了），超预算返回 false。 */
async function waitForHeartbeat(ctx, minLines, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (countLines(ctx.heartbeat) >= minLines) return true;
    await sleep(150);
  }
  return countLines(ctx.heartbeat) >= minLines;
}

/**
 * 进程终止能力自检：taskkill /T /F 是否真的能杀掉进程树。
 * 受限环境可能拒绝 taskkill —— 那时「无孤儿」断言无法判定，必须降级为跳过
 * （连用例本身也跳过，免得制造出杀不掉的孤儿）。
 */
async function probeTreeKill() {
  const comspec = process.env.ComSpec || 'cmd.exe';
  try {
    const victim = spawn(comspec, ['/c', 'ping', '-n', '30', '127.0.0.1'], {
      cwd: tmpdir(), stdio: 'ignore', windowsHide: true,
    });
    const res = await killTree(victim.pid);
    return { ok: res?.ok === true, reason: res?.reason ?? 'killTree 未返回 ok' };
  } catch (e) {
    return { ok: false, reason: `${e.code ?? ''} ${e.message}`.trim() };
  }
}

/** 轮询直到看见进程树（返回捕获到的 pid；超预算返回最后一轮结果）。 */
async function waitForPids(ctx, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = [];
  while (Date.now() < deadline) {
    last = (await findTreePids(ctx.psExe, ctx.token)) ?? [];
    if (last.length) return last;
    await sleep(200);
  }
  return last;
}

/** 轮询直到进程树消失（返回仍然存活的 pid）。 */
async function waitForPidsGone(ctx, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = [];
  while (Date.now() < deadline) {
    last = (await findTreePids(ctx.psExe, ctx.token)) ?? [];
    if (!last.length) return [];
    await sleep(250);
  }
  return last;
}

// ── 被测用例（只在 spawn 可用时执行）──────────────────────────────

/**
 * 前置条件：进程树用例必须先确认本环境真的能终止进程。
 * 否则会制造出杀不掉的后台进程（孤儿），把「环境不支持」变成新的污染源。
 */
const treeKillRequired = (ctx) => (ctx.treeKillOk
  ? null
  : `本环境拒绝 taskkill（${ctx.treeKillReason}），无法验证进程树清理`);

const GATED_TESTS = [
  ['direct-node 正常路径：形状完整、事件流解析、会话 ID、argv 原样', async (ctx) => {
    const events = [];
    const logs = [];
    const warns = [];
    const r = await runDshTask('IT happy task text', {
      cliPath: ctx.fallbackStub,
      nodeExe: ctx.nodeExe,
      jsEntry: ctx.happyStub,
      workspace: ctx.tmpRoot,
      timeoutMs: 15000,
      onEvent: (ev) => events.push(ev),
      logger: { info: (m) => logs.push(m), warn: (m) => warns.push(m), error: () => {} },
    });

    for (const k of RESULT_KEYS) assert.ok(k in r, `结果缺少字段 ${k}`);
    assert.equal(typeof r.taskId, 'string');
    assert.equal(typeof r.durationMs, 'number');
    assert.equal(r.ok, true, `桩应成功: ${r.errorMessage ?? r.stderr ?? '(无详情)'}`);
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.killed, false);
    assert.equal(r.sessionId, `it-happy-${TOKEN}`, 'session 事件必须被解析');
    assert.equal(r.text, `IT_HAPPY_${TOKEN}`, 'final 事件必须被解析');
    assert.equal(r.errorMessage, null);
    assert.equal(r.missingCredential, false);
    assert.equal(r.eventCount, 5);
    assert.equal(r.turns, 1);
    assert.equal(r.steps, 1);
    assert.deepEqual(
      events.map((e) => e.type),
      ['session', 'status', 'status', 'status', 'final'],
      'onEvent 回调应按顺序收到全部事件',
    );
    assert.match(describeResult(r), new RegExp(`IT_HAPPY_${TOKEN}`));

    // 走的必须是安全的 direct-node 路径，且不得告警
    assert.ok(logs.some((m) => m.includes('direct-node')), `日志应记录启动方式=direct-node，实得: ${logs.join(' | ')}`);
    assert.deepEqual(warns, [], '安全路径不应产生注入告警');

    // 任务文本必须作为单个 argv 元素原样到达子进程。
    //
    // ⚠️ 期望值用生产函数 composeTaskText 计算，而不是硬编码裸任务文本：
    //    runner 会在任务前面加上【运行环境说明】（多行）。早先这里硬编码了
    //    'IT happy task text'，于是每当说明文字变化，这条用例就红一次，
    //    而它想验证的其实是"任务原文被原样带进同一个 argv 元素"。
    const expectedTask = composeTaskText('IT happy task text');
    const argv = JSON.parse(readFileSync(ctx.argvHappy, 'utf8'));
    assert.deepEqual(argv, ['--profile', 'headless', '--json', expectedTask]);
    assert.ok(argv[3].includes('IT happy task text'), '任务原文必须原样出现在该 argv 元素里');
    assert.equal(argv.length, 4, '任务文本不得被拆成多个 argv');
  }],

  ['缺凭证：session 事件先到，错误结构化（missingCredential）', async (ctx) => {
    const r = await runDshTask('IT cred task text', {
      cliPath: ctx.fallbackStub,
      nodeExe: ctx.nodeExe,
      jsEntry: ctx.credStub,
      workspace: ctx.tmpRoot,
      timeoutMs: 15000,
    });

    assert.equal(r.ok, false);
    assert.equal(r.sessionId, `it-cred-${TOKEN}`, '即使随后失败，session 事件也应先到并被捕获');
    assert.equal(r.missingCredential, true, 'MISSING_CREDENTIAL 必须被识别');
    assert.equal(r.errorCode, 'MISSING_CREDENTIAL');
    assert.match(String(r.errorMessage), /no api key/i);
    assert.equal(r.exitCode, 1);
    assert.equal(r.timedOut, false);
    assert.equal(r.killed, false);
    assert.match(describeResult(r), /缺少模型 API Key/);
  }],

  ['超时：timedOut=true、有界返回、进程树被 taskkill /T 清空（无孤儿）', async (ctx) => {
    rmSync(ctx.heartbeat, { force: true });
    const startedAt = Date.now();
    const promise = runDshTask('IT_TIMEOUT_TASK', {
      cliPath: ctx.fallbackStub,
      nodeExe: ctx.nodeExe,
      jsEntry: ctx.hangStub,
      workspace: ctx.tmpRoot,
      timeoutMs: 4000,
    });

    // 超时之前抓到这棵树（直接子进程 + 写心跳的孙进程）
    const pids = ctx.pidEnumOk ? await waitForPids(ctx, 6000) : [];
    const r = await promise;
    const elapsed = Date.now() - startedAt;

    assert.equal(r.timedOut, true, '超过 timeoutMs 必须标记 timedOut');
    assert.equal(r.ok, false);
    assert.equal(r.killed, false, '超时与主动取消是两回事');
    assert.equal(r.sessionId, `it-hang-${TOKEN}`, '超时前产生的 session 事件仍应保留');
    assert.equal(r.text, '', '挂死桩不应产出 final');
    assert.ok(elapsed < 15000, `超时后必须迅速返回，实测 ${elapsed}ms`);
    assert.ok(r.durationMs >= 3000, `durationMs 应反映真实等待，实测 ${r.durationMs}ms`);

    // ── 孤儿检查（主）：孙进程的心跳必须停止。不依赖 WMI / tasklist。
    assert.ok(await waitForHeartbeat(ctx, 1, 1500), '超时前孙进程应在写心跳（否则本用例没有验证价值）');
    await sleep(600); // 给 taskkill /T 收敛时间
    const beatsBefore = countLines(ctx.heartbeat);
    await sleep(2600);
    const beatsAfter = countLines(ctx.heartbeat);
    assert.equal(
      beatsAfter, beatsBefore,
      `超时后仍有孙进程在写心跳（进程树未被 /T 清理干净）: ${beatsBefore} → ${beatsAfter}`,
    );

    // ── 孤儿检查（辅）：pid / tasklist 复核；工具不可用则跳过并说明。
    if (!ctx.pidEnumOk) {
      console.log('    \x1b[33m(注意) 进程枚举不可用（PowerShell/WMI 被拒绝），pid 复核已跳过；心跳法仍然生效\x1b[0m');
      return;
    }
    if (!pids.length) {
      console.log('    \x1b[33m(注意) 未能在超时前抓到进程 pid（WMI 较慢），pid 复核已跳过；心跳法仍然生效\x1b[0m');
      return;
    }
    ctx.captured.push(...pids);
    const survivors = await waitForPidsGone(ctx, 8000);
    assert.deepEqual(survivors, [], `超时后仍有孤儿进程存活 (pid=${survivors.join(',')})`);

    if (ctx.tasklistOk) {
      const still = [];
      for (const pid of pids) {
        if (await tasklistHasPid(pid)) still.push(pid);
      }
      assert.deepEqual(still, [], `tasklist 仍能看到残留 pid=${still.join(',')}（killTree 未生效）`);
    } else {
      console.log('    \x1b[33m(注意) tasklist 不可用，pid 复核已跳过\x1b[0m');
    }
  }, treeKillRequired],

  ['取消（AbortSignal）：killed=true、进程树被清空', async (ctx) => {
    rmSync(ctx.heartbeat, { force: true });
    const controller = new AbortController();
    const promise = runDshTask('IT_ABORT_TASK', {
      cliPath: ctx.fallbackStub,
      nodeExe: ctx.nodeExe,
      jsEntry: ctx.hangStub,
      workspace: ctx.tmpRoot,
      timeoutMs: 30000,
      signal: controller.signal,
    });

    const pids = ctx.pidEnumOk ? await waitForPids(ctx, 6000) : [];
    // 确认孙进程真的起来了再取消，否则取消用例没有验证价值
    assert.ok(await waitForHeartbeat(ctx, 1, 8000), '取消前孙进程应已启动并写心跳');
    controller.abort();
    const r = await promise;

    assert.equal(r.killed, true, '取消必须标记 killed');
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, false, '主动取消不应被误判为超时');
    assert.equal(r.sessionId, `it-hang-${TOKEN}`, '取消前产生的 session 事件仍应保留');
    assert.match(describeResult(r), /被取消/);

    await sleep(600); // 给 taskkill /T 收敛时间
    const beatsBefore = countLines(ctx.heartbeat);
    await sleep(2600);
    const beatsAfter = countLines(ctx.heartbeat);
    assert.equal(
      beatsAfter, beatsBefore,
      `取消后仍有孙进程在写心跳（进程树未被 /T 清理干净）: ${beatsBefore} → ${beatsAfter}`,
    );

    if (!ctx.pidEnumOk) {
      console.log('    \x1b[33m(注意) 进程枚举不可用，pid 复核已跳过；心跳法仍然生效\x1b[0m');
      return;
    }
    if (!pids.length) {
      console.log('    \x1b[33m(注意) 未能在取消前抓到进程 pid（WMI 较慢），pid 复核已跳过；心跳法仍然生效\x1b[0m');
      return;
    }
    ctx.captured.push(...pids);
    const survivors = await waitForPidsGone(ctx, 8000);
    assert.deepEqual(survivors, [], `取消后仍有孤儿进程存活 (pid=${survivors.join(',')})`);
  }, treeKillRequired],

  ['参数安全（安全路径）：元字符 / 引号 / %VAR% 全部原样作为 argv，不产生副作用', async (ctx) => {
    const payloads = [
      { label: 'spaced inert', payload: `report echo ${TOKEN} > SENTINEL_${TOKEN}.txt & echo ${TOKEN} | findstr ${TOKEN}` },
      { label: 'no-space &', payload: `x&echo.>PWNED_AMP_${TOKEN}.txt` },
      { label: 'no-space |', payload: `x|echo.>PWNED_PIPE_${TOKEN}.txt` },
      { label: 'quote break-out', payload: `a" & echo.>PWNED_QUOTE_${TOKEN}.txt & "b` },
      { label: '%VAR% expansion', payload: 'explain %PATH% semantics' },
    ];
    const sentinels = [
      `SENTINEL_${TOKEN}.txt`, `PWNED_AMP_${TOKEN}.txt`,
      `PWNED_PIPE_${TOKEN}.txt`, `PWNED_QUOTE_${TOKEN}.txt`,
    ];
    for (const s of sentinels) rmSync(join(ctx.tmpRoot, s), { force: true });

    const findings = [];
    for (const c of payloads) {
      rmSync(ctx.argvEcho, { force: true });
      const startedAt = Date.now();
      const r = await runDshTask(c.payload, {
        cliPath: ctx.fallbackStub,
        nodeExe: ctx.nodeExe,
        jsEntry: ctx.echoStub,
        workspace: ctx.tmpRoot,
        timeoutMs: 10000,
      });
      const elapsed = Date.now() - startedAt;

      assert.ok(elapsed < 12000, `载荷[${c.label}] 必须快速返回，实测 ${elapsed}ms`);
      assert.equal(typeof r.ok, 'boolean', `载荷[${c.label}] 必须返回结构化结果而不是崩溃`);

      const argv = JSON.parse(readFileSync(ctx.argvEcho, 'utf8'));
      // 同 direct-node 用例：期望值取生产函数的结果，再单独断言原文原样包含。
      const expected = composeTaskText(c.payload);
      if (argv.length !== 4 || argv[3] !== expected) {
        findings.push(`载荷[${c.label}] 到达子进程时已不是原文: ${JSON.stringify(argv)}`);
      } else if (!argv[3].includes(c.payload)) {
        findings.push(`载荷[${c.label}] 原文没有原样出现在任务文本里`);
      }
    }

    for (const s of sentinels) {
      if (existsSync(join(ctx.tmpRoot, s))) {
        findings.push(`载荷被解释执行了：出现了副作用文件 ${s}`);
      }
    }

    assert.equal(
      findings.length, 0,
      `安全路径仍被 shell 语法影响（direct-node 不应有任何解释）:\n      ${findings.join('\n      ')}`,
    );
  }],

  ['cmd.exe 兜底：仍能启动（EINVAL 回归），但必须标记 unsafe 并告警', async (ctx) => {
    const logs = [];
    const warns = [];
    // runtimeNote:false —— 这条用例要验证"任务文本原样到达 argv"，
    // 而兜底路径**必然**经 cmd.exe 重新解析命令行：多行的【运行环境说明】
    // 会在 `echo ARGS=%* > file` 里把重定向本身拆坏（实测该文件根本不会生成）。
    // 这正是 runner 把兜底标记为 unsafe 的原因，所以这里只用单行任务去验证
    // "还能启动 + 被正确标记"，不去承诺不安全路径上的 argv 回环。
    const r = await runDshTask('IT fallback task text', {
      cliPath: ctx.fallbackStub, // 只给 .cmd，不给 nodeExe/jsEntry → 走兜底
      workspace: ctx.tmpRoot,
      runtimeNote: false,
      timeoutMs: 15000,
      logger: { info: (m) => logs.push(m), warn: (m) => warns.push(m), error: () => {} },
    });

    // 兜底路径必须还能跑（这正是当年 spawn EINVAL 的现场）
    assert.equal(r.ok, true, `cmd 兜底路径应能正常启动桩: ${r.errorMessage ?? r.stderr ?? '(无详情)'}`);
    assert.equal(r.exitCode, 0);
    assert.equal(r.sessionId, `it-cmd-${TOKEN}`);
    assert.ok(logs.some((m) => m.includes('cmd-fallback')), `日志应记录启动方式=cmd-fallback，实得: ${logs.join(' | ')}`);
    assert.ok(
      warns.some((m) => /cmd\.exe/.test(m) && /注入|风险/.test(m)),
      `cmd 兜底必须发出注入风险告警，实得: ${JSON.stringify(warns)}`,
    );

    const recorded = readFileSync(ctx.argsCmd, 'utf8').trim();
    assert.ok(recorded.includes('IT fallback task text'), `任务文本应原样到达 argv，实得: ${recorded}`);
    assert.ok(recorded.includes('--profile headless --json'), `参数顺序应为 --profile headless --json <task>，实得: ${recorded}`);
  }],
];

// ══════════════════════════════════════════════════════════════════
// 执行：不可用则整体跳过（失败数保持 0）
// ══════════════════════════════════════════════════════════════════

if (!cap.ok) {
  console.log('');
  console.log('\x1b[33m=== 真实子进程集成测试：跳过 (SKIP) ===\x1b[0m');
  console.log('  原因: 本环境不允许「带管道 stdio 的子进程」（DSH 文件沙箱限制）。');
  console.log(`        spawnSync: ${probeSync.detail}`);
  console.log(`        spawn    : ${probeAsync.detail}`);
  console.log('        这是运行环境的限制，不是被测代码的缺陷 —— 因此不计为失败。');
  console.log('  如何真正运行: 在沙箱之外的普通 cmd 窗口里执行');
  console.log(`        cd ${PROJECT_DIR}`);
  console.log('        bin\\node.cmd tests\\integration.test.js');
  console.log('  以下断言在本环境【未被验证】(跳过 ≠ 通过):');
  for (const [name] of GATED_TESTS) skip(name, '需要真实子进程，本环境不可用');
  skip('真实 DSH CLI 端到端（opt-in）', '需要真实子进程，本环境不可用');
} else {
  let ctx = null;
  let prepared = false;

  try {
    const tmpRoot = mkdtempSync(join(tmpdir(), `dsh-it-${TOKEN}-`));
    ctx = {
      tmpRoot,
      token: TOKEN,
      nodeExe: process.execPath,
      captured: [],
      psExe: null,
      pidEnumOk: false,
      tasklistOk: false,
      treeKillOk: false,
      treeKillReason: '',
    };

    // ── 安全路径桩（direct-node：真实 Node 脚本，不经过任何 shell）
    ctx.happyStub = writeStubFile(join(tmpRoot, `stub-happy-${TOKEN}.cjs`), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'process.stdout.write(',
      `  JSON.stringify({ type: 'session', sessionId: 'it-happy-${TOKEN}', cwd: '.' }) + '\\n' +`,
      "  JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 }) + '\\n' +",
      "  JSON.stringify({ type: 'status', phase: 'step_start', turn: 1, step: 1 }) + '\\n' +",
      "  JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }) + '\\n' +",
      `  JSON.stringify({ type: 'final', text: 'IT_HAPPY_${TOKEN}' }) + '\\n',`,
      ');',
      "fs.writeFileSync(path.join(__dirname, 'argv-happy.json'), JSON.stringify(process.argv.slice(2)));",
      'process.exit(0);',
    ]);
    ctx.argvHappy = join(tmpRoot, 'argv-happy.json');

    ctx.credStub = writeStubFile(join(tmpRoot, `stub-cred-${TOKEN}.cjs`), [
      "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      `emit({ type: 'session', sessionId: 'it-cred-${TOKEN}', cwd: '.' });`,
      "emit({ type: 'status', phase: 'turn_start', turn: 1 });",
      "emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', "
        + "error: { code: 'MISSING_CREDENTIAL', message: 'no api key configured' } } });",
      'process.exit(1);',
    ]);

    // 挂死桩：孙进程（心跳写入者）让进程树有深度，正是 killTree /T 要处理的场景
    ctx.heartbeatStub = writeStubFile(join(tmpRoot, `heartbeat-${TOKEN}.cjs`), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const file = path.join(__dirname, 'heartbeat-${TOKEN}.txt');`,
      "setInterval(() => { try { fs.appendFileSync(file, 'tick\\n'); } catch { /* ignore */ } }, 300);",
    ]);
    ctx.heartbeat = join(tmpRoot, `heartbeat-${TOKEN}.txt`);
    ctx.hangStub = writeStubFile(join(tmpRoot, `stub-hang-${TOKEN}.cjs`), [
      "const { spawn } = require('node:child_process');",
      "const path = require('node:path');",
      `process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'it-hang-${TOKEN}', cwd: '.' }) + '\\n');`,
      `spawn(process.execPath, [path.join(__dirname, 'heartbeat-${TOKEN}.cjs')], { stdio: 'ignore', windowsHide: true });`,
      'setInterval(() => { /* keep alive until taskkill /T /F */ }, 1000);',
    ]);

    ctx.echoStub = writeStubFile(join(tmpRoot, `stub-echo-${TOKEN}.cjs`), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'it-echo-${TOKEN}', cwd: '.' }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'final', text: 'IT_ECHO_${TOKEN}' }) + '\\n');`,
      "fs.writeFileSync(path.join(__dirname, 'argv-echo.json'), JSON.stringify(process.argv.slice(2)));",
      'process.exit(0);',
    ]);
    ctx.argvEcho = join(tmpRoot, 'argv-echo.json');

    // ── 兜底路径桩（.cmd，经 cmd.exe；用于 EINVAL 回归 + 告警断言）
    ctx.fallbackStub = writeStubFile(join(tmpRoot, `stub-cmd-${TOKEN}.cmd`), [
      '@echo off',
      `echo {"type":"session","sessionId":"it-cmd-${TOKEN}","cwd":"."}`,
      `echo {"type":"final","text":"IT_CMD_${TOKEN}"}`,
      'echo ARGS=%* > "%~dp0argv-cmd.txt"',
      'exit /b 0',
    ], { crlf: true, ext: '.cmd' });
    ctx.argsCmd = join(tmpRoot, 'argv-cmd.txt');

    // ── 环境工具可用性（都做「自检」，不可用就跳过对应复核，绝不误报失败）
    for (const cand of ['pwsh', 'powershell']) {
      const probe = await capture(cand, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], 15000);
      if (!probe.err) {
        ctx.psExe = cand;
        break;
      }
    }
    ctx.pidEnumOk = await selfTestPidEnum(ctx.psExe);
    ctx.tasklistOk = (await tasklistHasPid(process.pid)) !== null;
    const tkProbe = await probeTreeKill();
    ctx.treeKillOk = tkProbe.ok;
    ctx.treeKillReason = tkProbe.reason;

    console.log('\n=== 真实子进程测试（桩：不经模型、不需网络）===');
    console.log(`  临时目录 : ${tmpRoot}`);
    console.log(`  nodeExe  : ${ctx.nodeExe}`);
    console.log(`  进程枚举 : ${ctx.pidEnumOk ? `${ctx.psExe} ✓` : `${ctx.psExe ?? '(无)'} ✗（pid 复核将跳过）`}`);
    console.log(`  tasklist : ${ctx.tasklistOk ? '可用 ✓' : '不可用 ✗（pid 复核将跳过）'}`);
    console.log(`  taskkill : ${ctx.treeKillOk ? '可用 ✓（可验证进程树清理）' : `不可用 ✗ ${ctx.treeKillReason}（进程树用例将跳过）`}`);
    console.log(`  孤儿证据 : 孙进程心跳文件 ${ctx.heartbeat}`);

    // 预热：避免首次 WMI 查询太慢，导致超时用例还没抓到 pid 进程就被杀了
    if (ctx.pidEnumOk) await findTreePids(ctx.psExe, `warmup-${TOKEN}-no-match`);

    prepared = true;
  } catch (e) {
    console.log(`\n  \x1b[33m△ 无法准备真实子进程测试环境，改为跳过: ${e.message}\x1b[0m`);
  }

  if (!prepared) {
    for (const [name] of GATED_TESTS) skip(name, '环境准备失败');
    skip('真实 DSH CLI 端到端（opt-in）', '环境准备失败');
  } else {
    try {
      for (const [name, fn, precondition] of GATED_TESTS) {
        const why = precondition ? precondition(ctx) : null;
        if (why) {
          skip(name, why);
          continue;
        }
        await test(name, () => fn(ctx));
      }

      if (process.env.DSH_IT_REAL_CLI !== '1') {
        skip('真实 DSH CLI 端到端（opt-in）', '默认不跑：需要模型凭证/网络，设 DSH_IT_REAL_CLI=1 启用');
      } else if (!existsSync(REAL.jsEntry) && !existsSync(REAL.cliPath)) {
        skip('真实 DSH CLI 端到端（opt-in）', `找不到真实 DSH 入口（jsEntry=${REAL.jsEntry}）`);
      } else {
        await test('真实 DSH CLI：结构化结果 + 会话事件可解析', async () => {
          const logs = [];
          const r = await runDshTask('reply with the single word OK', {
            cliPath: REAL.cliPath,
            nodeExe: REAL.nodeExe,
            jsEntry: existsSync(REAL.jsEntry) ? REAL.jsEntry : undefined,
            workspace: ctx.tmpRoot,
            timeoutMs: 25000,
            logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
          });
          for (const k of RESULT_KEYS) assert.ok(k in r, `结果缺少字段 ${k}`);
          assert.equal(typeof r.taskId, 'string');
          assert.equal(typeof r.durationMs, 'number');
          console.log(`    → ok=${r.ok} exit=${r.exitCode} session=${r.sessionId ?? '(none)'} `
            + `missingCredential=${r.missingCredential} err=${r.errorMessage ?? '(none)'}`);
          if (!r.ok) {
            // 缺凭证/无网络都必须以结构化错误呈现，而不是空结果或崩溃
            assert.ok(
              (r.errorMessage && r.errorMessage.length > 0) || r.stderr.trim().length > 0,
              '真实 DSH 失败时必须有结构化错误信息，而不是空结果',
            );
          }
        });
      }
    } finally {
      // 兜底：先杀掉可能残留的进程树，再删临时目录
      try {
        if (ctx.pidEnumOk) {
          const left = (await findTreePids(ctx.psExe, ctx.token)) ?? [];
          for (const pid of [...ctx.captured, ...left]) await killTree(pid);
        } else {
          for (const pid of ctx.captured) await killTree(pid);
        }
      } catch { /* 尽力而为 */ }

      let cleaned = false;
      for (let i = 0; i < 3 && !cleaned; i++) {
        try {
          rmSync(ctx.tmpRoot, { recursive: true, force: true });
        } catch { /* 可能被仍持有句柄的进程占住，稍后重试 */ }
        cleaned = !existsSync(ctx.tmpRoot);
        if (!cleaned) await sleep(300);
      }
      console.log(`   · 临时目录清理: ${cleaned ? '已完成' : `\x1b[33m失败，请手工删除 ${ctx.tmpRoot}\x1b[0m`}`);
    }
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项` + (skipped ? `，跳过 ${skipped} 项` : ''));
if (skipped && !cap.ok) {
  console.log('说明: 跳过不是通过 —— 本环境的子进程能力受限，请在沙箱之外的普通 cmd 窗口重跑。');
}
if (skipped && cap.ok) {
  console.log('说明: 上面标 SKIP 的用例因缺少前置能力或未启用 opt-in 而未执行，原因见括号。');
}
if (failures.length) {
  console.log('\n失败明细:');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.error}`);
}
console.log(`${'='.repeat(56)}\n`);

process.exit(failed === 0 ? 0 : 1);
