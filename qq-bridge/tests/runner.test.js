/**
 * DSH 启动方式单测
 *
 * 这里锁定两个真实踩到的缺陷：
 *
 * 1. **spawn EINVAL**：Node 20+ 为修复 CVE-2024-27980 禁止直接 spawn `.cmd`。
 *
 * 2. **命令注入（更严重）**：曾经用 `cmd.exe /d /s /c <cliPath> <args...>`
 *    绕过 EINVAL，并想当然认为"参数是数组所以安全"。**这是错的** ——
 *    Windows 的 CreateProcess 只吃一条命令行字符串，cmd.exe 会重新解析它，
 *    于是任务文本里的 `&`、`|`、`>`、`%VAR%` 被当语法执行。
 *    实测证据由 tests/integration.test.js 发现：
 *      - `x&echo.>PWNED_AMP.txt` 真的生成了 PWNED_AMP.txt
 *      - `explain %PATH% semantics` 的 argv 里 %PATH% 被展开成真实环境变量
 *
 *    正确解法是直接调 Node 入口（dsh.cmd 内部的等价写法），完全不经 cmd.exe。
 *    本文件断言：配置了 nodeExe+jsEntry 时必须走 direct-node 且标记 safe；
 *    只有拿不到二者时才退回 cmd.exe，并且**必须**标记为 unsafe 以便告警。
 *
 * 用法: bin\node.cmd tests\runner.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSpawn, composeTaskText, RUNTIME_NOTE, buildChildEnv } from '../src/dsh/runner.js';

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
    console.log(`    ${e.message.split('\n')[0]}`);
  }
}

const isWin = process.platform === 'win32';
const CMD = 'D:\\softwares\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd';
const NODE_EXE = 'D:\\softwares\\dsh\\DeepSeek Harness.exe';
const JS_ENTRY = 'D:\\softwares\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';

console.log('\n=== 首选：直接调 Node 入口（无注入风险）===');

test('配置 nodeExe + jsEntry 时走 direct-node', () => {
  const r = resolveSpawn(CMD, ['--profile', 'headless'], { nodeExe: NODE_EXE, jsEntry: JS_ENTRY });
  assert.equal(r.file, NODE_EXE, '应直接启动 Node/Electron 本体');
  assert.equal(r.viaCmd, false, '不得经 cmd.exe');
  assert.equal(r.safe, true, '必须标记为安全');
  assert.equal(r.note, 'direct-node');
});

test('direct-node 携带 --expose-internals 与入口路径', () => {
  const r = resolveSpawn(CMD, ['--profile', 'headless', '--json', '任务'], {
    nodeExe: NODE_EXE, jsEntry: JS_ENTRY,
  });
  assert.equal(r.args[0], '--expose-internals');
  assert.equal(r.args[1], JS_ENTRY);
  assert.deepEqual(r.args.slice(2), ['--profile', 'headless', '--json', '任务']);
});

test('direct-node 时任务文本仍是独立 argv 元素（不拼字符串）', () => {
  const evil = 'x&echo.>PWNED.txt';
  const r = resolveSpawn(CMD, ['--profile', 'headless', evil], { nodeExe: NODE_EXE, jsEntry: JS_ENTRY });
  assert.equal(r.args.at(-1), evil, '载荷必须原样作为单个元素');
  // 关键：不存在把 cliPath 和载荷拼在一起的那种元素
  for (const a of r.args) {
    assert.ok(!a.includes('cmd.exe'), '不应出现 cmd.exe');
  }
});

test('direct-node 优先于 cliPath（即使 cliPath 是 .cmd）', () => {
  const r = resolveSpawn(CMD, ['a'], { nodeExe: NODE_EXE, jsEntry: JS_ENTRY });
  assert.equal(r.file, NODE_EXE);
  assert.equal(r.safe, true);
});

console.log('\n=== 兜底：经 cmd.exe（必须标记为不安全）===');

test('.cmd 在 Windows 上退回 cmd.exe', () => {
  const r = resolveSpawn(CMD, ['--profile', 'headless']);
  if (!isWin) {
    assert.equal(r.viaCmd, false);
    return;
  }
  assert.equal(r.viaCmd, true);
  assert.match(r.file, /cmd\.exe$/i);
  assert.equal(r.args[0], '/d');
  assert.equal(r.args[1], '/s');
  assert.equal(r.args[2], '/c');
  assert.equal(r.args[3], CMD);
});

test('cmd 兜底必须标记 safe=false（否则调用方不会告警）', () => {
  const r = resolveSpawn(CMD, ['a']);
  if (!isWin) return;
  assert.equal(r.safe, false, 'cmd.exe 路径存在注入风险，必须标记为不安全');
  assert.equal(r.note, 'cmd-fallback');
});

test('.bat 同样处理', () => {
  const r = resolveSpawn('C:\\x\\run.bat', ['a']);
  if (!isWin) return;
  assert.equal(r.viaCmd, true);
  assert.equal(r.safe, false);
});

test('大小写不敏感（.CMD / .Bat）', () => {
  const r1 = resolveSpawn('C:\\x\\DSH.CMD', ['a']);
  const r2 = resolveSpawn('C:\\x\\run.Bat', ['a']);
  if (!isWin) return;
  assert.equal(r1.viaCmd, true);
  assert.equal(r2.viaCmd, true);
});

test('只给一半（缺 jsEntry）不启用 direct-node', () => {
  const r = resolveSpawn(CMD, ['a'], { nodeExe: NODE_EXE });
  assert.notEqual(r.note, 'direct-node', '只有 nodeExe 不足以直接启动');
});

console.log('\n=== 其它可执行文件直接启动 ===');

test('.exe 直接启动，不经 cmd', () => {
  const r = resolveSpawn('C:\\Windows\\System32\\where.exe', ['node']);
  assert.equal(r.viaCmd, false);
  assert.equal(r.safe, true);
  assert.equal(r.file, 'C:\\Windows\\System32\\where.exe');
  assert.deepEqual(r.args, ['node']);
});

test('无扩展名路径直接启动', () => {
  const r = resolveSpawn('/usr/bin/node', ['-v']);
  assert.equal(r.viaCmd, false);
  assert.equal(r.safe, true);
});

test('路径含 cmd 但后缀是 .exe 时不改写', () => {
  const r = resolveSpawn('C:\\cmd-tools\\runner.exe', ['x']);
  assert.equal(r.viaCmd, false, '不应因路径含 cmd 就误判');
});

console.log('\n=== 健壮性 ===');

test('返回结构完整', () => {
  const r = resolveSpawn('C:\\x\\dsh.cmd', []);
  assert.equal(typeof r.file, 'string');
  assert.ok(Array.isArray(r.args));
  assert.equal(typeof r.viaCmd, 'boolean');
  assert.equal(typeof r.safe, 'boolean');
  assert.equal(typeof r.note, 'string');
});

test('空参数 / 畸形路径不抛异常', () => {
  assert.doesNotThrow(() => resolveSpawn('C:\\x\\dsh.cmd', []));
  assert.doesNotThrow(() => resolveSpawn('', []));
  assert.doesNotThrow(() => resolveSpawn(null, []));
  assert.doesNotThrow(() => resolveSpawn(undefined, ['a']));
  assert.doesNotThrow(() => resolveSpawn(null, [], { nodeExe: null, jsEntry: null }));
});

test('null 路径不判为批处理', () => {
  const r = resolveSpawn(null, ['a']);
  assert.equal(r.viaCmd, false);
});

console.log('\n=== composeTaskText（运行说明注入）===');

// 为什么需要：用户说「把文件发给我」时，agent 没有投递通道，
// 会改为把文件内容全提取成文字（实测一页 PDF 43 步 / 247 秒）。
// 桥接把"你可以报路径，我来发"这件事告知它，避免这条弯路。

test('默认附加运行说明，并包含 SEND_FILE 约定', () => {
  const t = composeTaskText('把桌面的简历发给我');
  assert.ok(t.includes('SEND_FILE:'), '必须含 SEND_FILE 约定');
  assert.ok(t.includes('把桌面的简历发给我'), '用户原话必须完整保留');
});

test('用户请求被显式分隔，不与说明混在一起', () => {
  const t = composeTaskText('把桌面的简历发给我');
  assert.ok(t.includes('【用户请求】'), '应有明确分隔标记');
  assert.ok(t.indexOf('【运行环境说明】') < t.indexOf('【用户请求】'), '说明在前、请求在后');
});

test('关闭注入时返回原文（用于测试与特殊场景）', () => {
  assert.equal(composeTaskText('hello', { withNote: false }), 'hello');
});

test('说明文本本身含投递能力的关键信息', () => {
  assert.ok(RUNTIME_NOTE.includes('QQ'), '应说明是 QQ 场景');
  assert.ok(/投递|发/.test(RUNTIME_NOTE), '应说明桥接能投递');
  assert.ok(/不要.*提取/.test(RUNTIME_NOTE), '应劝阻"提取内容当文字发"这条弯路');
});

test('空任务不崩溃', () => {
  assert.doesNotThrow(() => composeTaskText(''));
  assert.doesNotThrow(() => composeTaskText(null));
  assert.ok(composeTaskText(null).includes('SEND_FILE'));
});

test('说明不会破坏任务文本里的 shell 元字符（仍作为单个 argv 传递）', () => {
  const evil = 'x&echo.>PWNED.txt';
  const composed = composeTaskText(evil);
  const r = resolveSpawn('C:\\x\\dsh.cmd', [composed], { nodeExe: 'C:\\n.exe', jsEntry: 'C:\\e.js' });
  assert.equal(r.args.at(-1), composed, '整段仍是一个 argv 元素');
});

console.log('\n=== 长期记忆注入 ===');

test('记忆文本被塞进任务，且用户原话仍然单独成段', () => {
  const t = composeTaskText('那 C 盘呢', { memoryText: '【长期记忆】\n用户的项目都在 D:\\work' });
  assert.ok(t.includes('【长期记忆】'), '应带记忆块');
  assert.ok(t.includes('用户的项目都在 D:\\work'));
  assert.ok(t.includes('【用户请求】\n那 C 盘呢'), '用户原话必须边界清晰，不能被记忆污染');
  assert.ok(t.indexOf('【长期记忆】') < t.indexOf('【用户请求】'), '记忆在请求之前');
});

test('给出文件路径时，会告诉 agent 怎么追加记忆', () => {
  const t = composeTaskText('记住：我的项目都在 D:\\work', { memoryPath: 'C:\\p\\memory\\MEMORY.md' });
  assert.ok(t.includes('C:\\p\\memory\\MEMORY.md'), '必须给出绝对路径');
  assert.ok(/read/.test(t) && /edit/.test(t), '要说明用 read/edit 工具去写');
  assert.ok(/## YYYY-MM-DD HH:mm/.test(t), '要给出追加格式');
});

test('没有记忆时任务文本不带记忆块（保持短）', () => {
  const t = composeTaskText('你好');
  assert.ok(!t.includes('【长期记忆】'));
  assert.equal(composeTaskText('你好', { withNote: false, memoryText: '', memoryPath: '' }), '你好');
});

test('记忆里的 shell 元字符同样只是 argv 内容', () => {
  const evil = 'x&echo.>PWNED.txt';
  const composed = composeTaskText('hi', { memoryText: evil });
  const r = resolveSpawn('C:\\x\\dsh.cmd', [composed], { nodeExe: 'C:\\n.exe', jsEntry: 'C:\\e.js' });
  assert.equal(r.args.at(-1), composed);
});

console.log('\n=== buildChildEnv（真实踩到的"配置改了没效果"根因）===');

// 最难发现的一个坑：桥接若从 DSH 会话环境启动，会继承桌面版设的
//   DSH_PROFILE=desktop / DSH_PROFILE_DIR=...\profiles\desktop
// 子进程继承后，**尽管命令行传了 --profile headless，DSH 仍解析到 desktop profile**，
// 于是写在 headless profile 里的权限预设、模型 provider 全部被静默忽略。
// 现象只是"改了配置毫无效果"，没有任何报错指向 profile —— 排查了三轮。

const BASE = {
  PATH: 'C:\\x',
  DSH_HOME: 'C:\\Users\\<your-username>\\.dsh',
  DSH_PROFILE: 'desktop',
  DSH_PROFILE_DIR: 'C:\\Users\\<your-username>\\.dsh\\profiles\\desktop',
  DSH_SESSION_ID: 'session-abc',
  DSH_WEB_URL: 'http://127.0.0.1:19387',
};

test('剥掉会覆盖 --profile 的桌面版变量', () => {
  const e = buildChildEnv(BASE, {}, { directNode: true });
  assert.equal(e.DSH_PROFILE, undefined, 'DSH_PROFILE 必须剥掉');
  assert.equal(e.DSH_PROFILE_DIR, undefined, 'DSH_PROFILE_DIR 必须剥掉');
  assert.equal(e.DSH_SESSION_ID, undefined, 'DSH_SESSION_ID 必须剥掉（否则会话会被桌面版占用）');
});

test('保留 DSH_HOME（模型凭证在那里）', () => {
  const e = buildChildEnv(BASE, {}, {});
  assert.equal(e.DSH_HOME, 'C:\\Users\\<your-username>\\.dsh', 'DSH_HOME 不能剥掉');
});

test('保留其它无关环境变量', () => {
  const e = buildChildEnv(BASE, {}, {});
  assert.equal(e.PATH, 'C:\\x');
  assert.equal(e.DSH_WEB_URL, 'http://127.0.0.1:19387');
});

test('direct-node 时设置 ELECTRON_RUN_AS_NODE', () => {
  assert.equal(buildChildEnv(BASE, {}, { directNode: true }).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(buildChildEnv(BASE, {}, { directNode: false }).ELECTRON_RUN_AS_NODE, undefined);
});

test('指定 sandboxTempDir 时同时设置 TEMP 与 TMP', () => {
  const e = buildChildEnv(BASE, {}, { sandboxTempDir: 'C:\\tmp-x' });
  assert.equal(e.TEMP, 'C:\\tmp-x');
  assert.equal(e.TMP, 'C:\\tmp-x');
});

test('未指定 sandboxTempDir 时不改动 TEMP/TMP', () => {
  const e = buildChildEnv({ TEMP: 'C:\\sys-temp' }, {}, {});
  assert.equal(e.TEMP, 'C:\\sys-temp');
});

test('调用方注入的变量优先生效', () => {
  const e = buildChildEnv(BASE, { MY_VAR: '1' }, {});
  assert.equal(e.MY_VAR, '1');
});

test('调用方无法用注入把 DSH_PROFILE 加回来（剥离在后）', () => {
  const e = buildChildEnv(BASE, { DSH_PROFILE: 'desktop' }, {});
  assert.equal(e.DSH_PROFILE, undefined, '剥离必须在合并之后执行');
});

test('畸形输入不抛异常', () => {
  assert.doesNotThrow(() => buildChildEnv(null, null, {}));
  assert.doesNotThrow(() => buildChildEnv(undefined, undefined, { directNode: true }));
  assert.equal(typeof buildChildEnv(null, null, {}), 'object');
});

console.log('\n=== buildChildEnv：权限模式（唯一真正有效的开关）===');

// 真实教训：我先后试过改 sandboxPolicy.mode、改 permissionPresets.defaultPreset，
// 全部无效。`dsh --dump-config` 显示机制是**环境变量**：
//     sandbox-policy.mode   = DSH_PERMISSION_MODE ?? 'workspace-write'
//     approval.policy       = DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask'
// 沙箱与审批从它成对派生（这就是"预设配对"的实现）。只设这一个即可。

test('注入 DSH_PERMISSION_MODE', () => {
  const e = buildChildEnv({ PATH: 'x' }, {}, { permissionMode: 'danger-full-access' });
  assert.equal(e.DSH_PERMISSION_MODE, 'danger-full-access');
});

test('未指定时不注入该变量（不干预 DSH 默认）', () => {
  const e = buildChildEnv({ PATH: 'x' }, {}, {});
  assert.equal(e.DSH_PERMISSION_MODE, undefined);
  const e2 = buildChildEnv({ PATH: 'x' }, {}, { permissionMode: null });
  assert.equal(e2.DSH_PERMISSION_MODE, undefined);
});

test('workspace-write 也能注入（用于收紧）', () => {
  const e = buildChildEnv({}, {}, { permissionMode: 'workspace-write' });
  assert.equal(e.DSH_PERMISSION_MODE, 'workspace-write');
});

test('本机配置应解析为 danger-full-access', () => {
  // 对本机实际状态的断言；若有意收紧，请同步改这条
  const p = new URL('../config/config.json', import.meta.url);
  const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.dsh?.permissionMode, 'danger-full-access',
    'config.json 的 dsh.permissionMode 应为 danger-full-access');
});

test('permissionMode 与 directNode / 临时目录互不干扰', () => {
  const e = buildChildEnv({ PATH: 'x', DSH_PROFILE: 'desktop' }, {}, {
    directNode: true,
    sandboxTempDir: 'C:\\tmp-x',
    permissionMode: 'danger-full-access',
  });
  assert.equal(e.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(e.TEMP, 'C:\\tmp-x');
  assert.equal(e.DSH_PERMISSION_MODE, 'danger-full-access');
  assert.equal(e.DSH_PROFILE, undefined, 'profile 覆盖仍须剥离');
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
