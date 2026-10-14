/**
 * 集成测试：完整消息处理流水线
 *
 * 用 mock bot 替换真实 QQ 连接，因此无需凭证、无需网络、无需 spawn，
 * 可以在沙箱内完整验证安全关键路径：
 *
 *   - 未授权用户必须被静默丢弃（不回复、不执行）
 *   - BLOCK 指令必须被拒绝且不执行
 *   - CONFIRM 指令必须先发令牌、不执行；确认后才执行
 *   - 令牌一次性 / 跨用户隔离
 *   - 速率限制生效
 *   - 控制指令正常工作
 *   - 超过阈值的结果落盘为文件
 *
 * 用法: bin\node.cmd tests\pipeline.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/main.js';

let passed = 0;
let failed = 0;
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
    console.log(`    ${e.message.split('\n')[0]}`);
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-bridge-pipeline-'));

/** 构造一个测试用 Bridge，mock 掉 bot 与任务执行。 */
function makeBridge(overrides = {}) {
  const config = {
    dsh: {
      cliPath: 'C:\\nonexistent\\dsh.cmd',
      mode: 'headless',
      workspace: sandbox,
      timeoutMs: 5000,
      persistSession: true,
    },
    security: {
      allowedOpenIds: ['USER-OK'],
      notifyUnauthorized: false,
      rateLimit: { perUserPerMinute: 3, perUserPerHour: 10, globalPerMinute: 100 },
      confirmTtlMs: 300_000,
      policyEnabled: true,
    },
    output: {
      maxMessageChars: 400,
      fileThresholdChars: 800,
      artifactDir: '.dsh-artifacts',
      sendFileWhenLarge: true,
    },
    logging: { dir: join(sandbox, 'logs'), retainDays: 1, level: 'info' },
    qq: { allowGroup: false },
    ...overrides,
  };

  const bridge = new Bridge({
    config,
    credentials: { appId: '123456789', appSecret: 'test-secret' },
    sources: { configFile: null, credsFile: null, appIdFrom: 'test', appSecretFrom: 'test' },
    // 启动环境探针：测试里不要真去写用户的 %USERPROFILE%\.dsh。
    // （真实实现在 src/dsh/launch-context.js，单测见 events.test.js）
    dshHomeProbe: () => ({ ok: true, dir: join(sandbox, '.dsh', 'profiles'), error: null }),
  });

  // 审计不要污染测试输出
  bridge.audit.toConsole = false;

  // mock 发送：记录所有回送文本与按钮/交互回应
  bridge.sent = [];
  bridge.keyboards = [];   // 记录发出的按钮面板
  bridge.acks = [];        // 记录 acknowledgeInteraction 调用
  bridge.failKeyboard = false; // 置 true 可模拟"按钮发送失败"
  bridge.bot = {
    sendText: async (target, text) => {
      bridge.sent.push({ target: String(target?.targetId), text });
    },
    sendTextWithKeyboard: async (target, text, keyboard) => {
      if (bridge.failKeyboard) throw new Error('模拟：无按钮权限');
      bridge.keyboards.push({ target: String(target?.targetId), text, keyboard });
      // 带按钮的消息也计为一次发送，便于断言"用户收到了提示"
      bridge.sent.push({ target: String(target?.targetId), text, viaKeyboard: true });
    },
    acknowledgeInteraction: async (id, code, data) => {
      bridge.acks.push({ id, code, data });
    },
  };

  // mock 任务执行：记录被执行的指令，返回可控结果
  bridge.executed = [];
  bridge.nextResult = {
    ok: true, text: '（模拟结果）', sessionId: 'session-test-1',
    exitCode: 0, timedOut: false, killed: false, turns: 1, steps: 1,
    durationMs: 10, errorMessage: null, errorCode: null, missingCredential: false,
  };
  bridge.executeTask = async function (task, target, userId, opts = {}) {
    bridge.executed.push({ task, userId, skipPolicy: !!opts.skipPolicy, imagePaths: opts.imagePaths ?? [] });
    const result = { ...bridge.nextResult };

    // 会话记录（真实 executeTask 也这么做）
    if (result.sessionId && this.config.dsh.persistSession) {
      this.sessions.set(userId, result.sessionId);
    }

    // 回送逻辑：直接调用生产模块，避免测试复刻一份会漂移的实现。
    // （此前这里手写了一遍落盘+摘要，模块替换后立刻失效——正是这种漂移。）
    const { describeResult } = await import('../src/dsh/events.js');
    const { sendArtifact } = await import('../src/output/artifacts.js');
    const { summarizeForChat } = await import('../src/output/chunk.js');
    const { resolve } = await import('node:path');

    await sendArtifact(describeResult(result), task, {
      bot: this.bot,
      target,
      sendText: (text) => this.sendText(target, text),
      dir: resolve(this.config.dsh.workspace, this.config.output.artifactDir),
      thresholdChars: this.config.output.fileThresholdChars,
      sendFileWhenLarge: this.config.output.sendFileWhenLarge,
      summarize: summarizeForChat,
      log: () => {},
    });
  };

  return bridge;
}

