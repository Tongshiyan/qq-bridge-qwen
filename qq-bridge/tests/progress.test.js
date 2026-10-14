/**
 * 进度推送模块单测
 *
 * 核心关注点有两个：
 *
 * 1. **节流**：QQ 机器人有严格的消息配额，刷屏会被限流甚至封禁。
 *    首要断言是 —— 短任务零推送、长任务推送间隔受控、总量有硬上限。
 *
 * 2. **"在干什么"**：改造前用户只收到「🔄 仍在执行（第 3 轮，第 2 步）」，
 *    知道在跑但不知道在干什么。现在播报来自 tool_call / thinking，
 *    因此测试必须同时锁住"内容对不对"与"量受不受控"。
 *
 * 另一重点是**并发安全**：真实 DSH 事件流是同步连续到达的，桥接侧自然写成
 *   onEvent: (ev) => { progress.onEvent(ev).catch(() => {}) }
 * 即不等待上一次完成。实现必须在调用点完成闸门判定与配额预占，
 * 而不能把并发调用当作噪声丢弃 —— 否则整个任务只会推送 1 条进度。
 *
 * ⚠️ 契约变更（2026-10-12）：`step_start` 单独**不再**触发推送。
 *    DSH 在 step_start 之后 1–2 秒才发出 thinking / tool_call，那才是内容。
 *    旧实现让 step_start 抢先占掉配额，紧接着真正的动作被最小间隔拦掉，
 *    用户最终只看到空洞的"正在执行"（真实事件流回放实测到过这个现象）。
 *    所以现在：step_start 只挂起，等有内容再发（见 #flushPendingStep）。
 *    下面的事件序列因此在每个 step_start 后紧跟一条 tool_call —— 这与真实
 *    事件流的形状一致。
 *
 * 全部使用假时钟，零 sleep，测试瞬间完成。
 *
 * 用法: bin\node.cmd tests\progress.test.js
 */

import assert from 'node:assert/strict';
import { ProgressReporter, describeToolCall, describeThinking } from '../src/progress/reporter.js';

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

/**
 * 造一个假时钟 + 收集器。
 *
 * ⚠️ 刻意暴露的契约耦合：`at` 记录的是 send 被调用那一刻的时钟快照。
 * 该间隔断言只有在实现**于调用点同步调用 send** 时才成立（当前实现如此：
 * 三重闸门判定与 send 调用都在 onEvent 的同步段内完成）。
 * 若将来有人把 send 改为延迟/排队调用，`at` 会静默偏移、间隔断言失真。
 * 因此 `fire()` 在调用前显式刷新 `callTime`，把这个前提写在明面上，
 * 而不是靠闭包里读 `t` 隐式成立。
 */
function harness(opts = {}) {
  let t = 0;
  let callTime = 0;
  const pushes = [];
  const reporter = new ProgressReporter({
    send: async (text) => { pushes.push({ at: callTime, text }); },
    now: () => t,
    ...opts,
  });
  return {
    reporter,
    pushes,
    advance: (ms) => { t += ms; },
    at: () => t,
    /** 推进时钟后触发事件，并把当前时钟快照为 send 的时间戳。 */
    fire: (event) => { callTime = t; return reporter.onEvent(event); },
    /** finish 同理。 */
    finish: (result) => { callTime = t; return reporter.finish(result); },
    /** 心跳（调用方驱动）同理。 */
    beat: () => { callTime = t; return reporter.heartbeat(); },
  };
}

/** 造一个 turn_start 事件。 */
const turnStart = (turn = 1) => ({ type: 'status', phase: 'turn_start', turn });
/** 造一个 step_start 事件。 */
const stepStart = (turn = 1, step = 1) => ({ type: 'status', phase: 'step_start', turn, step });
/** 造一个 tool_call 事件（真实事件流里紧跟 step_start）。 */
const toolCall = (tool = 'pwsh', input = { command: 'echo hi' }) => ({ type: 'tool_call', tool, input });
/** 造一个 tool_result 事件。 */
const toolResult = (status = 'completed') => ({ type: 'tool_result', callId: 'c1', status, result: 'ok' });

console.log('\n=== 静默期：短任务必须零推送 ===');

await test('10 秒任务完全不推送', async () => {
  const h = harness();
  await h.fire(turnStart(1));
  h.advance(5000);
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall());
  h.advance(5000);
  assert.equal(h.pushes.length, 0, `短任务不应推送，实得 ${h.pushes.length} 条`);
});

