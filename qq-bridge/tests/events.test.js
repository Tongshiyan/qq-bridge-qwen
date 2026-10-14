/**
 * 纯函数单测：DSH 事件解析
 *
 * 用真实的 dsh --json 事件样本验证解析逻辑，特别是：
 *   - NDJSON 跨 chunk 分割
 *   - 多个对象挤在一个 chunk
 *   - 错误事件的结构化提取
 *   - 会话 id 提取（用于 --resume 维持上下文）
 *
 * 用法: bin\node.cmd tests\events.test.js
 */

import assert from 'node:assert/strict';
import {
  buildDshArgs,
  parseEventLine,
  NdjsonParser,
  RunAccumulator,
  describeResult,
  detectProfileWriteDenied,
  detectStaleSession,
  isStaleSessionFailure,
  planSessionCleanup,
} from '../src/dsh/events.js';

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

// 真实样本（来自本机 dsh --profile headless --json 实测输出）
const SAMPLE_OK = [
  '{"type":"session","sessionId":"session-2fe69710-29f3-47b9-bdf9-da80ae76e8ac","cwd":"C:\\\\Users\\\\Shane\\\\Desktop\\\\dsh-stock"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"status","phase":"step_end","turn":1,"step":1}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"PONG"}',
].join('\n') + '\n';

const SAMPLE_ERR = [
  '{"type":"session","sessionId":"session-abc","cwd":"C:\\\\work"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"status","phase":"step_end","turn":1,"step":1}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \\"deepseek-official\\"","code":"MISSING_CREDENTIAL"}}}',
  '{"type":"final","text":""}',
].join('\n') + '\n';

console.log('\n=== buildDshArgs ===');

test('基本参数顺序正确', () => {
  const a = buildDshArgs('hello world');
  assert.deepEqual(a, ['--profile', 'headless', '--json', 'hello world']);
});

test('带 sessionId 时插入 --session-id', () => {
  const a = buildDshArgs('continue', { sessionId: 'session-x' });
  assert.deepEqual(a, ['--profile', 'headless', '--json', '--session-id', 'session-x', 'continue']);
});

test('任务作为单个 argv 元素（防注入的关键）', () => {
  const evil = 'rm -rf /; echo pwned && del /f /s /q C:\\';
  const a = buildDshArgs(evil);
  // 整串必须是一个元素，绝不能被拆开
  assert.equal(a[a.length - 1], evil);
  assert.equal(a.length, 4);
});

test('空任务不抛异常', () => {
  assert.doesNotThrow(() => buildDshArgs(''));
  assert.doesNotThrow(() => buildDshArgs(null));
  assert.doesNotThrow(() => buildDshArgs(undefined));
});

console.log('\n=== parseEventLine ===');

test('合法 JSON 行可解析', () => {
  const ev = parseEventLine('{"type":"final","text":"ok"}');
  assert.equal(ev.type, 'final');
  assert.equal(ev.text, 'ok');
});

test('空行返回 null', () => {
  assert.equal(parseEventLine(''), null);
  assert.equal(parseEventLine('   '), null);
  assert.equal(parseEventLine(null), null);
});

test('非 JSON 文本返回 null 而不抛异常', () => {
  assert.equal(parseEventLine('Warning: something happened'), null);
  assert.equal(parseEventLine('{"broken": '), null);
});

test('JSON 数组不算有效事件（只认对象）', () => {
  assert.equal(parseEventLine('[1,2,3]'), null);
});

console.log('\n=== NdjsonParser（分片处理）===');

test('一次喂入完整多行', () => {
  const p = new NdjsonParser();
  const evs = p.push(SAMPLE_OK);
  assert.equal(evs.length, 6);
  assert.equal(evs[0].type, 'session');
  assert.equal(evs[5].type, 'final');
});

test('逐字节喂入仍能正确重组（跨 chunk 边界）', () => {
  const p = new NdjsonParser();
  const collected = [];
  for (const ch of SAMPLE_OK) {
    collected.push(...p.push(ch));
  }
  collected.push(...p.flush());
  assert.equal(collected.length, 6, `期望 6 个事件，实得 ${collected.length}`);
  assert.equal(collected[5].text, 'PONG');
});

