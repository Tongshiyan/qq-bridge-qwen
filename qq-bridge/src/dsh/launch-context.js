/**
 * 启动环境自检：这个进程有没有权限写 DSH 自己的配置目录？
 *
 * ── 为什么需要这个检查（真实事故）──────────────────────────────────
 *
 * 现象：手机发「hello」，桥接回一大段 Node 崩溃堆栈：
 *
 *   Error: EPERM: operation not permitted, open
 *     'C:\Users\<你>\.dsh\profiles\headless\cordis.yml'
 *       at writeFileSync
 *       at prepareProfile (…/profile-boot-*.js)
 *       at composeProfile → runProfile → runCli
 *
 * 机制：桥接服务**自己**是在某个 DSH 会话的沙箱里被拉起来的
 * （那个会话直接 Start-Process 了 main.js）。DSH 的 Windows 沙箱是一枚
 * 低完整性（Low IL）令牌，会被子进程**继承且无法自行摆脱**。于是桥接
 * spawn 的 `dsh --profile headless` 子进程在启动阶段要重写 profile 文件时，
 * 被"禁止向上写"拦下：
 *
 *   · 工作区（D:\dsh-workspace 等）被 DSH 显式授权 → 可写
 *   · 工作区之外（%USERPROFILE%\.dsh\profiles\…，中完整性对象）→ EPERM
 *
 * 结果就是**每条指令都在 0.1 秒内失败、事件数为 0**，而堆栈里的
 * EPERM/cordis.yml 与「配置坏了」「权限坏了」长得很像，很难一眼归因。
 *
 * ── 为什么必须真写一个文件，而不是 access(W_OK) ──────────────────
 *
 * Node 的 accessSync(W_OK) 走的是 ACL 判定（AccessCheck），
 * **不包含强制完整性策略**：低完整性进程去问，它照样回答"可写"。
 * 只有真的创建一次文件才知道。探针文件随即删除，不留垃圾。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok: boolean, dir: string, error: string|null}}
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 解析 DSH 的配置根目录（与 DSH 自己的规则一致：DSH_HOME 优先）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 目录，无法确定时返回空串
 */
export function resolveDshHome(env = process.env) {
  const explicit = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (explicit) return explicit;
  const profile = env?.USERPROFILE || env?.HOME || '';
  return profile ? join(profile, '.dsh') : '';
}

/**
 * 探针：尝试在 DSH 配置目录里建一个临时文件并删除。
 *
 * 优先探测 `<home>\profiles`（dsh 子进程真正要写的地方），
 * 该目录还不存在时退回 `<home>`。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok: boolean, dir: string, error: string|null}}
 */
export function checkDshHomeWritable(env = process.env) {
  const home = resolveDshHome(env);
  if (!home) {
    return { ok: false, dir: '(未知)', error: '无法确定 DSH_HOME / USERPROFILE' };
  }

  const profilesDir = join(home, 'profiles');
  const dir = existsSync(profilesDir) ? profilesDir : home;
  const probe = join(dir, `.bridge-write-probe-${process.pid}.tmp`);

  try {
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return { ok: true, dir, error: null };
  } catch (e) {
    // 失败时尽力清掉可能已经创建了一半的探针文件
    try { rmSync(probe, { force: true }); } catch { /* ignore */ }
    return {
      ok: false,
      dir,
      error: `${e?.code ? `${e.code}: ` : ''}${e?.message ?? String(e)}`,
    };
  }
}

/** 探针失败时给用户/日志看的一句话解释。 */
export const LAUNCH_CONTEXT_HINT = [
  '这个进程写不了 DSH 的配置目录 —— 它多半是在 DSH 会话的沙箱里被拉起的。',
  '沙箱令牌会被子进程继承，于是它 spawn 的 dsh 子进程无法改写',
  '%USERPROFILE%\\.dsh\\profiles\\<profile>\\cordis.yml，每条指令都会 EPERM 失败。',
  '修法：关掉它，改从普通窗口启动 — scripts\\start-all.cmd（或「Qwen控制台」）。',
].join('\n');