await test('正好在静默边界内不推送', async () => {
  const h = harness({ silentBeforeMs: 12000 });
  await h.fire(turnStart(1));
  h.advance(11000);
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall());
  assert.equal(h.pushes.length, 0);
});

await test('超出静默期后开始推送', async () => {
  const h = harness({ silentBeforeMs: 12000 });
  await h.fire(turnStart(1));
  h.advance(13000);
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall());
  assert.equal(h.pushes.length, 1);
});

console.log('\n=== 内容：说的必须是"在干什么" ===');

await test('step_start 单独不推送，等动作到位才推', async () => {
  const h = harness({ silentBeforeMs: 0 });
  await h.fire(turnStart(1));
  h.advance(60000);
  await h.fire(stepStart(1, 1));
  assert.equal(h.pushes.length, 0, 'step_start 不该单独占掉配额（内容还没到）');

  await h.fire(toolCall('pwsh', { command: 'Get-ChildItem D:\\' }));
  assert.equal(h.pushes.length, 1, '动作到了就应该推一条');
  assert.match(h.pushes[0].text, /Get-ChildItem D:\\/, '文案里要有真正在跑的命令');
});

await test('tool_call 文案含工具动作与关键参数', async () => {
  const h = harness({ silentBeforeMs: 0 });
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall('read', { file_path: 'C:\\Users\\<your-username>\\Desktop\\note.txt' }));
  assert.match(h.pushes[0].text, /🔧 正在读取文件：C:\\Users\\<your-username>\\Desktop\\note\.txt/);

  const d = describeToolCall('grep', { pattern: 'TODO' });
  assert.equal(d, '搜索内容：TODO');
});

await test('没有工具时退化为 thinking 片段（等过让步窗口后）', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000 });
  await h.fire(stepStart(1, 1));
  h.advance(1000);
  // 让步窗口内（<2.5s）先压住，优先等可能到来的 tool_call
  await h.fire({ type: 'thinking', text: '用户想让我看看磁盘剩余空间，我先查一下' });
  assert.equal(h.pushes.length, 0, '让步窗口内不推');

  h.advance(6000);
  await h.beat(); // 之后靠心跳/后续事件补上，内容仍是"在想什么"
  assert.equal(h.pushes.length, 1);
  assert.match(h.pushes[0].text, /💭 用户想让我看看磁盘剩余空间/);
});

await test('工具执行完用"上一步"复述，仍然说明做了什么', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000 });
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall('pwsh', { command: 'df -h' }));
  await h.fire(toolResult('completed'));
  h.advance(2000);
  await h.fire(stepStart(1, 2));
  await h.fire({ type: 'thinking', text: '接下来汇总结果' });
  assert.match(h.pushes[1].text, /✅ 上一步：运行命令：df -h/);
});

await test('工具失败会单独播报', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000 });
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall('pwsh', { command: 'rm -rf /' }));
  h.advance(2000);
  await h.fire(toolResult('error'));
  assert.equal(h.pushes.length, 2);
  assert.match(h.pushes[1].text, /上一步失败（error）/);
});

await test('未知工具也能给出可读文案', async () => {
  assert.equal(describeToolCall('mystery_tool', {}), '使用工具 mystery_tool');
  assert.equal(describeToolCall('', {}), '正在执行下一步');
  assert.equal(describeThinking('   \n  '), '');
});

await test('超长细节被截断（不把 QQ 消息撑爆）', async () => {
  const h = harness({ silentBeforeMs: 0 });
  const long = 'x'.repeat(500);
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall('pwsh', { command: long }));
  assert.ok(h.pushes[0].text.includes('…'), '应带省略号');
  assert.ok(h.pushes[0].text.length <= 100, `文案应简短，实得 ${h.pushes[0].text.length} 字`);
});

console.log('\n=== 心跳：长时间没有事件也要有反馈 ===');

await test('心跳能补一条"还在跑"的进度', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000 });
  await h.fire(stepStart(1, 1));
  h.advance(60000);
  assert.equal(h.pushes.length, 0, '这一步还没内容，先不推');
  await h.beat();
  assert.equal(h.pushes.length, 1, '心跳应补一条');
  assert.match(h.pushes[0].text, /已用 1 分/, '心跳文案要带已用时');
});

await test('心跳同样受最小间隔约束（不会变成刷屏）', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 15000 });
  h.advance(30000);
  await h.beat();
  assert.equal(h.pushes.length, 1);
  h.advance(2000);
  await h.beat();
  assert.equal(h.pushes.length, 1, '间隔没到，不该再推');
  h.advance(20000);
  await h.beat();
  assert.equal(h.pushes.length, 2, '间隔到了才推');
});

