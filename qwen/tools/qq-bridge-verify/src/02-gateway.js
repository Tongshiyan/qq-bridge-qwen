#!/usr/bin/env node
/**
 * 步骤 2：验证 Gateway 连接 + intents 权限
 *
 * 这一步会真实建立 WebSocket 连接、发送 Identify 鉴权帧，
 * 并根据服务端反应判定 intents 权限是否可用。
 *
 * 为什么这样能验证权限：
 *   官方文档明确说明 —— Identify 时若携带无权限的 intents，
 *   服务端会「报错并直接关闭连接」。所以：
 *     连上并收到 READY      => 该 intents 有权限 ✅
 *     被立即关闭 / Invalid  => 该 intents 无权限 ❌
 *
 * 用法:
 *   bin\node.cmd src\02-gateway.js <AppID> <AppSecret> [mode]
 *
 * mode:
 *   target    只测目标 intents 33554432 (GROUP_AND_C2C_EVENT) —— 默认
 *   baseline  只测 1<<30 (PUBLIC_GUILD_MESSAGES，官方称默认有权限)，作为对照组
 *   zero      只测 intents=0，用于确认「能连上」这件事本身
 *   all       依次测全部三种，用对照组推导结论
 *
 * ⚠️ 每次运行会消耗网关连接配额（默认总量 1000 次 / 24 小时），请勿反复运行。
 */

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const GATEWAY_URL = 'https://api.bot.qq.com/gateway';

// intents 位定义（来自官方文档）
const INTENTS = {
  GUILDS: 1 << 0,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  GROUP_AND_C2C_EVENT: 1 << 25,
};

const MODES = {
  target: [{ label: '目标: GROUP_AND_C2C_EVENT (单聊/群聊消息)', value: INTENTS.GROUP_AND_C2C_EVENT }],
  baseline: [{ label: '对照: PUBLIC_GUILD_MESSAGES (官方称默认有权限)', value: INTENTS.PUBLIC_GUILD_MESSAGES }],
  zero: [{ label: '对照: intents=0 (不带任何订阅)', value: 0 }],
  all: [
    { label: '对照: intents=0 (不带任何订阅)', value: 0 },
    { label: '对照: PUBLIC_GUILD_MESSAGES (官方称默认有权限)', value: INTENTS.PUBLIC_GUILD_MESSAGES },
    { label: '目标: GROUP_AND_C2C_EVENT (单聊/群聊消息)', value: INTENTS.GROUP_AND_C2C_EVENT },
  ],
};

