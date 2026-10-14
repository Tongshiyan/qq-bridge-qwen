/**
 * 单测：启动环境探针（本进程能不能写 DSH 的配置目录）
 *
 * 背景（真实事故，2026-10-14）：桥接被某个 DSH 会话从沙箱里拉起，它 spawn 的
 * dsh 子进程继承低完整性令牌，写不了 workspace 之外的 profile：
 *   Error: EPERM: operation not permitted, open
 *     'C:\Users\<你>\.dsh\profiles\headless\cordis.yml'
 * 于是每条 QQ 指令都在 0.1 秒内失败。探针就是把这个环境问题在启动时点破。
 *
 * 用法: bin\node.cmd tests\launch-context.test.js
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDshHomeWritable,
  resolveDshHome,
  LAUNCH_CONTEXT_HINT,
} from '../src/dsh/launch-context.js';

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

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-launch-context-'));
const fakeHome = join(tmpRoot, 'fake-user');
mkdirSync(join(fakeHome, '.dsh', 'profiles', 'headless'), { recursive: true });

console.log('\n=== resolveDshHome ===');

test('DSH_HOME 优先于 USERPROFILE', () => {
  assert.equal(
    resolveDshHome({ DSH_HOME: 'D:\\custom-dsh', USERPROFILE: 'C:\\Users\\x' }),
    'D:\\custom-dsh',
  );
});

test('没有 DSH_HOME 时用 USERPROFILE\\.dsh', () => {
  assert.equal(resolveDshHome({ USERPROFILE: 'C:\\Users\\x' }), join('C:\\Users\\x', '.dsh'));
});

test('两者都没有时返回空串（调用方据此报"未知"）', () => {
  assert.equal(resolveDshHome({}), '');
});

console.log('\n=== checkDshHomeWritable ===');

test('可写的 DSH 配置目录 → ok，且优先探测 profiles 子目录', () => {
  const r = checkDshHomeWritable({ DSH_HOME: join(fakeHome, '.dsh') });
  assert.equal(r.ok, true, `应判定可写，实得 ${JSON.stringify(r)}`);
  assert.equal(r.dir, join(fakeHome, '.dsh', 'profiles'));
  assert.equal(r.error, null);
});

test('探针文件用完即删，不留垃圾', () => {
  const dir = join(fakeHome, '.dsh', 'profiles');
  checkDshHomeWritable({ DSH_HOME: join(fakeHome, '.dsh') });
  const leftovers = readdirSync(dir).filter((n) => n.includes('write-probe'));
  assert.deepEqual(leftovers, [], `不应残留探针文件，实得 ${leftovers.join(', ')}`);
});

test('profiles 不存在时退回 DSH_HOME 本身', () => {
  const bare = join(tmpRoot, 'bare-dsh');
  mkdirSync(bare, { recursive: true });
  const r = checkDshHomeWritable({ DSH_HOME: bare });
  assert.equal(r.ok, true);
  assert.equal(r.dir, bare);
});

test('写不进去时 ok=false 并带错误原因（这就是沙箱内的表现）', () => {
  const missing = join(tmpRoot, 'does-not-exist', '.dsh');
  const r = checkDshHomeWritable({ DSH_HOME: missing });
  assert.equal(r.ok, false);
  assert.ok(r.error, '必须带错误原因，否则用户无法归因');
  assert.ok(!existsSync(missing), '探针不应创建不存在的目录');
});

test('无法确定目录时明确说未知，而不是误报可写', () => {
  const r = checkDshHomeWritable({});
  assert.equal(r.ok, false);
  assert.match(r.dir, /未知/);
});

console.log('\n=== 给用户的提示文案 ===');

test('提示必须给出可执行的动作（普通窗口启动 / start-all）', () => {
  assert.match(LAUNCH_CONTEXT_HINT, /start-all/);
  assert.match(LAUNCH_CONTEXT_HINT, /cordis\.yml/);
});

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(56) + '\n');

process.exit(failed === 0 ? 0 : 1);