await test('finish 之后心跳静默', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000 });
  h.advance(60000);
  await h.finish({ ok: true });
  await h.beat();
  assert.equal(h.pushes.length, 0);
});

console.log('\n=== 节流：间隔与上限 ===');

await test('推送间隔不小于 minIntervalMs', async () => {
  const h = harness({ minIntervalMs: 20000, silentBeforeMs: 5000 });
  await h.fire(turnStart(1));
  // 时间跨度必须远大于间隔，否则物理上不可能产生多次推送
  for (let i = 0; i < 60; i++) {
    h.advance(5000);
    await h.fire(stepStart(1, i + 1));
    await h.fire(toolCall('pwsh', { command: `echo ${i}` }));
  }
  assert.ok(h.pushes.length >= 3, `应有多次推送，实得 ${h.pushes.length}`);
  for (let i = 1; i < h.pushes.length; i++) {
    const gap = h.pushes[i].at - h.pushes[i - 1].at;
    assert.ok(gap >= 20000, `第 ${i} 次间隔 ${gap}ms < 20000ms`);
  }
});

await test('maxPushes 是真正的约束（间隔设到最小仍受限）', async () => {
  // 关键：把间隔压到下限，让上限成为唯一约束，才能真的测到 cap。
  // 若只断言 pushes.length <= 6，被间隔限住时会假通过。
  const h = harness({ minIntervalMs: 1000, maxPushes: 6, silentBeforeMs: 1000 });
  await h.fire(turnStart(1));
  let attempted = 0;
  for (let i = 0; i < 500; i++) {
    h.advance(2000);
    attempted++;
    await h.fire(stepStart(1, i + 1));
    await h.fire(toolCall('pwsh', { command: `echo ${i}` }));
  }
  assert.equal(h.pushes.length, 6, `上限应精确生效为 6，实得 ${h.pushes.length}`);
  assert.ok(attempted > 6, '测试前提：事件数必须远超上限');
  assert.ok(h.reporter.suppressed > 0, '超限部分应计入 suppressed');
});

await test('并发调用（不 await）也能正确节流 —— 真实事件流的调用方式', async () => {
  // DSH 的 stdout 事件同步连续到达，桥接侧自然写成不 await 的连发。
  // 实现必须在调用点完成判定与配额预占，否则第一个 await 之后的调用
  // 全被守卫丢弃，整个任务只会推送 1 条。
  const h = harness({ minIntervalMs: 2000, maxPushes: 5, silentBeforeMs: 1000 });
  h.fire(turnStart(1));                          // 故意不 await
  for (let i = 0; i < 100; i++) {
    h.advance(2000);
    h.fire(stepStart(1, i + 1));                 // 故意不 await
    h.fire(toolCall('pwsh', { command: `echo ${i}` })); // 故意不 await
  }
  assert.equal(h.pushes.length, 5,
    `并发调用下仍应达到上限 5，实得 ${h.pushes.length}（为 1 则说明并发被误当噪声丢弃）`);
});

console.log('\n=== 健壮性：绝不抛出 ===');

await test('send 抛异常不向外传播', async () => {
  let t = 0;
  const reporter = new ProgressReporter({
    send: async () => { throw new Error('模拟网络故障'); },
    now: () => t,
    minIntervalMs: 20000,
    silentBeforeMs: 1000,
  });
  await reporter.onEvent(turnStart(1));
  for (let i = 0; i < 20; i++) {
    t += 5000;
    await reporter.onEvent(stepStart(1, i + 1)); // 不得抛出
    await reporter.onEvent(toolCall('pwsh', { command: `echo ${i}` }));
  }
  assert.ok(reporter.failed > 0, '失败应被计数');
});

await test('send reject 情况下仍遵守上限（不退化成死亡重试）', async () => {
  let t = 0;
  let calls = 0;
  const reporter = new ProgressReporter({
    send: async () => { calls++; throw new Error('x'); },
    now: () => t,
    minIntervalMs: 20000,
    maxPushes: 6,
    silentBeforeMs: 1000,
  });
  await reporter.onEvent(turnStart(1));
  for (let i = 0; i < 300; i++) {
    t += 5000;
    await reporter.onEvent(stepStart(1, i + 1));
    await reporter.onEvent(toolCall('pwsh', { command: `echo ${i}` }));
  }
  // 必须精确等于上限。
  // 曾写成 assert.ok(calls <= 6)：那是恒真断言 —— 实现若一条都不发（calls=0）
  // 也会通过，而那恰恰是「死亡重试」的反面失败模式，等于没测。
  assert.equal(calls, 6, `发送通道持续报错时调用次数应精确达到上限，实得 ${calls}`);
  assert.equal(reporter.failed, 6, '失败次数应与调用次数一致');
});