function mask(s) {
  if (!s) return '(空)';
  if (s.length <= 8) return s[0] + '***';
  return s.slice(0, 4) + '***' + s.slice(-2);
}
function line() { console.log('-'.repeat(64)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- token

async function getToken(appId, appSecret) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (res.status !== 200 || !data?.access_token) {
    throw new Error(`获取 AccessToken 失败 (HTTP ${res.status}): ${text}`);
  }
  return data.access_token;
}

async function getGatewayUrl(token) {
  const res = await fetch(GATEWAY_URL, {
    headers: { Authorization: `QQBot ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (res.status !== 200 || !data?.url) {
    throw new Error(`获取网关地址失败 (HTTP ${res.status}): ${text}`);
  }
  return data.url;
}

// ---------------------------------------------------------------- 单次 intents 探测

/**
 * 结果判定：
 *   'OK'         收到 READY / RESUMED
 *   'CLOSED'     连接被服务端关闭（含关闭码，据此推断原因）
 *   'TIMEOUT'    超时无响应
 *   'ERROR'      连接层错误
 */
function probeIntents(gatewayUrl, token, intents, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const result = {
      verdict: 'ERROR',
      closeCode: null,
      closeReason: '',
      ready: null,
      helloTaken: false,
      events: [],
      error: null,
      raw: [],
    };

    let ws;
    let finished = false;
    let heartbeatTimer = null;
    let lastSeq = null;

    const done = (verdict) => {
      if (finished) return;
      finished = true;
      result.verdict = verdict;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try { ws && ws.close(1000, 'probe done'); } catch { /* ignore */ }
      clearTimeout(guard);
      resolve(result);
    };

    const guard = setTimeout(() => done('TIMEOUT'), timeoutMs);

    try {
      ws = new WebSocket(gatewayUrl);
    } catch (e) {
      result.error = `WebSocket 构造失败: ${e.message}`;
      return done('ERROR');
    }

    ws.addEventListener('open', () => {
      result.raw.push('WS 已连接，等待 Hello(op 10)…');
    });

    ws.addEventListener('message', (ev) => {
      let pkt;
      try { pkt = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
      catch { result.raw.push(`无法解析的帧: ${String(ev.data).slice(0, 200)}`); return; }

      if (pkt.s != null) lastSeq = pkt.s;
      const brief = pkt.t ? `op=${pkt.op} t=${pkt.t} s=${pkt.s}` : `op=${pkt.op}`;
      result.raw.push(brief);

      switch (pkt.op) {
        case 10: { // Hello -> 发 Identify
          result.helloTaken = true;
          const hb = pkt.d?.heartbeat_interval ?? 45000;
          result.raw.push(`Hello: heartbeat_interval=${hb}ms`);

          const identify = {
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents,
              shard: [0, 1],
              properties: { $os: 'windows', $browser: 'dsh-bridge-verify', $device: 'dsh-bridge-verify' },
            },
          };
          ws.send(JSON.stringify(identify));
          result.raw.push(`已发送 Identify (intents=${intents})`);

          // 保持心跳，避免被判定为死连接
          heartbeatTimer = setInterval(() => {
            try { ws.send(JSON.stringify({ op: 1, d: lastSeq })); } catch { /* ignore */ }
          }, Math.max(5000, hb - 3000));
          break;
        }
        case 0: // Dispatch
          if (pkt.t === 'READY' || pkt.t === 'RESUMED') {
            result.ready = {
              session_id: pkt.d?.session_id ?? null,
              bot_id: pkt.d?.user?.id ?? null,
              bot_name: pkt.d?.user?.username ?? null,
              shard: pkt.d?.shard ?? null,
            };
            // 收到 READY 即证明 intents 被接受
            setTimeout(() => done('OK'), 400);
          }
          break;
        case 7: // Reconnect
          result.raw.push('服务端要求重连 (op 7)');
          break;
        case 9: // Invalid Session
          result.raw.push('❌ 收到 Invalid Session (op 9)');
          setTimeout(() => done('CLOSED'), 300);
          break;
        case 11: // Heartbeat ACK
          break;
        default:
          result.raw.push(`未处理 op=${pkt.op}: ${JSON.stringify(pkt).slice(0, 200)}`);
      }
    });

    ws.addEventListener('close', (ev) => {
      result.closeCode = ev.code;
      result.closeReason = ev.reason || '';
      result.raw.push(`WS 关闭 code=${ev.code} reason="${ev.reason || ''}"`);
      if (!finished) done('CLOSED');
    });

    ws.addEventListener('error', () => {
      result.raw.push('WS error 事件（详情见 close 事件）');
      if (!finished) {
        // error 通常紧跟 close，给 close 一点时间
        setTimeout(() => { if (!finished) done('ERROR'); }, 500);
      }
    });
  });
}

// ---------------------------------------------------------------- 关闭码解读

function explainClose(code, reason, intents) {
  const r = reason ? ` ("${reason}")` : '';
  switch (code) {
    case 4004:
      return `鉴权失败：AccessToken 无效或格式错误${r}。检查 token 是否用 "QQBot " 前缀、是否已过期。`;
    case 4006:
      return `会话无效：session_id / seq 不正确${r}。首次连接不该出现，除非 Resume 参数有误。`;
    case 4007:
      return `seq 序号错误${r}。`;
    case 4008:
      return `发送过于频繁，被限流${r}。稍等再试。`;
    case 4009:
      return `连接超时未鉴权${r}。`;
    case 4013:
      return `❌ intents 无效：包含无权限的事件订阅${r}。` +
        `\n     → 这就是「权限没批下来」的信号。请在 QQ 开放平台管理端申请对应事件权限。`;
    case 4014:
      return `❌ intents 被拒绝：订阅了未获批的事件类型${r}。` +
        `\n     → 同上，需要先在管理端申请权限。`;
    case 4900:
      return `内部错误${r}。`;
    case 4914:
      return `机器人已下架，请先在开放平台处理${r}。`;
    case 4915:
      return `机器人被封禁${r}。`;
    case 1000:
    case 1001:
      return `正常关闭${r}（通常是本脚本主动关闭）。`;
    default:
      if (code >= 4000 && code < 5000) {
        return `鉴权/权限类错误 code=${code}${r}。` +
          `\n     → 结合对照测试判断是否为 intents 权限问题。`;
      }
      return `非预期关闭 code=${code}${r}。`;
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const appId = process.argv[2] || process.env.QQ_APP_ID;
  const appSecret = process.argv[3] || process.env.QQ_APP_SECRET;
  const mode = (process.argv[4] || 'target').toLowerCase();

  console.log('\n===== 步骤 2: Gateway 连接 + intents 权限验证 =====\n');

  if (!appId || !appSecret) {
    console.log('❌ 缺少凭证。');
    console.log('\n用法: bin\\node.cmd src\\02-gateway.js <AppID> <AppSecret> [target|baseline|zero|all]\n');
    process.exit(2);
  }

  const plan = MODES[mode];
  if (!plan) {
    console.log(`❌ 未知 mode: "${mode}"。可选: ${Object.keys(MODES).join(' | ')}\n`);
    process.exit(2);
  }

  console.log(`AppID : ${mask(appId)}`);
  console.log(`Mode  : ${mode}  (将测试 ${plan.length} 个 intents 值)`);
  console.log('⚠️  每次连接会消耗网关配额，勿反复运行。');
  line();

  // 1) token
  let token;
  try {
    token = await getToken(appId, appSecret);
    console.log(`✅ AccessToken 获取成功: ${mask(token)}`);
  } catch (e) {
    console.log(`❌ ${e.message}`);
    console.log('\n请先解决问题 1（凭证无效），再运行本步骤。\n');
    process.exit(1);
  }

  // 2) gateway url
  let gwUrl;
  try {
    gwUrl = await getGatewayUrl(token);
    console.log(`✅ 网关地址: ${gwUrl}`);
  } catch (e) {
    console.log(`❌ ${e.message}\n`);
    process.exit(1);
  }
  line();

  // 3) 逐个探测
  const results = [];
  for (let i = 0; i < plan.length; i++) {
    const { label, value } = plan[i];
    console.log(`\n▶ [${i + 1}/${plan.length}] ${label}`);
    console.log(`   intents = ${value}`);

    const r = await probeIntents(gwUrl, token, value);
    r.label = label;
    r.intents = value;
    results.push(r);

    console.log(`   判定: ${r.verdict}`);
    if (r.ready) {
      console.log(`   机器人: ${r.ready.bot_name} (id=${r.ready.bot_id})`);
      console.log(`   session_id: ${r.ready.session_id}`);
    }
    if (r.closeCode != null && r.closeCode !== 1000 && r.closeCode !== 1001) {
      console.log(`   ${explainClose(r.closeCode, r.closeReason, value)}`);
    }
    console.log(`   帧序列: ${r.raw.join(' | ')}`);

    if (i < plan.length - 1) {
      console.log('   (等待 3 秒后测试下一个…)');
      await sleep(3000);
    }
  }

  // 4) 结论
  console.log('\n' + '='.repeat(64));
  console.log('结论');
  console.log('='.repeat(64));

  const byValue = new Map(results.map((r) => [r.intents, r]));
  const target = byValue.get(INTENTS.GROUP_AND_C2C_EVENT);
  const baseline = byValue.get(INTENTS.PUBLIC_GUILD_MESSAGES);

  if (mode === 'target' && target) {
    if (target.verdict === 'OK') {
      console.log('✅ 目标 intents (33554432) 已被接受 —— 单聊消息权限可用。');
      console.log('   ➡️  可以开始阶段 1 的桥接服务开发。');
    } else if (target.verdict === 'CLOSED') {
      console.log('❌ 目标 intents (33554432) 被拒绝。');
      console.log('   ➡️  需在 QQ 开放平台管理端申请「群聊/单聊消息」事件权限。');
      console.log('   为确认不是别的问题，建议再跑一次: mode=baseline 做对照。');
    } else {
      console.log(`⚠️  目标 intents 结果不明确: ${target.verdict}`);
      console.log('   ➡️  建议跑 mode=all 获取完整对照。');
    }
  } else if (mode === 'all') {
    const zero = byValue.get(0);
    console.log('判定矩阵:');
    for (const r of results) {
      console.log(`  intents=${String(r.intents).padEnd(11)} → ${r.verdict}` +
        (r.closeCode != null ? ` (code=${r.closeCode})` : ''));
    }
    console.log('');
    if (zero && zero.verdict === 'OK' && target && target.verdict !== 'OK') {
      console.log('✅ 诊断: 连接链路正常，但目标 intents 被拒。');
      console.log('   → 这是纯粹的「权限未获批」问题，代码没有问题。');
      console.log('   → 唯一解法: 在开放平台管理端申请单聊/群聊消息事件权限。');
    } else if (zero && zero.verdict !== 'OK' && baseline && baseline.verdict !== 'OK') {
      console.log('❌ 诊断: 连最基础的连接都失败，问题在凭证或机器人状态，不是权限。');
    } else if (target && target.verdict === 'OK') {
      console.log('✅ 诊断: 目标 intents 可用，权限已就绪，可直接进入开发。');
    } else {
      console.log('⚠️  诊断: 结果不在常见模式内，请把上面完整输出留档再分析。');
    }
  } else if (baseline) {
    if (baseline.verdict === 'OK') {
      console.log('✅ 对照组 (1<<30) 成功 —— 说明凭证与连接链路都正常。');
      console.log('   这反过来支持「若 target 失败，则是权限问题」的结论。');
    } else {
      console.log(`⚠️  对照组 (1<<30) 也未成功 (${baseline.verdict})。`);
      console.log('   提示: 该事件对未上架的机器人也可能受限，不能作为绝对对照。');
    }
  } else if (byValue.get(0)) {
    const zero = byValue.get(0);
    if (zero.verdict === 'OK') {
      console.log('✅ intents=0 连接成功 —— 凭证、网络、网关链路全部正常。');
      console.log('   ➡️  下一步跑 mode=target 测试目标权限。');
    } else {
      console.log(`❌ intents=0 都失败 (${zero.verdict}) —— 问题不在权限。`);
      console.log('   ➡️  检查凭证、机器人状态（是否下架/封禁）、网络。');
    }
  }

  console.log('\n提示: 本次测试的完整输出建议存档，申请权限被拒时可作为排查依据。\n');
  process.exit(0);
}

main().catch((e) => {
  console.log(`\n❌ 未预期错误: ${e.stack || e.message}\n`);
  process.exit(1);
});