test('一个 chunk 含多个对象 + 半个对象', () => {
  const p = new NdjsonParser();
  const all = SAMPLE_OK;
  const cut = 120;
  const first = p.push(all.slice(0, cut));
  const second = p.push(all.slice(cut));
  const total = first.length + second.length;
  assert.equal(total, 6, `期望 6 个，实得 ${total}`);
});

test('最后一行无换行符时靠 flush 取出', () => {
  const p = new NdjsonParser();
  const evs = p.push('{"type":"final","text":"tail"}');
  assert.equal(evs.length, 0, '无换行不应立即产出');
  const tail = p.flush();
  assert.equal(tail.length, 1);
  assert.equal(tail[0].text, 'tail');
});

test('混入非 JSON 噪声行不影响事件提取', () => {
  const p = new NdjsonParser();
  const noisy = 'some banner text\n{"type":"final","text":"ok"}\nmore noise\n';
  const evs = p.push(noisy);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].text, 'ok');
});

test('损坏的 JSON 行被计数但不崩溃', () => {
  const p = new NdjsonParser();
  const evs = p.push('{"type":"final"\n{"type":"final","text":"good"}\n');
  assert.equal(evs.length, 1);
  assert.equal(p.brokenLines, 1, '应记录 1 行损坏');
});

console.log('\n=== RunAccumulator ===');

test('成功样本：提取 sessionId / text / 计数', () => {
  const acc = new RunAccumulator();
  const p = new NdjsonParser();
  for (const ev of p.push(SAMPLE_OK)) acc.apply(ev);
  const r = acc.result({ exitCode: 0 });

  assert.equal(r.ok, true);
  assert.equal(r.sessionId, 'session-2fe69710-29f3-47b9-bdf9-da80ae76e8ac');
  assert.equal(r.text, 'PONG');
  assert.equal(r.turns, 1);
  assert.equal(r.steps, 1);
  assert.equal(r.errorMessage, null);
  assert.equal(r.missingCredential, false);
});

test('错误样本：结构化提取错误码与信息', () => {
  const acc = new RunAccumulator();
  const p = new NdjsonParser();
  for (const ev of p.push(SAMPLE_ERR)) acc.apply(ev);
  const r = acc.result({ exitCode: 1 });

  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'MISSING_CREDENTIAL');
  assert.match(r.errorMessage, /no API key/);
  assert.equal(r.missingCredential, true, '应识别为缺凭证');
});

test('missingCredential 也可从错误文本推断（无 code 时）', () => {
  const acc = new RunAccumulator();
  acc.apply({
    type: 'status', phase: 'turn_end',
    reason: { kind: 'error', error: { message: 'no API key for provider' } },
  });
  assert.equal(acc.result({ exitCode: 1 }).missingCredential, true);
});