await test('畸形事件全部 no-op', async () => {
  const h = harness({ silentBeforeMs: 0 });
  const bad = [null, undefined, {}, { type: 'bogus' }, 'string', 123, [], { type: 'status' }];
  for (const e of bad) {
    await h.fire(e); // 不得抛出
  }
  assert.equal(h.pushes.length, 0, '畸形事件不应产生推送');
});

await test('turn_end 带 error 不崩溃', async () => {
  const h = harness({ silentBeforeMs: 0 });
  await h.fire(turnStart(1));
  h.advance(30000);
  await h.fire({
    type: 'status', phase: 'turn_end', turn: 1,
    reason: { kind: 'error', error: { message: 'boom', code: 'X' } },
  });
  await h.fire({
    type: 'status', phase: 'turn_end', turn: 1, reason: 'not-an-object',
  });
  await h.fire({ type: 'status', phase: 'turn_end', turn: 1, reason: null });
  assert.ok(true);
});

await test('时钟倒流不崩溃', async () => {
  let t = 100000;
  const reporter = new ProgressReporter({ send: async () => {}, now: () => t, silentBeforeMs: 0 });
  await reporter.onEvent(turnStart(1));
  t = 0; // 倒流
  await reporter.onEvent(stepStart(1, 1));
  await reporter.onEvent(toolCall());
  assert.ok(reporter.elapsedMs >= 0, 'elapsedMs 不应为负');
});

console.log('\n=== 统计与收尾 ===');

await test('suppressed 记录被闸门拦下的次数', async () => {
  const h = harness({ minIntervalMs: 20000, silentBeforeMs: 5000 });
  await h.fire(turnStart(1));
  for (let i = 0; i < 30; i++) {
    h.advance(1000);
    await h.fire(stepStart(1, i + 1));
    await h.fire(toolCall('pwsh', { command: `echo ${i}` }));
  }
  assert.ok(h.reporter.suppressed > 0, '应有被拦下的记录');
});

await test('正常结束时 finish 不重复推送', async () => {
  const h = harness({ silentBeforeMs: 0 });
  await h.fire(turnStart(1));
  h.advance(60000);
  await h.fire(stepStart(1, 1));
  await h.fire(toolCall());
  const before = h.pushes.length;
  assert.ok(before >= 1, '前提：此时已推过进度');
  await h.finish({ ok: true, text: '答案', turns: 1, steps: 1 });
  assert.equal(h.pushes.length, before, '正常结束不应额外推送（否则与正式结果重复）');
});

await test('超时/取消时 finish 有说明', async () => {
  for (const flag of ['timedOut', 'killed']) {
    const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000 });
    await h.fire(turnStart(1));
    h.advance(120000);
    await h.finish({ ok: false, [flag]: true, text: '' });
    assert.ok(h.pushes.length >= 1, `${flag} 时应有收尾说明`);
  }
});

await test('finish 对畸形 result 不崩溃', async () => {
  const h = harness({ silentBeforeMs: 0 });
  for (const r of [null, undefined, {}, 'x', 123]) {
    await h.finish(r); // 不得抛出
  }
  assert.ok(true);
});

await test('推送文案含用时且足够短', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000 });
  await h.fire(turnStart(2));
  h.advance(60000);
  await h.fire(stepStart(2, 3));
  await h.fire(toolCall());
  assert.ok(h.pushes.length >= 1);
  const text = h.pushes[0].text;
  assert.match(text, /第 2 轮 第 3 步/, `文案应含位置信息: ${text}`);
  assert.match(text, /已用/, `文案应含用时: ${text}`);
  assert.ok(text.length <= 100, `文案应简短，实得 ${text.length} 字`);
});

await test('推送配额由 attempts 计量（pushed/failed 在发送结算时递增）', async () => {
  const h = harness({ silentBeforeMs: 0, minIntervalMs: 1000, maxPushes: 4 });
  await h.fire(turnStart(1));
  for (let i = 0; i < 60; i++) {
    h.advance(2000);
    await h.fire(stepStart(1, i + 1));
    await h.fire(toolCall('pwsh', { command: `echo ${i}` }));
  }
  assert.equal(h.pushes.length, 4, `应恰好用完 4 个配额，实得 ${h.pushes.length}`);
  if (typeof h.reporter.attempts === 'number') {
    assert.equal(h.reporter.attempts, 4, 'attempts 应等于已消耗配额');
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