/** 构造一条入站消息。 */
function msg(userId, content, scope = 'c2c') {
  return {
    replyTarget: { scope, targetId: userId, msgId: 'm1' },
    content,
  };
}

const lastText = (b) => b.sent.at(-1)?.text ?? '';
const allText = (b) => b.sent.map((s) => s.text).join('\n');

/**
 * 从最近一次审批提示中取出令牌。
 *
 * 审批现在有两条投递路径：
 *   - 按钮：令牌编码在 keyboard 的 button_data 里（apv:TOKEN）
 *   - 文本回退：令牌出现在正文「确认 TOKEN」中
 * 测试必须两条都能取到，否则一旦按钮路径生效，用例就会假失败。
 */
function lastToken(b) {
  const kb = b.keyboards.at(-1);
  if (kb) {
    for (const row of kb.keyboard?.content?.rows ?? []) {
      for (const btn of row.buttons ?? []) {
        const m = /^apv:([A-Z2-9]{6})$/.exec(String(btn?.action?.data ?? ''));
        if (m) return m[1];
      }
    }
  }
  const m = /确认\s*([A-Z2-9]{6})/.exec(allText(b));
  return m ? m[1] : null;
}

/** 构造一个按钮点击事件。 */
function buttonEvent(userId, token, action = 'approve') {
  return {
    id: `interaction-${Math.random().toString(36).slice(2, 8)}`,
    type: 11,
    user_openid: userId,
    version: 1,
    data: {
      type: 0,
      resolved: {
        button_data: `${action === 'approve' ? 'apv' : 'dny'}:${token}`,
        user_id: userId,
      },
    },
  };
}

console.log('\n=== 白名单（安全第一道防线）===');

await test('未授权用户：不回复、不执行（静默丢弃）', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-EVIL', '帮我看看磁盘空间'));
  assert.equal(b.sent.length, 0, '不应有任何回复');
  assert.equal(b.executed.length, 0, '不应执行任何任务');
});

await test('未授权用户发危险指令也不执行', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-EVIL', 'rm -rf /'));
  assert.equal(b.executed.length, 0);
  assert.equal(b.sent.length, 0);
});

await test('未授权用户也不能用控制指令探测存在', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-EVIL', '/help'));
  assert.equal(b.sent.length, 0, '/help 也不应回复未授权用户');
});

await test('notifyUnauthorized=true 时给出明确拒绝', async () => {
  const b = makeBridge({
    security: {
      allowedOpenIds: ['USER-OK'], notifyUnauthorized: true,
      rateLimit: { perUserPerMinute: 3, perUserPerHour: 10, globalPerMinute: 100 },
      confirmTtlMs: 300_000, policyEnabled: true,
    },
  });
  await b.onMessage(null, msg('USER-EVIL', 'hi'));
  assert.match(lastText(b), /未授权/);
  assert.equal(b.executed.length, 0);
});

await test('授权用户正常通过', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '帮我看看 D 盘剩余空间'));
  assert.ok(b.sent.length > 0, '应收到回复');
  assert.equal(b.executed.length, 1, '应执行一次');
  assert.equal(b.executed[0].task, '帮我看看 D 盘剩余空间');
});

console.log('\n=== 策略分级 ===');

