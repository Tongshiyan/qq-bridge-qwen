#!/usr/bin/env node
/**
 * 步骤 1：验证 AppID / AppSecret，并获取 AccessToken
 *
 * 这一步验证的是「凭证有效性」，不涉及任何权限申请。
 * 只要 AppID/AppSecret 正确，就应该拿到 access_token。
 *
 * 用法:
 *   bin\node.cmd src\01-token.js <AppID> <AppSecret>
 *   或设置环境变量 QQ_APP_ID / QQ_APP_SECRET 后直接运行
 *
 * 关于凭证文件：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写入
 * UTF-8 BOM，JSON.parse 不接受 BOM，因此读取时统一先剥掉。
 */

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';

function mask(s) {
  if (!s) return '(空)';
  if (s.length <= 8) return s[0] + '***';
  return s.slice(0, 4) + '***' + s.slice(-2);
}

function line() { console.log('-'.repeat(60)); }

async function main() {
  const appId = process.argv[2] || process.env.QQ_APP_ID;
  const appSecret = process.argv[3] || process.env.QQ_APP_SECRET;

  console.log('\n===== 步骤 1: AccessToken 验证 =====\n');

  if (!appId || !appSecret) {
    console.log('❌ 缺少凭证。');
    console.log('\n用法:');
    console.log('  bin\\node.cmd src\\01-token.js <AppID> <AppSecret>');
    console.log('\n或先设置环境变量（当前会话）:');
    console.log('  $env:QQ_APP_ID="你的AppID"');
    console.log('  $env:QQ_APP_SECRET="你的AppSecret"');
    process.exit(2);
  }

  console.log(`AppID    : ${mask(appId)}`);
  console.log(`AppSecret: ${mask(appSecret)}`);
  console.log(`端点     : ${TOKEN_URL}`);
  line();

  const started = Date.now();
  let res, body;

  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
      signal: AbortSignal.timeout(20000),
    });
    body = await res.text();
  } catch (e) {
    console.log(`❌ 网络请求失败: ${e.name} - ${e.message}`);
    console.log('\n可能原因:');
    console.log('  - 网络不通 / 代理拦截 / 防火墙');
    console.log('  - DNS 解析失败');
    process.exit(1);
  }

  const ms = Date.now() - started;
  console.log(`HTTP ${res.status} ${res.statusText}  (${ms}ms)`);
  console.log(`响应: ${body}`);
  line();

  let data = null;
  try { data = JSON.parse(body); } catch { /* 非 JSON */ }

  // 判定
  if (res.status === 200 && data && data.access_token) {
    console.log('✅ 凭证有效，已成功获取 AccessToken');
    const exp = Number(data.expires_in) || 0;
    console.log(`   token     : ${mask(data.access_token)}`);
    console.log(`   有效期    : ${exp} 秒 (约 ${(exp / 3600).toFixed(1)} 小时)`);
    console.log(`   过期时刻  : ${new Date(Date.now() + exp * 1000).toLocaleString()}`);
    line();
    console.log('\n➡️  下一步: 运行 src\\02-gateway.js 验证网关与 intents 权限\n');
    process.exit(0);
  }

  console.log('❌ 未获取到 AccessToken');
  if (data && (data.code !== undefined || data.message)) {
    console.log(`   错误码  : ${data.code ?? '(无)'}`);
    console.log(`   错误信息: ${data.message ?? data.msg ?? '(无)'}`);
  }
  line();
  console.log('\n常见原因:');
  console.log('  - AppID 或 AppSecret 抄错 / 含多余空格');
  console.log('  - 机器人尚未在开放平台创建完成');
  console.log('  - AppSecret 已在管理端重置，本地是旧值');
  console.log('  - 请求体字段名错误（必须是 appId / clientSecret，注意大小写）\n');
  process.exit(1);
}

main().catch((e) => {
  console.log(`❌ 未预期错误: ${e.stack || e.message}`);
  process.exit(1);
});
