/**
 * 单例守卫
 *
 * 为什么必须有：桥接服务的每一步都有副作用，跑两份会出事 ——
 *   - 两个进程同时连 QQ 网关，用户每条消息都可能收到两份回复
 *   - 更要紧的是「二次确认」：一次确认可能被两个进程各自执行一遍，
 *     于是「删除日志」变成删两次、`git push` 变成推两次
 *   - 速率限制、会话状态、待确认令牌都各算各的，行为不可预测
 *
 * 实现：一个锁文件，记录 PID 与进程启动时刻。
 *   - 启动时若锁存在且持有者仍活着 → 拒绝启动
 *   - 持有者已死（崩溃/强杀留下的孤儿锁）→ 抢占
 *   - 额外比较进程启动时刻，避免 PID 复用导致的误判
 *
 * 这不是安全边界（同机同用户下可绕过），而是防误操作与防崩溃残留。
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 判断进程是否存活。
 *
 * 用 signal 0 做探测：不发送信号，只做权限与存在性检查。
 *   - 成功           → 存活
 *   - ESRCH          → 不存在
 *   - EPERM / 其它   → 存在但无权探测（仍是"存活"）
 *
 * ⚠️ 沙箱环境下该调用本身可能被拒绝 —— 此时保守返回 true（视为存活），
 * 宁可不启动也不要跑出两份。
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function probeProcess(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e?.code === 'ESRCH') return false;
    if (e?.code === 'EPERM') return true; // 存在但无权限
    return true; // 其它异常保守处理
  }
}

/**
 * 读取一个进程的启动时刻（Windows 用 wmic/Get-Process，失败返回 null）。
 * 用于削弱 PID 复用造成的误判。
 *
 * 该探测是"尽力而为"：拿不到就跳过比对，不影响主流程。
 *
 * @param {number} pid
 * @returns {string|null}
 */
export function probeProcessStartTime(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToString('o')`],
        { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const s = String(out).trim();
      return s || null;
    }
    return null;
  } catch {
    return null;
  }
}

export class SingletonGuard {
  /**
   * @param {string} lockPath 锁文件绝对路径
   * @param {object} [opts]
   * @param {(pid: number) => boolean} [opts.isAlive]      可注入，便于测试
   * @param {(pid: number) => string|null} [opts.startTime] 可注入，便于测试
   */
  constructor(lockPath, { isAlive = probeProcess, startTime = probeProcessStartTime } = {}) {
    this.lockPath = lockPath;
    this.isAlive = isAlive;
    this.startTime = startTime;
    this.acquired = false;
  }

  /** 读取现有锁内容（不存在或损坏返回 null）。 */
  readLock() {
    if (!existsSync(this.lockPath)) return null;
    try {
      const raw = readFileSync(this.lockPath, 'utf8').replace(/^\uFEFF/, '');
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }

  /**
   * 尝试获取锁。
   *
   * @returns {{ok: true, tookOver: boolean} | {ok: false, holder: object|null, reason: string}}
   */
  acquire() {
    const existing = this.readLock();

    if (existing && Number.isInteger(existing.pid)) {
      const alive = this.isAlive(existing.pid);

      if (alive) {
        // 进一步用启动时刻削弱 PID 复用误判：时刻不一致说明是另一个进程
        const now = this.startTime(existing.pid);
        if (existing.startedAt && now && existing.startedAt !== now) {
          // 同一 PID 但启动时刻不同 → 旧进程已死、PID 被复用 → 可抢占
        } else {
          return {
            ok: false,
            holder: existing,
            reason: `已有实例在运行（PID ${existing.pid}，启动于 ${existing.startedAt ?? '未知'}）`,
          };
        }
      }
    }

    this.acquired = this.write();
    if (!this.acquired) {
      return { ok: false, holder: null, reason: `无法写入锁文件: ${this.lockPath}` };
    }
    return { ok: true, tookOver: !!existing };
  }

  write() {
    try {
      mkdirSync(dirname(this.lockPath), { recursive: true });
      writeFileSync(this.lockPath, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cwd: process.cwd(),
        argv: process.argv.slice(0, 4),
      }, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 释放锁。
   *
   * 只在锁确实属于自己时才删 —— 否则会把抢占者的锁误删，
   * 于是两个进程都以为自己是唯一的。
   */
  release() {
    if (!this.acquired) return false;
    const existing = this.readLock();
    if (existing && existing.pid !== process.pid) {
      // 锁已被别人接管，不要删
      this.acquired = false;
      return false;
    }
    try {
      unlinkSync(this.lockPath);
      this.acquired = false;
      return true;
    } catch {
      return false;
    }
  }

  /** 当前锁的持有者信息（诊断用）。 */
  holder() {
    return this.readLock();
  }
}
