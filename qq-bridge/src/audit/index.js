/**
 * 审计日志
 *
 * 为什么必须做：这个机器人本质上是把一台电脑的控制权通过聊天软件暴露出去。
 * 一旦出事（指令误触发、账号被盗用、机器人被他人调用），审计日志是唯一能
 * 回答"谁、什么时候、让它做了什么、结果如何"的东西。
 *
 * 设计要点：
 *   - JSONL 格式（每行一个 JSON），便于 grep 和后续分析
 *   - 按天分文件，自动清理超过保留期的旧文件
 *   - 所有写入前经过脱敏，绝不让密钥进入磁盘
 *   - 写入失败不能影响主流程（审计降级而非崩溃）
 */

import { appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../config/index.js';

/** 审计事件类型。 */
export const AuditEvent = {
  STARTUP: 'startup',
  SHUTDOWN: 'shutdown',
  MESSAGE_IN: 'message_in',
  UNAUTHORIZED: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  POLICY_BLOCKED: 'policy_blocked',
  POLICY_CONFIRM_PENDING: 'policy_confirm_pending',
  POLICY_CONFIRMED: 'policy_confirmed',
  POLICY_CONFIRM_REJECTED: 'policy_confirm_rejected',
  TASK_START: 'task_start',
  TASK_DONE: 'task_done',
  TASK_TIMEOUT: 'task_timeout',
  TASK_ERROR: 'task_error',
  TASK_CANCELLED: 'task_cancelled',
  SEND_FAILED: 'send_failed',
  /** SDK 内部日志（token 刷新、网关连接等），不是错误 */
  SDK_LOG: 'sdk_log',
  /** 桥接服务自身的诊断日志 */
  DIAG: 'diag',
  ERROR: 'error',
};

const SECRET_SCRUB = /(appsecret|access_token|clientsecret|authorization)/gi;

/**
 * 对任意字符串做最后的兜底脱敏。
 * 即使是自由文本（比如 DSH 的输出），也不该把形如密钥的东西原样落盘。
 */
function scrubText(text) {
  if (typeof text !== 'string') return text;
  return text
    // 形如 appSecret=xxxx / "appSecret": "xxxx"
    .replace(/(appSecret"?\s*[:=]\s*"?)([A-Za-z0-9_\-]{8,})/gi, (_, p) => p + '[REDACTED]')
    .replace(/(clientSecret"?\s*[:=]\s*"?)([A-Za-z0-9_\-]{8,})/gi, (_, p) => p + '[REDACTED]')
    .replace(/(access_token"?\s*[:=]\s*"?)([A-Za-z0-9_\-.]{8,})/gi, (_, p) => p + '[REDACTED]')
    .replace(/(Authorization:\s*QQBot\s+)(\S+)/gi, (_, p) => p + '[REDACTED]');
}

function deepScrub(value, depth = 0) {
  if (depth > 8) return '[深度截断]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  // 审计日志里不保留二进制
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}B]`;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = deepScrub(v, depth + 1);
  }
  return out;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class AuditLogger {
  /**
   * @param {{dir: string, retainDays?: number, level?: string, console?: boolean, showSdkLog?: boolean}} opts
   */
  constructor({ dir, retainDays = 30, level = 'info', console: toConsole = true, showSdkLog = false }) {
    this.dir = dir;
    this.retainDays = retainDays;
    this.level = level;
    this.toConsole = toConsole;
    // SDK 的 token 刷新 / 网关连接日志会刷屏并掩盖真正的错误，
    // 默认只落盘不打印（可用 LOG_LEVEL=debug 或此项打开）。
    this.showSdkLog = showSdkLog || level === 'debug';
    this.healthy = true;

    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      this.healthy = false;
      this.initError = e.message;
    }

    if (this.healthy) {
      try {
        this.prune();
      } catch {
        // 清理失败不影响使用
      }
    }
  }

  /** 删除超过保留期的日志文件。 */
  prune() {
    if (!existsSync(this.dir)) return;
    const cutoff = Date.now() - this.retainDays * 86_400_000;
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('audit-') || !name.endsWith('.jsonl')) continue;
      const full = join(this.dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // 单个文件删不掉就跳过
      }
    }
  }

  filePath() {
    return join(this.dir, `audit-${today()}.jsonl`);
  }

  /**
   * 写一条审计记录。
   * @param {string} event - AuditEvent 之一
   * @param {object} data - 附加字段
   */
  log(event, data = {}) {
    const record = {
      ts: new Date().toISOString(),
      event,
      ...deepScrub(data),
    };

    if (this.toConsole) {
      // SDK 日志噪音大且不是审计关注点：只在显式需要时打印，
      // 否则会在真正的错误旁边刷屏，把问题掩盖掉。
      const isSdkLog = event === AuditEvent.SDK_LOG;
      if (isSdkLog && !this.showSdkLog) {
        // 仍然落盘（便于排障），只是不打印到控制台
      } else {
        const extra = [];
        if (record.userId) extra.push(`user=${record.userId}`);
        if (record.taskId) extra.push(`task=${record.taskId}`);
        if (record.task) extra.push(`task="${String(record.task).slice(0, 80)}"`);
        if (record.reason) extra.push(`reason=${record.reason}`);

        // 关键：错误必须把原因显示出来。之前这里漏了 errorMessage，
        // 导致控制台只有光秃秃的 [audit] task_error，真正的失败原因
        // （例如 spawn EINVAL）被吞掉，只能翻日志文件才知道。
        if (record.errorMessage) extra.push(`错误=${String(record.errorMessage).slice(0, 300)}`);
        if (record.errorCode) extra.push(`code=${record.errorCode}`);
        if (record.where) extra.push(`where=${record.where}`);
        if (record.exitCode !== undefined && record.exitCode !== null) {
          extra.push(`exit=${record.exitCode}`);
        }
        if (record.msg) extra.push(String(record.msg).slice(0, 300));

        const tail = extra.length ? `  ${extra.join(' ')}` : '';
        const isProblem = event.includes('block')
          || event === AuditEvent.TASK_ERROR
          || event === AuditEvent.SEND_FAILED
          || event === AuditEvent.ERROR
          || event === AuditEvent.TASK_TIMEOUT
          || event === AuditEvent.UNAUTHORIZED;
        const color = isProblem
          ? '\x1b[31m' : (event.startsWith('task') ? '\x1b[36m' : '\x1b[90m');
        console.log(`${color}[audit] ${event}${tail}\x1b[0m`);
      }
    }

    if (!this.healthy) return false;

    try {
      appendFileSync(this.filePath(), JSON.stringify(record) + '\n', 'utf8');
      return true;
    } catch (e) {
      // 审计写入失败不能让主流程挂掉，但必须让人知道
      this.healthy = false;
      console.error(`[审计降级] 无法写入审计日志: ${e.message}`);
      return false;
    }
  }

  /** 便捷方法。 */
  info(event, data) { return this.log(event, data); }
  warn(event, data) { return this.log(event, data); }

  /** 健康状态，供启动自检报告。 */
  status() {
    return {
      healthy: this.healthy,
      dir: this.dir,
      file: this.filePath(),
      error: this.initError,
    };
  }
}