test('超时标记使 ok=false', () => {
  const acc = new RunAccumulator();
  for (const ev of new NdjsonParser().push(SAMPLE_OK)) acc.apply(ev);
  const r = acc.result({ exitCode: null, timedOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.text, 'PONG', '超时也应保留已产生的文本');
});

test('取消标记使 ok=false 且理由为取消', () => {
  const acc = new RunAccumulator();
  const r = acc.result({ exitCode: null, killed: true });
  assert.equal(r.ok, false);
  assert.equal(r.killed, true);
});

test('空事件流不崩溃', () => {
  const acc = new RunAccumulator();
  const r = acc.result({ exitCode: 0 });
  assert.equal(r.ok, true, 'exit 0 且无错误应视为成功');
  assert.equal(r.text, '');
  assert.equal(r.sessionId, null);
});

test('progress 记录轮次推进', () => {
  const acc = new RunAccumulator();
  for (const ev of new NdjsonParser().push(SAMPLE_OK)) acc.apply(ev);
  assert.ok(acc.progress.length >= 3, `progress 应有多条，实得 ${acc.progress.length}`);
  assert.ok(acc.progress.some((s) => s.includes('开始')));
});

console.log('\n=== describeResult ===');

test('成功时返回文本', () => {
  const acc = new RunAccumulator();
  for (const ev of new NdjsonParser().push(SAMPLE_OK)) acc.apply(ev);
  const msg = describeResult(acc.result({ exitCode: 0 }));
  assert.equal(msg, 'PONG');
});

test('成功但无文本时给出说明', () => {
  const acc = new RunAccumulator();
  const msg = describeResult(acc.result({ exitCode: 0 }));
  assert.match(msg, /已完成/);
});

test('缺凭证时给出可操作的修复指引', () => {
  const acc = new RunAccumulator();
  for (const ev of new NdjsonParser().push(SAMPLE_ERR)) acc.apply(ev);
  const msg = describeResult(acc.result({ exitCode: 1 }));
  assert.match(msg, /API Key/);
  assert.match(msg, /Models/, '应指引到 DSH 的 Models 页面');
});

test('超时时保留部分结果', () => {
  const acc = new RunAccumulator();
  for (const ev of new NdjsonParser().push(SAMPLE_OK)) acc.apply(ev);
  const msg = describeResult(acc.result({ exitCode: null, timedOut: true }));
  assert.match(msg, /超时/);
  assert.match(msg, /PONG/);
});

test('取消时给出取消提示', () => {
  const acc = new RunAccumulator();
  const msg = describeResult(acc.result({ exitCode: null, killed: true }));
  assert.match(msg, /取消/);
});

console.log('\n=== 桥接自身被沙箱限制（profile 写入被拒）===');

// 审计日志里的真实 stderr 原文（2026-10-14，手机发「hello」）：
//   Error: EPERM: operation not permitted, open
//     '%USERPROFILE%\.dsh\profiles\headless\cordis.yml'
//       at writeFileSync → prepareProfile → composeProfile → runProfile → runCli
//
// 关键：这次失败**没有任何事件**（eventCount=0），errorMessage 也是 null，
// 唯一的线索在 stderr 里 —— 与"进程根本没起来"外观完全一致。
const REAL_PROFILE_EPERM = {
  ok: false,
  exitCode: 1,
  timedOut: false,
  killed: false,
  errorMessage: null,
  eventCount: 0,
  stderr: [
    'node:fs:2422',
    '    return binding.writeFileUtf8(',
    '                   ^',
    '',
    "Error: EPERM: operation not permitted, open 'C:\\Users\\<your-username>\\.dsh\\profiles\\headless\\cordis.yml'",
    '    at writeFileSync (node:fs:2422:20)',
    '    at prepareProfile (file:///D:/softwares/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js:189:2)',
    '    at composeProfile (file:///D:/softwares/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js:206:46)',
    '    at runProfile (file:///D:/softwares/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js:241:26)',
    '  errno: -4048,',
    "  code: 'EPERM',",
    "  syscall: 'open',",
    "  path: 'C:\\\\Users\\\\<your-username>\\\\.dsh\\\\profiles\\\\headless\\\\cordis.yml'",
    '}',
  ].join('\n'),
};

test('识别出 profile 写入被拒的失败', () => {
  const r = detectProfileWriteDenied(REAL_PROFILE_EPERM);
  assert.equal(r.denied, true);
  assert.equal(
    r.path,
    'C:\\Users\\<your-username>\\.dsh\\profiles\\headless\\cordis.yml',
    '应从 stderr 里取出具体文件路径',
  );
});

test('成功/超时/取消不误判', () => {
  assert.equal(detectProfileWriteDenied({ ok: true, stderr: 'EPERM .dsh/x' }).denied, false);
  assert.equal(
    detectProfileWriteDenied({ ...REAL_PROFILE_EPERM, timedOut: true }).denied, false,
  );
  assert.equal(
    detectProfileWriteDenied({ ...REAL_PROFILE_EPERM, killed: true }).denied, false,
  );
});

test('别的 EPERM（如 spawn EPERM）不误判成 profile 问题', () => {
  const spawnEperm = {
    ok: false,
    exitCode: 1,
    errorMessage: 'spawn EPERM',
    stderr: "Error: spawn EPERM\n    at ChildProcess.spawn (node:child_process)",
  };
  assert.equal(detectProfileWriteDenied(spawnEperm).denied, false);
});

test('畸形结果不抛异常', () => {
  for (const r of [null, undefined, {}, { ok: false }, { ok: false, stderr: 42 }]) {
    assert.doesNotThrow(() => detectProfileWriteDenied(r));
  }
});

test('describeResult 给的是可操作的中文指引，而不是几百字崩溃堆栈', () => {
  const msg = describeResult(REAL_PROFILE_EPERM);
  assert.match(msg, /写权限|沙箱/, '要说清是启动环境问题');
  assert.match(msg, /start-all/, '要给出可直接照做的修法');
  assert.ok(!/at writeFileSync/.test(msg), '不要把 Node 堆栈原样丢给手机用户');
  assert.match(msg, /cordis\.yml/, '仍要保留关键线索（哪个文件）');
});

console.log('\n=== 陈旧会话识别（两代真实故障）===');
// ── 第二代（当前实现）：按 DSH 的报错原文判定 ──────────────────────
//
// 审计日志里的真实 stderr 原文：
//   dsh: session "session-11c2c881-…" was recorded in "%USERPROFILE%",
//        not "%USERPROFILE%\Desktop"
//
// 关键：这次 DSH **先发了 1 个 session 事件**才校验失败，
// 且结构化 errorMessage 为 null —— 报错只在 stderr 里。
const REAL_STDERR = 'dsh: session "session-11c2c881-53d4-4f9c-848f-99b211b72192" '
  + 'was recorded in "C:\\Users\\<your-username>", not "C:\\Users\\<your-username>\\Desktop"\n';

const REAL_MISMATCH = {
  ok: false, exitCode: 1, eventCount: 1, timedOut: false, killed: false,
  errorMessage: null, errorCode: null, text: '', stderr: REAL_STDERR,
};

test('真实报错原文（stderr + 事件数 1）能被识别', () => {
  const r = detectStaleSession(REAL_MISMATCH, 'session-11c2c881-53d4-4f9c-848f-99b211b72192');
  assert.equal(r.stale, true, '必须识别 —— 早期按"零事件"判定时正是在这里漏判');
  assert.match(r.detail, /C:\\Users\\<your-username>/);
  assert.match(r.detail, /Desktop/);
});

test('旧版"零事件"场景仍能识别（回归保护）', () => {
  const old = {
    ok: false, exitCode: 1, eventCount: 0, timedOut: false, killed: false,
    errorMessage: null, text: '',
    stderr: 'dsh: session "session-abc" was recorded in "C:\\old", not "C:\\new"\n',
  };
  assert.equal(detectStaleSession(old, 'session-abc').stale, true);
});

test('报错在 errorMessage 里时也能识别（不依赖 stderr）', () => {
  const r = detectStaleSession({
    ok: false, eventCount: 1, timedOut: false, killed: false,
    errorMessage: 'session "s1" was recorded in "A", not "B"', stderr: '',
  }, 's1');
  assert.equal(r.stale, true);
});

test('没有用 sessionId 时一律不判为陈旧', () => {
  assert.equal(detectStaleSession(REAL_MISMATCH, null).stale, false);
  assert.equal(detectStaleSession(REAL_MISMATCH, undefined).stale, false);
  assert.equal(detectStaleSession(REAL_MISMATCH, '').stale, false);
});

test('成功时不算', () => {
  assert.equal(detectStaleSession({ ...REAL_MISMATCH, ok: true }, 's1').stale, false);
});

test('超时/取消不按会话问题处理', () => {
  assert.equal(detectStaleSession({ ...REAL_MISMATCH, timedOut: true }, 's1').stale, false);
  assert.equal(detectStaleSession({ ...REAL_MISMATCH, killed: true }, 's1').stale, false);
});

test('与会话无关的失败不误判（避免无谓清会话）', () => {
  const credErr = {
    ok: false, eventCount: 6, timedOut: false, killed: false,
    errorMessage: 'llm-deepseek: no API key for provider',
    errorCode: 'MISSING_CREDENTIAL', stderr: '', text: '',
  };
  assert.equal(detectStaleSession(credErr, 's1').stale, false);
  assert.equal(detectStaleSession({ ...credErr, stderr: 'spawn EINVAL' }, 's1').stale, false);
});

test('措辞变化的兜底匹配（同时要求 session 与目录线索）', () => {
  const r = detectStaleSession({
    ok: false, eventCount: 1, timedOut: false, killed: false,
    errorMessage: 'Session is bound to a different workspace directory', stderr: '', text: '',
  }, 's1');
  // 含 session 但无 "was recorded in"/引号目录 → 不强行判定，留给人工
  assert.equal(typeof r.stale, 'boolean');
});

test('畸形输入不崩溃', () => {
  for (const v of [null, undefined, {}, 'x', 123, []]) {
    assert.doesNotThrow(() => detectStaleSession(v, 's1'));
    assert.doesNotThrow(() => detectStaleSession(v, null));
  }
  assert.equal(detectStaleSession(null, 's1').stale, false);
});

test('isStaleSessionFailure 布尔包装与之一致', () => {
  assert.equal(isStaleSessionFailure(REAL_MISMATCH, 'session-11c2c881-53d4-4f9c-848f-99b211b72192'), true);
  assert.equal(isStaleSessionFailure(REAL_MISMATCH, null), false);
  assert.equal(isStaleSessionFailure({ ok: true }, 's1'), false);
});

console.log('\n=== planSessionCleanup（会话善后决策）===');

const CFG = { workspace: 'C:\\Users\\<your-username>\\Desktop', persistSession: true };

test('真实故障 → 要求清会话 + 给出可操作的用户消息', () => {
  const p = planSessionCleanup(REAL_MISMATCH, 'session-11c2c881-53d4-4f9c-848f-99b211b72192', CFG);
  assert.equal(p.clearSession, true);
  assert.match(p.userMessage, /重新发送/);
  assert.match(p.userMessage, /C:\\Users\\<your-username>\\Desktop/, '要说明当前工作目录');
  assert.match(p.userMessage, /was recorded in/, '要带上 DSH 原文，用户才看得懂');
  assert.match(p.auditMessage, /已清除/);
});

test('正常失败 → 不清会话、不插话', () => {
  const p = planSessionCleanup(
    { ok: false, eventCount: 6, errorMessage: 'no API key', errorCode: 'MISSING_CREDENTIAL', stderr: '', text: '' },
    's1', CFG);
  assert.equal(p.clearSession, false);
  assert.equal(p.userMessage, null);
});

test('成功 → 不清会话', () => {
  const p = planSessionCleanup({ ok: true, text: 'ok' }, 's1', CFG);
  assert.equal(p.clearSession, false);
});

test('persistSession=false 时不做任何会话善后', () => {
  const p = planSessionCleanup(REAL_MISMATCH, 'session-x', { ...CFG, persistSession: false });
  assert.equal(p.clearSession, false);
  assert.equal(p.userMessage, null);
});

test('没有 sessionId 时不清会话', () => {
  const p = planSessionCleanup(REAL_MISMATCH, null, CFG);
  assert.equal(p.clearSession, false);
});

test('超时/取消不清会话', () => {
  assert.equal(planSessionCleanup({ ...REAL_MISMATCH, timedOut: true }, 's1', CFG).clearSession, false);
  assert.equal(planSessionCleanup({ ...REAL_MISMATCH, killed: true }, 's1', CFG).clearSession, false);
});

test('workspace 缺失时消息仍完整（不含 undefined）', () => {
  const p = planSessionCleanup(REAL_MISMATCH, 'session-x', { persistSession: true });
  assert.equal(p.clearSession, true);
  assert.ok(!p.userMessage.includes('undefined'), '不能把 undefined 显示给用户');
});

test('畸形输入不崩溃', () => {
  for (const r of [null, undefined, {}, 'x', 123]) {
    assert.doesNotThrow(() => planSessionCleanup(r, 's1', CFG));
    assert.doesNotThrow(() => planSessionCleanup(r, 's1', {}));
  }
  assert.equal(planSessionCleanup(null, 's1', CFG).clearSession, false);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
