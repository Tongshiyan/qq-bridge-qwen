/**
 * 实测：经 cmd.exe 启动 .cmd 是否可行
 *
 * 背景：Node.js 自 20.x 起为修复 CVE-2024-27980，禁止直接 spawn
 * `.cmd` / `.bat`，会抛 `spawn EINVAL`。`dsh.cmd` 正是 .cmd。
 *
 * 本脚本用无引号、无特殊字符的简单标记脚本来对比三种启动方式，
 * 避免多层 shell 引号嵌套造成的假结论。
 *
 * 用法: bin\node.cmd tests\spawn-cmd-probe.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveSpawn } from '../src/dsh/runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const MARKER = join(here, '_spawn-marker.cmd');

if (!existsSync(MARKER)) {
  console.error(`\n❌ 找不到标记脚本: ${MARKER}\n`);
  process.exit(2);
}

console.log('\n=== .cmd 启动方式对比 ===\n');
console.log(`目标文件: ${MARKER}`);
console.log('');

/** 运行一次并返回 {ok, out, code}；用管道捕获以检查输出标记。 */
function attempt(label, file, args, opts = {}) {
  console.log(`--- ${label} ---`);
  let r;
  try {
    r = spawnSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      ...opts,
    });
  } catch (e) {
    console.log(`  \x1b[31m✗ 抛异常: ${e.code ?? ''} ${e.message}\x1b[0m`);
    return { ok: false, code: e.code ?? 'THROW', out: '' };
  }

  if (r.error) {
    console.log(`  \x1b[31m✗ 失败: ${r.error.code ?? ''} ${r.error.message}\x1b[0m`);
    return { ok: false, code: r.error.code ?? 'ERROR', out: '' };
  }

  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const marked = out.includes('SPAWN_MARKER_OK');
  if (marked) {
    console.log('  \x1b[32m✓ 成功，且捕获到标记输出 SPAWN_MARKER_OK\x1b[0m');
    return { ok: true, code: 'OK', out };
  }
  console.log(`  \x1b[33m△ 进程启动但未见标记 (exit=${r.status})\x1b[0m`);
  console.log(`    输出: ${JSON.stringify(out.slice(0, 200))}`);
  return { ok: false, code: `exit=${r.status}`, out };
}

// 方式 A：直接 spawn .cmd —— 预期失败
const a = attempt('方式 A：直接 spawn .cmd（有问题的旧写法）', MARKER, []);

// 方式 B：本项目采用的方式
const spec = resolveSpawn(MARKER, []);
const b = attempt(
  `方式 B：经 cmd.exe（本项目方案，viaCmd=${spec.viaCmd}）`,
  spec.file, spec.args
);

// 方式 C：shell:true —— 对照，仅说明"为什么不用它"
const c = attempt('方式 C：shell:true（对照）', MARKER, [], { shell: true });

console.log('\n' + '='.repeat(62));
console.log('结论');
console.log('='.repeat(62));
console.log(`  方式 A（直接 spawn .cmd）      : ${a.ok ? '可用' : `失败 (${a.code})`}`);
console.log(`  方式 B（经 cmd.exe，本项目采用）: ${b.ok ? '可用' : `失败 (${b.code})`}`);
console.log(`  方式 C（shell:true，仅对照）    : ${c.ok ? '可用' : `失败 (${c.code})`}`);
console.log('');

let verdict = 0;
if (!a.ok && b.ok) {
  console.log('  ✅ 复现并确认修复有效：');
  console.log('     直接 spawn .cmd 失败，经 cmd.exe 成功。');
  console.log('     这就是实践中 spawn EINVAL 的根因与解法。');
} else if (a.ok && b.ok) {
  console.log('  → 两种方式都可用（当前 Node/环境未触发该限制）。');
  console.log('    保持方式 B：它在所有 Node 20+ 版本上都正确。');
} else if (!b.ok) {
  console.log('  ⚠️ 方式 B 也失败 —— 可能受沙箱限制。');
  console.log('     请在没有沙箱的普通 cmd 窗口重跑本脚本。');
  verdict = 1;
} else {
  console.log('  → 结果不符合任一预期，请人工检查上面输出。');
  verdict = 1;
}
console.log('');

process.exit(verdict);
