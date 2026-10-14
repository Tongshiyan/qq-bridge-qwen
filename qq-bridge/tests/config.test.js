/**
 * 配置层单测：占位符识别
 *
 * 背景（真实踩到的坑）：
 *   config/config.json 是带中文说明的模板，里面的 allowedOpenIds 预置了
 *   占位符「在这里填入你的 openid」。用户很容易忘记替换就启动。
 *   更糟的是占位符让白名单"看起来非空"，从而掩盖掉"空白名单"告警 ——
 *   用户以为配好了，实际谁都进不来，且没有任何提示。
 *
 * 因此配置层必须主动识别并剔除占位符，让告警重新生效。
 *
 * 用法: bin\node.cmd tests\config.test.js
 */

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  sanitizeAllowedIds, mergeConfig, DEFAULTS, isInsideDirectory, checkSandboxTemp,
  readHeadlessSandboxMode, parsePermissionPatch,
} from '../src/config/index.js';

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

console.log('\n=== 占位符识别 ===');

test('中文占位符被识别并剔除', () => {
  const { real, placeholders } = sanitizeAllowedIds(['在这里填入你的 openid']);
  assert.deepEqual(real, []);
  assert.equal(placeholders.length, 1);
});

test('模板里的实际占位符原文必须命中', () => {
  // 与 config/config.json 中预置的字符串完全一致，防止模板改动后失配
  const { real } = sanitizeAllowedIds(['在这里填入你的 openid']);
  assert.equal(real.length, 0, '模板占位符必须被识别');
});

test('常见英文占位符被识别', () => {
  for (const p of ['your_openid', 'your-openid', 'YOUR OPENID', 'xxx', 'XXXXXX', 'TODO', 'CHANGEME', '<openid>']) {
    const { real } = sanitizeAllowedIds([p]);
    assert.equal(real.length, 0, `未识别占位符: ${p}`);
  }
});

test('真实 openid 形态不被误判', () => {
  // QQ 的 openid 是较长的十六进制/大写字母数字串
  const ids = [
    'A1B2C3D4E5F60718293A4B5C6D7E8F90',
    '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    '0123456789ABCDEF0123456789ABCDEF',
  ];
  const { real, placeholders } = sanitizeAllowedIds(ids);
  assert.equal(placeholders.length, 0, `真实 openid 不应被判为占位符: ${JSON.stringify(placeholders)}`);
  assert.equal(real.length, 3);
});