await test('BLOCK 指令：拒绝且不执行', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', 'rm -rf /'));
  assert.match(lastText(b), /拦截/);
  assert.equal(b.executed.length, 0, 'BLOCK 绝不应执行');
});

await test('BLOCK 指令：提权也被拒绝', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', 'runas /user:Administrator cmd'));
  assert.match(lastText(b), /拦截/);
  assert.equal(b.executed.length, 0);
});

await test('CONFIRM 指令：先发令牌，不执行', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  assert.match(lastText(b), /需要你确认|确认/);
  assert.equal(b.executed.length, 0, '确认前不应执行');
});

await test('CONFIRM 令牌可用，确认后才执行', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));

  const token = lastToken(b);
  assert.ok(token, `未取到令牌: ${lastText(b)}`);

  await b.onMessage(null, msg('USER-OK', `确认 ${token}`));
  assert.equal(b.executed.length, 1, '确认后应执行一次');
  assert.equal(b.executed[0].task, '删除所有日志文件');
  assert.equal(b.executed[0].skipPolicy, true, '确认后应跳过策略重复检查');
});

await test('令牌一次性：二次确认失败', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);
  assert.ok(token, '未取到令牌');

  await b.onMessage(null, msg('USER-OK', `确认 ${token}`));
  assert.equal(b.executed.length, 1);

  await b.onMessage(null, msg('USER-OK', `确认 ${token}`));
  assert.equal(b.executed.length, 1, '同一令牌不应触发第二次执行');
  assert.match(allText(b), /失败|过期/);
});

await test('跨用户确认被拒绝', async () => {
  const b = makeBridge({
    security: {
      allowedOpenIds: ['USER-OK', 'USER-OTHER'], notifyUnauthorized: false,
      rateLimit: { perUserPerMinute: 3, perUserPerHour: 10, globalPerMinute: 100 },
      confirmTtlMs: 300_000, policyEnabled: true,
    },
  });
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);
  assert.ok(token, '未取到令牌');
  b.sent.length = 0;

  await b.onMessage(null, msg('USER-OTHER', `确认 ${token}`));
  assert.equal(b.executed.length, 0, '他人令牌不应能确认');
  assert.match(lastText(b), /失败|过期/);
});

await test('无效令牌给出友好提示', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '确认 ZZZZZZ'));
  assert.match(lastText(b), /失败|过期/);
  assert.equal(b.executed.length, 0);
});

await test('SAFE 指令直接执行，不需要确认', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '统计这个项目有多少行代码'));
  assert.equal(b.executed.length, 1);
  assert.equal(b.executed[0].skipPolicy, false);
});

console.log('\n=== 按钮审批（interaction 事件）===');

await test('CONFIRM 优先发按钮而非纯文本', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  assert.equal(b.keyboards.length, 1, '应发出一个按钮面板');
  assert.equal(b.executed.length, 0, '确认前不应执行');
});

await test('按钮面板含允许与拒绝两个按钮', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const buttons = b.keyboards[0].keyboard.content.rows[0].buttons;
  assert.equal(buttons.length, 2);
  assert.ok(buttons.some((x) => x.action.data.startsWith('apv:')));
  assert.ok(buttons.some((x) => x.action.data.startsWith('dny:')));
});

await test('点击「允许」后执行任务', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);

  await b.onInteraction(null, buttonEvent('USER-OK', token, 'approve'));
  assert.equal(b.executed.length, 1, '点击允许后应执行');
  assert.equal(b.executed[0].task, '删除所有日志文件');
  assert.equal(b.executed[0].skipPolicy, true);
});

await test('点击「拒绝」后不执行，且令牌被作废', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);

  await b.onInteraction(null, buttonEvent('USER-OK', token, 'deny'));
  assert.equal(b.executed.length, 0, '拒绝后不应执行');

  // 令牌必须已被消费 —— 再走文本路径也不能生效
  await b.onMessage(null, msg('USER-OK', `确认 ${token}`));
  assert.equal(b.executed.length, 0, '拒绝后令牌不应还能用');
});

