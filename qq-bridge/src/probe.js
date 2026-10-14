#!/usr/bin/env node
/**
 * SDK 能力探测（不接收消息，只验证连接与配置）
 *
 * 用途：在写桥接业务逻辑之前，确认：
 *   1. 官方 SDK 能否用你的凭证成功连接（token + gateway + identify）
 *   2. 机器人实际拿到了哪些事件权限
 *   3. 目标用户 openid 是多少（用于配置白名单！）
 *
 * 用法:
 *   bin\node.cmd src\probe.js            （从 config\creds.json 读凭证）
 *
 * ⚠️ 会消耗 1 次网关连接配额。跑完请按 Ctrl+C 退出。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const credsPath = join(root, 'config', 'creds.json');

function line() { console.log('-'.repeat(64)); }

// ---------------------------------------------------------- 凭证
if (!existsSync(credsPath)) {
  console.log('\n❌ 找不到 config\\creds.json');
  console.log('   请先把凭证写上，格式：');
  console.log('   { "appId": "你的数字AppID", "appSecret": "你的密钥" }\n');
  process.exit(2);
}

let creds;
try {
  // 注意：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写入 BOM，
  // 而 JSON.parse 不接受 BOM。这里先剥掉，避免用户手写配置时踩坑。
  const raw = readFileSync(credsPath, 'utf8').replace(/^\uFEFF/, '');
  creds = JSON.parse(raw);
} catch (e) {
  console.log(`\n❌ config\\creds.json 解析失败: ${e.message}\n`);
  process.exit(2);
}

if (!creds.appId || !creds.appSecret) {
  console.log('\n❌ creds.json 缺少 appId 或 appSecret\n');
  process.exit(2);
}

console.log('\n===== QQ Bot SDK 能力探测 =====\n');
console.log(`AppID     : ${creds.appId}`);
console.log(`AppSecret : ${String(creds.appSecret).slice(0, 4)}***${String(creds.appSecret).slice(-2)}`);
line();

// ---------------------------------------------------------- 载入 SDK
let QQBot, FULL_INTENTS;
try {
  ({ QQBot } = await import('@tencent-connect/qqbot-nodejs'));
  ({ FULL_INTENTS } = await import('@tencent-connect/qqbot-nodejs/protocol'));
} catch (e) {
  console.log(`❌ 载入 SDK 失败: ${e.message}`);
  console.log('   请在项目根目录运行: bin\\pnpm.cmd add @tencent-connect/qqbot-nodejs\n');
  process.exit(1);
}

// intents 位反解，用于报告权限来源
const INTENT_NAMES = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
};

function decodeIntents(mask) {
  return Object.entries(INTENT_NAMES)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name);
}

console.log(`SDK 默认 FULL_INTENTS = ${FULL_INTENTS}`);
console.log('包含的事件类别:');
for (const n of decodeIntents(FULL_INTENTS)) {
  console.log(`  - ${n}`);
}
line();

// ---------------------------------------------------------- 启动
const bot = new QQBot({
  appId: creds.appId,
  appSecret: creds.appSecret,
  // 不用 sync 预取，改为自己控制时报错点
  tokenPrefetch: 'sync',
  logger: {
    info: (m) => console.log(`  [info ] ${m}`),
    warn: (m) => console.log(`  [warn ] ${m}`),
    error: (m) => console.log(`  [error] ${m}`),
    debug: () => {},
  },
});

bot.on('ready', () => {
  console.log('');
  console.log('✅ 连接成功 (READY)');
  line();
  console.log('接下来请用手机 QQ 给机器人发一条任意消息（比如 "hi"）。');
  console.log('目的有两个：');
  console.log('  1. 确认消息能到达（验证事件权限真的可用）');
  console.log('  2. 拿到你的 openid —— 这是配白名单必须的值');
  console.log('');
  console.log('收到后我会打印 openid，然后你可以 Ctrl+C 退出。');
  line();
});

bot.on('message', async (ctx, msg) => {
  console.log('');
  console.log('📨 收到消息！');
  line();
  console.log(`  scope      : ${msg.replyTarget?.scope}`);
  console.log(`  targetId   : ${msg.replyTarget?.targetId}`);
  console.log(`  msgId      : ${msg.replyTarget?.msgId}`);
  console.log(`  content    : ${JSON.stringify(msg.content)}`);
  console.log('');
  console.log('  ── 你的白名单 openid 是 ──');
  console.log(`  ${msg.replyTarget?.targetId}`);
  line();

  // 回一条确认，顺便验证发送通路
  try {
    await bot.sendText(msg.replyTarget, '✅ SDK 探测成功，桥接通路正常。');
    console.log('  ✅ 已回复测试消息（发送通路也正常）');
  } catch (e) {
    console.log(`  ❌ 回复失败: ${e.message}`);
  }
  console.log('');
});

bot.on('interaction', async (ctx, event) => {
  console.log(`\n🔘 interaction 事件: ${JSON.stringify(event).slice(0, 300)}\n`);
});

bot.on('rawEvent', (ctx) => {
  console.log(`  [raw ] ${ctx.eventType}`);
});

// ---------------------------------------------------------- 启动并捕获错误
try {
  await bot.start();
} catch (e) {
  console.log('');
  console.log('❌ 启动失败');
  line();
  console.log(`  ${e.message}`);
  if (e.code) console.log(`  code: ${e.code}`);
  console.log('');
  console.log('对照排查：');
  console.log('  - "appid invalid" / 100007         → AppID 不对');
  console.log('  - 4013 / 4014 / intents 相关报错   → 事件权限未获批');
  console.log('  - token 相关错误                    → AppSecret 不对');
  console.log('');
  process.exit(1);
}