test('混合列表：只剔除占位符，保留真实值', () => {
  const { real, placeholders } = sanitizeAllowedIds([
    '在这里填入你的 openid',
    'A1B2C3D4E5F60718293A4B5C6D7E8F90',
    'TODO',
    '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  ]);
  assert.equal(real.length, 2, `应保留 2 个真实值，实得 ${JSON.stringify(real)}`);
  assert.equal(placeholders.length, 2);
  assert.ok(real.includes('A1B2C3D4E5F60718293A4B5C6D7E8F90'));
  assert.ok(real.includes('9f8e7d6c5b4a39281706f5e4d3c2b1a0'));
});

console.log('\n=== 边界与健壮性 ===');

test('空数组', () => {
  assert.deepEqual(sanitizeAllowedIds([]), { real: [], placeholders: [] });
});

test('非数组输入不抛异常', () => {
  assert.doesNotThrow(() => sanitizeAllowedIds(null));
  assert.doesNotThrow(() => sanitizeAllowedIds(undefined));
  assert.doesNotThrow(() => sanitizeAllowedIds('not-an-array'));
  assert.doesNotThrow(() => sanitizeAllowedIds(123));
  assert.doesNotThrow(() => sanitizeAllowedIds({}));
});

test('非数组输入返回空', () => {
  assert.deepEqual(sanitizeAllowedIds(null), { real: [], placeholders: [] });
  assert.deepEqual(sanitizeAllowedIds('abc'), { real: [], placeholders: [] });
});

test('空白项被丢弃（既不算真实值也不算占位符）', () => {
  const { real, placeholders } = sanitizeAllowedIds(['', '   ', '\t\n']);
  assert.deepEqual(real, []);
  assert.deepEqual(placeholders, []);
});

test('首尾空格被裁剪', () => {
  const { real } = sanitizeAllowedIds(['  A1B2C3D4E5F6  ']);
  assert.deepEqual(real, ['A1B2C3D4E5F6']);
});

test('数组中的非字符串项被安全处理', () => {
  const { real } = sanitizeAllowedIds([null, undefined, 12345, 'A1B2C3D4E5F6']);
  assert.deepEqual(real, ['12345', 'A1B2C3D4E5F6'], '数字应被字符串化而非崩溃');
});

test('重复项不被去重（保持配置原样，去重交给 Set）', () => {
  const { real } = sanitizeAllowedIds(['A1B2', 'A1B2']);
  assert.equal(real.length, 2);
});

console.log('\n=== 合并：部分配置不得丢默认值（关键）===');

test('只写 allowedOpenIds 时，security 其余默认值必须保留', () => {
  // 真实踩到的场景：用户 config.json 只写了一行
  //   { "security": { "allowedOpenIds": ["<openid>"] } }
  // 若合并写错（例如浅覆盖），rateLimit 会变成 undefined，
  // 速率限制静默失效 —— 而且不会有任何报错。
  const { config } = mergeConfig({ security: { allowedOpenIds: ['A1B2C3D4'] } });
  assert.equal(config.security.rateLimit.perUserPerMinute, 6, 'rateLimit 默认值必须保留');
  assert.equal(config.security.rateLimit.perUserPerHour, 60);
  assert.equal(config.security.rateLimit.globalPerMinute, 20);
  assert.equal(config.security.confirmTtlMs, 300000, 'confirmTtlMs 默认值必须保留');
  assert.equal(config.security.policyEnabled, true, 'policyEnabled 必须默认为 true（安全默认）');
});

test('未提及的顶层段全部保留默认值', () => {
  const { config } = mergeConfig({ security: { allowedOpenIds: [] } });
  // 默认硬超时 30 分钟（本地 27B + 长上下文慢，10 分钟实测不够用）
  assert.equal(config.dsh.timeoutMs, 1800000);
  assert.equal(config.dsh.idleTimeoutMs, 300000, '空闲超时默认 5 分钟');
  assert.equal(config.output.maxMessageChars, 1500);
  assert.equal(config.logging.retainDays, 30);
  assert.equal(config.qq.allowGroup, false);
  assert.ok(config.qq.imageDir, '图片落地目录必须有默认值');
  assert.ok(config.qq.maxImageBytes > 0);
});

test('空配置等于全默认', () => {
  const { config } = mergeConfig({});
  assert.deepEqual(config.security.rateLimit, DEFAULTS.security.rateLimit);
  assert.equal(config.dsh.timeoutMs, DEFAULTS.dsh.timeoutMs);
});

test('显式值覆盖默认值', () => {
  const { config } = mergeConfig({ dsh: { timeoutMs: 12345 } });
  assert.equal(config.dsh.timeoutMs, 12345);
  assert.equal(config.dsh.persistSession, true, '同段其它键仍用默认值');
});

test('数组按替换而非合并处理', () => {
  const { config } = mergeConfig({ security: { allowedOpenIds: ['U1', 'U2'] } });
  assert.deepEqual(config.security.allowedOpenIds, ['U1', 'U2']);
});

test('环境变量层优先级高于文件层', () => {
  const { config } = mergeConfig(
    { dsh: { timeoutMs: 111 } },
    { dsh: { timeoutMs: 222 } }
  );
  assert.equal(config.dsh.timeoutMs, 222, '环境变量应覆盖文件');
});

test('注释键被剥离', () => {
  const { config } = mergeConfig({
    _说明: ['给人看的'],
    security: { _note: 'x', allowedOpenIds: ['U1'] },
  });
  assert.equal(config._说明, undefined, '顶层注释键应被剥离');
  assert.equal(config.security._note, undefined, '嵌套注释键应被剥离');
});

test('mergeConfig 同时返回占位符列表', () => {
  const { config, placeholders } = mergeConfig({
    security: { allowedOpenIds: ['在这里填入你的 openid', 'U1'] },
  });
  assert.deepEqual(config.security.allowedOpenIds, ['U1'], '占位符应被剔除');
  assert.equal(placeholders.length, 1, '占位符应被单独报告');
});

test('畸形输入不抛异常', () => {
  assert.doesNotThrow(() => mergeConfig(null));
  assert.doesNotThrow(() => mergeConfig(undefined));
  assert.doesNotThrow(() => mergeConfig(null, null));
  assert.doesNotThrow(() => mergeConfig({ security: null }));
  assert.doesNotThrow(() => mergeConfig({ security: { allowedOpenIds: 'not-an-array' } }));
});

test('security 为 null 时仍不崩溃且白名单为空', () => {
  const { config } = mergeConfig({ security: null });
  assert.ok(config.security, 'security 段应被默认值填回');
  assert.deepEqual(config.security.allowedOpenIds, []);
});

console.log('\n=== 沙箱临时目录必须在 workspace 之外（真实故障）===');

// 背景：workspace 设成 %USERPROFILE% 后，%TEMP% 变成
// %USERPROFILE%\AppData\Local\Temp\dsh-xxx，落在 workspace 之内，
// DSH 的 Windows ACL 沙箱在 materializeAclGrant 里断言失败：
//   "Windows ACL temp root must be outside the workspace"
// 表现为该会话下**所有命令行操作**都不可用（PowerShell 直接报错）。

test('目录包含判定：双向正确', () => {
  const ws = 'C:\\Users\\<your-username>';
  assert.equal(isInsideDirectory(ws, ws), true, '自己算在内');
  assert.equal(isInsideDirectory(ws, ws + '\\AppData\\Local\\Temp\\x'), true, '子目录算在内');
  assert.equal(isInsideDirectory(ws, 'C:\\Windows\\Temp'), false, '外部目录不算');
  assert.equal(isInsideDirectory(ws, 'C:\\dsh-sandbox-tmp'), false);
});

test('目录包含判定不会被前缀混淆（经典陷阱）', () => {
  // 字符串前缀比较会把 C:\Users\Shane2 误判为在 %USERPROFILE% 之内
  assert.equal(isInsideDirectory('C:\\Users\\<your-username>', 'C:\\Users\\Shane2'), false,
    'Shane2 不是 Shane 的子目录');
  assert.equal(isInsideDirectory('C:\\a\\b', 'C:\\a\\bc'), false);
  assert.equal(isInsideDirectory('C:\\a\\b', 'C:\\a\\b\\c'), true);
});

test('显式临时目录在 workspace 内 → 报 error', () => {
  const r = checkSandboxTemp('C:\\Users\\<your-username>', 'C:\\Users\\<your-username>\\Desktop\\t');
  assert.ok(r, '应返回问题描述');
  assert.equal(r.severity, 'error');
  assert.match(r.message, /不能位于/);
  assert.match(r.message, /Windows ACL/);
});

test('未配置临时目录且系统默认在 workspace 内 → 报 warning', () => {
  // 用当前进程真实的 os.tmpdir() 判定，验证"系统默认"这条分支
  const sysTemp = tmpdir();
  const r = checkSandboxTemp('C:\\Users\\<your-username>', null);
  const inside = isInsideDirectory('C:\\Users\\<your-username>', sysTemp);
  if (inside) {
    assert.ok(r, '系统 TEMP 在 workspace 内时必须给出告警');
    assert.equal(r.severity, 'warning');
    assert.equal(r.effectiveTemp, resolve(sysTemp));
  } else {
    assert.equal(r, null, '系统 TEMP 在外部时不应告警');
  }
});

test('临时目录在 workspace 之外 → 通过', () => {
  assert.equal(checkSandboxTemp('C:\\Users\\<your-username>', 'C:\\dsh-sandbox-tmp'), null);
  assert.equal(checkSandboxTemp('C:\\Users\\<your-username>', 'C:\\Windows\\Temp'), null);
});

test('workspace 收窄后系统默认临时目录自然在外部 → 通过', () => {
  // 例如把 workspace 收窄到 Desktop，%TEMP% 就在它之外了
  assert.equal(checkSandboxTemp('C:\\Users\\<your-username>\\Desktop', null), null);
});

test('空字符串/空白视为未配置', () => {
  const r = checkSandboxTemp('C:\\Users\\<your-username>', '   ');
  // 空白 → 走系统默认分支；系统 TEMP 在 workspace 内则告警
  if (r) assert.equal(r.severity, 'warning');
});

test('畸形输入不抛异常', () => {
  assert.doesNotThrow(() => checkSandboxTemp(null, null));
  assert.doesNotThrow(() => checkSandboxTemp('C:\\a', null));
  assert.doesNotThrow(() => isInsideDirectory(null, 'C:\\a'));
  assert.doesNotThrow(() => isInsideDirectory('C:\\a', null));
  assert.equal(isInsideDirectory('', ''), false);
});

console.log('\n=== 权限探测（决定用户看到的"是否已放开"）===');

// 这段只用于**展示与告警**，但展示错了会误导判断：
// 用户会以为权限已放开（实际没有）或反之。因此解析必须准确，读不到时不猜。
//
// 真实踩过的坑：权限是"预设(preset)"驱动的，预设把「沙箱 + 审批」**配对**。
// 只改 sandboxPolicy.mode=danger-full-access 而 approval 仍是 ask，
// 组合 `danger-full-access + ask` 不存在于任何预设 →
//   permission: composed sandbox and approval defaults match no preset
// → 整个权限插件拒绝激活，**反而比默认更受限**。

test('能从真实 patch 读出 preset / 沙箱 / 审批', () => {
  const r = readHeadlessSandboxMode('headless');
  assert.equal(typeof r, 'object');
  if (r.mode) {
    assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(r.mode),
      `模式取值异常: ${r.mode}`);
  }
  if (r.preset) {
    assert.ok(r.approval, `有 preset 时应同时解析出 approval，实得 ${r.approval}`);
  }
});

test('不存在的 profile 返回 error 且不猜模式', () => {
  let r;
  assert.doesNotThrow(() => { r = readHeadlessSandboxMode('不存在的profile-xyz'); });
  assert.equal(r.mode, null, '读不到时绝不能猜一个模式出来');
  assert.equal(r.preset, null);
  assert.ok(r.error, '应说明原因');
});

test('Windows 路径的双反斜杠被还原', () => {
  const r = readHeadlessSandboxMode('headless');
  if (r.workspaceRoot) {
    assert.ok(!r.workspaceRoot.includes('\\\\'),
      `展示路径不应残留双反斜杠: ${r.workspaceRoot}`);
  }
});

test('本机权限应由 config 的 permissionMode 决定（不再依赖 profile patch）', () => {
  // 机制已改：真正生效的是环境变量 DSH_PERMISSION_MODE，
  // 由 config/config.json 的 dsh.permissionMode 提供。
  // profile 的 patch 层已清空（曾写错 id 导致 DSH 报 "entry not found"）。
  const r = readHeadlessSandboxMode('headless');
  assert.equal(r.mode, null, 'profile 里不应再配权限（机制是环境变量）');
  assert.equal(r.warning, null, '不应有配置告警');

  const cfgPath = new URL('../config/config.json', import.meta.url);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(cfg.dsh?.permissionMode, 'danger-full-access',
    'config.json 的 dsh.permissionMode 应为 danger-full-access');
});

console.log('\n=== 权限 patch 解析（含"改了反而更受限"的陷阱）===');

// 真实踩到的坑：权限是"预设(preset)"驱动的，预设把「沙箱 + 审批」**配对**。
// 只改 sandboxPolicy.mode=danger-full-access 而 approval 仍是 ask，
// 组合 `danger-full-access + ask` 不存在于任何预设 →
//   permission: composed sandbox and approval defaults match no preset
// → 整个权限插件拒绝激活，**反而比默认更受限**，且报错只在 stderr 里。

test('defaultPreset: danger-full-access → 正确配对为 approval=never', () => {
  const r = parsePermissionPatch(`
- id: permission-presets
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access
`);
  assert.equal(r.preset, 'danger-full-access');
  assert.equal(r.mode, 'danger-full-access');
  assert.equal(r.approval, 'never', '审批策略必须成对解析出来');
  assert.equal(r.warning, null);
});

test('defaultPreset: workspace-write → approval=ask', () => {
  const r = parsePermissionPatch('    defaultPreset: workspace-write\n');
  assert.equal(r.mode, 'workspace-write');
  assert.equal(r.approval, 'ask');
  assert.equal(r.warning, null);
});

test('危险组合：只改 mode 为 danger-full-access → 必须告警', () => {
  const r = parsePermissionPatch(`
- id: sandbox-policy
  name: "@deepseek-ai/dsh-sandbox-policy"
  config:
    mode: danger-full-access
    workspaceRoot: "C:\\\\Users\\\\Shane\\\\Desktop"
`);
  assert.equal(r.mode, 'danger-full-access');
  assert.ok(r.warning, '这正是踩过的坑，必须告警而不是默默接受');
  assert.match(r.warning, /defaultPreset/, '要给出正确的修法');
});

test('只改 mode 为 workspace-write → 不告警（与默认审批天然配对）', () => {
  // 注意必须带 name 行 —— 真实的 patch 条目一定有它（否则条目本身不生效）。
  // 早先这里漏了 name，导致解析走了"两条都没写"的分支而误判为失败 ——
  // 是夹具写错，不是实现问题。
  const r = parsePermissionPatch(`
- id: sandbox-policy
  name: "@deepseek-ai/dsh-sandbox-policy"
  config:
    mode: workspace-write
`);
  assert.equal(r.mode, 'workspace-write');
  assert.equal(r.warning, null);
});

test('没有 name 的孤立键值不算权限配置（避免误读注释/片段）', () => {
  // 只有键值、没有插件条目上下文的文本，不应被当成生效配置
  const r = parsePermissionPatch('    mode: workspace-write\n');
  assert.equal(r.mode, null, '不该把裸键值当成权限配置');
  assert.equal(r.warning, null);
});

test('未知 preset → 告警', () => {
  const r = parsePermissionPatch('    defaultPreset: 我编的预设\n');
  assert.equal(r.preset, '我编的预设');
  assert.equal(r.mode, null, '未知预设不能猜它的沙箱模式');
  assert.ok(r.warning);
});

test('两条都没写 → 不猜模式', () => {
  const r = parsePermissionPatch('# 空 patch\n[]\n');
  assert.equal(r.mode, null);
  assert.equal(r.preset, null);
  assert.equal(r.warning, null);
});

test('defaultPreset 优先于 sandboxPolicy.mode（同时存在时）', () => {
  const r = parsePermissionPatch(`
- id: sandbox-policy
  config:
    mode: read-only
- id: permission-presets
  config:
    defaultPreset: danger-full-access
`);
  assert.equal(r.preset, 'danger-full-access');
  assert.equal(r.mode, 'danger-full-access', '预设是权威来源');
  assert.equal(r.warning, null, '既然有合法预设，就不该再报危险组合');
});

test('注释行里的 mode 不被误读', () => {
  const r = parsePermissionPatch(`
# 以前这里写过 mode: danger-full-access
- id: permission-presets
  config:
    defaultPreset: workspace-write
`);
  assert.equal(r.mode, 'workspace-write', '不应把注释里的值当配置');
  assert.equal(r.warning, null);
});

test('畸形输入不抛异常', () => {
  for (const v of [null, undefined, '', 123, {}, []]) {
    assert.doesNotThrow(() => parsePermissionPatch(v));
  }
  assert.equal(parsePermissionPatch(null).mode, null);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