await test('他人按钮不能确认（跨用户）', async () => {
  const b = makeBridge({
    security: {
      allowedOpenIds: ['USER-OK', 'USER-OTHER'], notifyUnauthorized: false,
      rateLimit: { perUserPerMinute: 3, perUserPerHour: 10, globalPerMinute: 100 },
      confirmTtlMs: 300_000, policyEnabled: true,
    },
  });
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);

  await b.onInteraction(null, buttonEvent('USER-OTHER', token, 'approve'));
  assert.equal(b.executed.length, 0, '他人点击不应执行');

  await b.onInteraction(null, buttonEvent('USER-OK', token, 'approve'));
  assert.equal(b.executed.length, 1, '原主人点击仍应执行（未被误消费）');
});

await test('未授权用户点击按钮无效', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);

  await b.onInteraction(null, buttonEvent('USER-EVIL', token, 'approve'));
  assert.equal(b.executed.length, 0);
});

await test('令牌一次性：同一点击重放无效', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);
  const ev = buttonEvent('USER-OK', token, 'approve');

  await b.onInteraction(null, ev);
  assert.equal(b.executed.length, 1);
  await b.onInteraction(null, ev);
  assert.equal(b.executed.length, 1, '重放同一点击不应再次执行');
});

console.log('\n=== 按钮数据不可信输入 ===');

await test('畸形 button_data 被拒绝且不执行', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));

  for (const bad of ['', 'garbage', 'apv:', 'apv:XX', 'evil:ABC234', 'apv:ABC234; rm -rf /']) {
    const ev = buttonEvent('USER-OK', 'ABC234');
    ev.data.resolved.button_data = bad;
    await b.onInteraction(null, ev);
  }
  assert.equal(b.executed.length, 0, '任何畸形按钮数据都不得导致执行');
});

await test('缺少用户标识的点击被拒绝', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);

  const ev = buttonEvent('USER-OK', token, 'approve');
  // 抹掉所有可能的用户标识字段
  delete ev.user_openid;
  delete ev.group_member_openid;
  delete ev.data.resolved.user_id;

  await b.onInteraction(null, ev);
  assert.equal(b.executed.length, 0, '无法校验归属时必须拒绝');
});

await test('无论允许或拒绝都会 acknowledge', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  const token = lastToken(b);
  await b.onInteraction(null, buttonEvent('USER-OK', token, 'approve'));
  assert.ok(b.acks.length >= 1, '应调用 acknowledgeInteraction');
});

console.log('\n=== 按钮不可用时的文本回退 ===');

await test('按钮发送失败时回退为纯文本，且审批仍可用', async () => {
  const b = makeBridge();
  b.failKeyboard = true;

  await b.onMessage(null, msg('USER-OK', '删除所有日志文件'));
  assert.equal(b.keyboards.length, 0, '按钮未发出');
  assert.match(allText(b), /确认\s*[A-Z2-9]{6}/, '应回退为含令牌的文本');

  // 文本路径仍能完成确认
  const token = lastToken(b);
  assert.ok(token, '回退文本里应能取到令牌');
  await b.onMessage(null, msg('USER-OK', `确认 ${token}`));
  assert.equal(b.executed.length, 1, '文本回退路径应能执行');
});

console.log('\n=== 速率限制 ===');

await test('超过每分钟上限后被拒绝', async () => {
  const b = makeBridge(); // perUserPerMinute = 3
  for (let i = 0; i < 3; i++) {
    await b.onMessage(null, msg('USER-OK', `查看磁盘空间 ${i}`));
  }
  const before = b.executed.length;
  assert.equal(before, 3, '前 3 次应放行');

  await b.onMessage(null, msg('USER-OK', '查看磁盘空间 again'));
  assert.equal(b.executed.length, before, '超限不应执行');
  assert.match(lastText(b), /频繁/);
});

await test('限流不跨用户影响', async () => {
  const b = makeBridge({
    security: {
      allowedOpenIds: ['USER-OK', 'USER-OTHER'], notifyUnauthorized: false,
      rateLimit: { perUserPerMinute: 2, perUserPerHour: 10, globalPerMinute: 100 },
      confirmTtlMs: 300_000, policyEnabled: true,
    },
  });
  for (let i = 0; i < 3; i++) await b.onMessage(null, msg('USER-OK', `查看磁盘 ${i}`));
  const okCount = b.executed.length;

  await b.onMessage(null, msg('USER-OTHER', '查看磁盘'));
  assert.equal(b.executed.length, okCount + 1, '另一用户不应被牵连');
});

console.log('\n=== 控制指令 ===');

await test('/help 返回帮助', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '/help'));
  assert.match(allText(b), /指令|安全/);
  assert.equal(b.executed.length, 0);
});

await test('/status 返回状态且不执行任务', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '/status'));
  assert.match(allText(b), /服务状态/);
  assert.equal(b.executed.length, 0);
});

await test('/new 清空会话', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '查看磁盘'));
  assert.ok(b.sessions.get('USER-OK'), '应先有会话');

  await b.onMessage(null, msg('USER-OK', '/new'));
  assert.equal(b.sessions.get('USER-OK'), null, '会话应被清空');
  assert.match(allText(b), /新会话/);
});

console.log('\n=== persistSession=false：每条指令都是全新上下文（本机当前配置）===');

/**
 * 关掉会话接续的桥接。
 * 注意 makeBridge 的 overrides 是整段替换，所以 dsh 段要写全。
 */
function makeNoPersistBridge() {
  return makeBridge({
    dsh: {
      cliPath: 'C:\\nonexistent\\dsh.cmd',
      mode: 'headless',
      workspace: sandbox,
      timeoutMs: 5000,
      persistSession: false,
    },
  });
}

await test('/status 明示已禁用接续（不再显示会话 id）', async () => {
  const b = makeNoPersistBridge();
  // 先制造一个"本应有会话"的场景：mock 的 executeTask 会遵循 persistSession
  await b.onMessage(null, msg('USER-OK', '查看磁盘'));
  assert.equal(b.sessions.get('USER-OK'), null, '关闭接续后不得记录会话');

  await b.onMessage(null, msg('USER-OK', '/status'));
  assert.match(allText(b), /已禁用接续/);
  assert.doesNotMatch(allText(b), /session-test-1/, '状态里不应出现会话 id');
});

await test('/help 说明 /new 在关闭接续时无需使用', async () => {
  const b = makeNoPersistBridge();
  await b.onMessage(null, msg('USER-OK', '/help'));
  assert.match(allText(b), /无需使用/);
});

await test('/new 在关闭接续时仍可用且不报错', async () => {
  const b = makeNoPersistBridge();
  await b.onMessage(null, msg('USER-OK', '/new'));
  assert.match(allText(b), /新会话/);
  assert.equal(b.sessions.get('USER-OK'), null);
});

await test('/cancel 无任务时给出提示', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '/cancel'));
  assert.match(allText(b), /没有正在执行/);
});

await test('空消息给出引导', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '   '));
  assert.match(allText(b), /具体指令/);
  assert.equal(b.executed.length, 0);
});

console.log('\n=== 长期记忆（/remember、/memory）===');

/** 带独立记忆库目录的桥接（每个用例一个临时目录，互不干扰）。 */
function makeMemoryBridge() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-memory-'));
  return makeBridge({
    memory: { enabled: true, dir, file: 'MEMORY.md', maxInjectChars: 6000, maxFileChars: 200000 },
  });
}

await test('/remember 写入记忆库并确认（不起 DSH 任务）', async () => {
  const b = makeMemoryBridge();
  await b.onMessage(null, msg('USER-OK', '/remember 我的项目都在 D:\\work'));
  assert.match(allText(b), /已记入长期记忆/);
  assert.match(b.memory.read(), /我的项目都在 D:\\work/);
  assert.equal(b.executed.length, 0, '记忆指令是本地处理，不该起任务');
});

await test('/记住 中文别名同样可用', async () => {
  const b = makeMemoryBridge();
  await b.onMessage(null, msg('USER-OK', '/记住 不要动 C:\\Windows'));
  assert.match(b.memory.read(), /不要动 C:\\Windows/);
});

await test('/memory 显示条数与内容', async () => {
  const b = makeMemoryBridge();
  await b.onMessage(null, msg('USER-OK', '/remember 发文件时直接发，不要贴文字'));
  await b.onMessage(null, msg('USER-OK', '/memory'));
  const text = allText(b);
  assert.match(text, /长期记忆库/);
  assert.match(text, /发文件时直接发/);
  assert.match(text, /条数\s*:\s*1/);
});

await test('/remember 不带内容时给出用法', async () => {
  const b = makeMemoryBridge();
  await b.onMessage(null, msg('USER-OK', '/remember'));
  assert.match(allText(b), /用法/);
  assert.equal(b.memory.read(), '', '不该写入任何东西');
});

await test('记忆库为空时不注入任何东西（不撑大每一步的 prompt）', async () => {
  const b = makeMemoryBridge();
  assert.equal(b.memory.injectText(), '');
});

await test('记入之后就能注入（下一轮 agent 能看到）', async () => {
  const b = makeMemoryBridge();
  await b.onMessage(null, msg('USER-OK', '/remember 我的项目都在 D:\\work'));
  const injected = b.memory.injectText();
  assert.match(injected, /【长期记忆】/);
  assert.match(injected, /我的项目都在 D:\\work/);
});

console.log('\n=== 入站图片（QQ 直接发图）===');

/** 带图片落地目录 + 假下载器的桥接。 */
function makeImageBridge(fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-img-'));
  const b = makeBridge({
    qq: { allowGroup: false, imageDir: dir, maxImageBytes: 1024 * 1024, imageDownloadTimeoutMs: 5000 },
  });
  b.fetchImpl = fetchImpl;
  return b;
}

const okImageFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('IMGBYTES') });

await test('只发图片（没有文字）也能执行，并把本地路径交给任务', async () => {
  const b = makeImageBridge(okImageFetch);
  await b.onMessage(null, {
    replyTarget: { scope: 'c2c', targetId: 'USER-OK', msgId: 'm1' },
    content: '',
    attachments: [{ content_type: 'image/png', url: 'https://x/a.png' }],
  });

  assert.equal(b.executed.length, 1, '图片消息必须起任务（此前会被当空消息拒掉）');
  assert.match(b.executed[0].task, /图片/, '应给出默认意图');
  assert.equal(b.executed[0].imagePaths.length, 1);
  assert.match(b.executed[0].imagePaths[0], /\.png$/);
  assert.ok(existsSync(b.executed[0].imagePaths[0]), '图片应真的落盘');
});

await test('图片 + 文字：文字仍是任务，图片路径一并带上', async () => {
  const b = makeImageBridge(okImageFetch);
  await b.onMessage(null, {
    replyTarget: { scope: 'c2c', targetId: 'USER-OK', msgId: 'm1' },
    content: '这张图里有什么？',
    attachments: [{ content_type: 'image/jpeg', url: 'https://x/a.jpg' }],
  });
  assert.equal(b.executed[0].task, '这张图里有什么？');
  assert.equal(b.executed[0].imagePaths.length, 1);
  assert.match(b.executed[0].imagePaths[0], /\.jpg$/);
});

await test('图片下载失败：明确告知，不起任务', async () => {
  const b = makeImageBridge(async () => ({ ok: false, status: 403, arrayBuffer: async () => Buffer.alloc(0) }));
  await b.onMessage(null, {
    replyTarget: { scope: 'c2c', targetId: 'USER-OK', msgId: 'm1' },
    content: '',
    attachments: [{ content_type: 'image/png', url: 'https://x/a.png' }],
  });
  assert.equal(b.executed.length, 0);
  assert.match(allText(b), /没能保存|无法识别/);
});

await test('非图片附件（语音/文件）不触发下载，也不影响文字任务', async () => {
  let called = 0;
  const b = makeImageBridge(async () => { called++; return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(0) }; });
  await b.onMessage(null, {
    replyTarget: { scope: 'c2c', targetId: 'USER-OK', msgId: 'm1' },
    content: '看看这个文件',
    attachments: [{ content_type: 'application/pdf', url: 'https://x/a.pdf' }],
  });
  assert.equal(called, 0, '非图片不该去下载');
  assert.equal(b.executed[0].imagePaths.length, 0);
  assert.equal(b.executed[0].task, '看看这个文件');
});

console.log('\n=== 群聊门控 ===');
await test('默认不响应群聊', async () => {
  const b = makeBridge();
  await b.onMessage(null, msg('USER-OK', '查看磁盘', 'group'));
  assert.equal(b.sent.length, 0);
  assert.equal(b.executed.length, 0);
});

console.log('\n=== 长输出落盘 ===');

await test('超阈值结果落盘并回复路径', async () => {
  const b = makeBridge();
  b.nextResult.text = 'A'.repeat(2000); // 超过 fileThresholdChars=800
  await b.onMessage(null, msg('USER-OK', '分析日志'));

  const joined = allText(b);
  assert.match(joined, /完整结果|📄/, '应提示已落盘');

  const artDir = join(sandbox, '.dsh-artifacts');
  assert.ok(existsSync(artDir), '落盘目录应存在');
  const files = readdirSync(artDir);
  assert.ok(files.length > 0, `落盘目录应有文件，实得 ${files.length}`);
});

await test('短结果直接回复不落盘', async () => {
  const b = makeBridge();
  b.nextResult.text = '磁盘剩余 100GB';
  const before = existsSync(join(sandbox, '.dsh-artifacts'))
    ? readdirSync(join(sandbox, '.dsh-artifacts')).length : 0;

  await b.onMessage(null, msg('USER-OK', '查看磁盘'));
  const after = existsSync(join(sandbox, '.dsh-artifacts'))
    ? readdirSync(join(sandbox, '.dsh-artifacts')).length : 0;

  assert.equal(after, before, '短结果不应新增落盘文件');
  assert.match(allText(b), /100GB/);
});

console.log('\n=== 自检与配置 ===');

await test('selfCheck 在空白名单时给出显著告警', async () => {
  const b = makeBridge({
    security: {
      allowedOpenIds: [], notifyUnauthorized: false,
      rateLimit: { perUserPerMinute: 3, perUserPerHour: 10, globalPerMinute: 100 },
      confirmTtlMs: 300_000, policyEnabled: true,
    },
  });
  const report = b.selfCheck();
  assert.match(report, /白名单/);
  assert.match(report, /拒绝所有人/, '空白名单必须有明确告警');
});

await test('selfCheck 报告关键配置项', async () => {
  const b = makeBridge();
  const report = b.selfCheck();
  assert.match(report, /工作区/);
  assert.match(report, /DSH 调用/);
  assert.match(report, /审计日志/);
  assert.match(report, /策略引擎/);
  assert.match(report, /USER-OK/, '应列出白名单成员');
});

await test('selfCheck 在走 cmd.exe 兜底时必须显著告警', async () => {
  // makeBridge 故意不配 nodeExe/jsEntry —— 那是存在命令注入风险的路径。
  // 自检必须在最显眼的位置说出来，而不是让人以为一切正常。
  const b = makeBridge();
  const report = b.selfCheck();
  assert.match(report, /cmd\.exe/, '应说明当前经 cmd.exe');
  assert.match(report, /注入/, '应点明注入风险');
  assert.match(report, /nodeExe/, '应给出修复建议');
});

await test('selfCheck 配置了直接 Node 调用时不告警', async () => {
  const b = makeBridge({
    dsh: {
      cliPath: 'C:\\nonexistent\\dsh.cmd',
      nodeExe: 'C:\\node.exe',
      jsEntry: 'C:\\entry.js',
      mode: 'headless',
      workspace: sandbox,
      timeoutMs: 5000,
      persistSession: true,
    },
  });
  const report = b.selfCheck();
  assert.match(report, /直接 Node/, '应说明走的是安全路径');
  assert.ok(!/存在命令注入风险/.test(report), '安全路径不应出现注入告警');
});

await test('selfCheck 不回显 AppSecret', async () => {
  const b = makeBridge();
  const report = b.selfCheck();
  assert.ok(!report.includes('test-secret'), '自检报告绝不能包含明文密钥');
});

console.log('\n=== 收尾 ===');

await test('清理临时目录', async () => {
  rmSync(sandbox, { recursive: true, force: true });
  assert.ok(!existsSync(sandbox));
});

console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log('\n失败明细:');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.error}`);
}
console.log('='.repeat(56) + '\n');

process.exit(failed === 0 ? 0 : 1);
