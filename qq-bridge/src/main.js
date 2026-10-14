/**
 * 桥接服务主入口
 *
 * 把 QQ 消息翻译成 DSH 任务，并把结果送回 QQ。
 *
 * 消息处理流水线（顺序不可调换，每道都是必要防线）：
 *
 *   1. 提取发送者 openid 与文本
 *   2. 白名单校验       —— 不在名单：静默丢弃，不暴露机器人存在
 *   3. 控制指令识别     —— /help /status /cancel /new 等本地处理
 *   4. 二次确认识别     —— "确认 XXXX" 消费待确认令牌
 *   5. 速率限制         —— 超限则告知重试时间
 *   6. 策略分级         —— BLOCK 拒绝 / CONFIRM 发令牌 / SAFE 放行
 *   7. 执行 DSH 任务    —— 子进程 + 事件流解析
 *   8. 结果分段回送     —— 超长输出落盘为文件
 *
 * 启动方式（必须在 DSH 沙箱之外，见 README）：
 *   bin\node.cmd src\main.js
 */

import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { loadConfig, describeConfig, ConfigError, mask } from './config/index.js';
import { AuditLogger, AuditEvent } from './audit/index.js';
import { RateLimiter } from './ratelimit/index.js';
import { classify } from './policy/index.js';
import { runDshTask, buildChildEnv } from './dsh/runner.js';
import { describeResult, planSessionCleanup } from './dsh/events.js';
import { checkDshHomeWritable, LAUNCH_CONTEXT_HINT } from './dsh/launch-context.js';
import { SessionStore } from './state/index.js';
import {
  ApprovalManager,
  buildApprovalKeyboard,
  buildApprovalPrompt,
  parseButtonData,
  extractInteractionUserId,
  extractButtonData,
  ackText,
} from './qq/approval.js';
import {
  chunkText, withParts, summarizeForChat,
} from './output/chunk.js';
import { sendArtifact, wantsFileDelivery, extractSendablePath, extractMarkedSendFile, sendExistingFile } from './output/artifacts.js';
import { join, resolve } from 'node:path';
import { ProgressReporter } from './progress/reporter.js';
import { SingletonGuard } from './guard/index.js';
import { MemoryBank } from './memory/index.js';
import { extractImages, downloadImages } from './qq/inbound-images.js';

const VERSION = '0.1.0';

/** 本地控制指令（不经过策略引擎与 DSH）。 */
const COMMANDS = {
  '/help': 'help',
  '/帮助': 'help',
  '/status': 'status',
  '/状态': 'status',
  '/cancel': 'cancel',
  '/取消': 'cancel',
  '/new': 'new',
  '/新会话': 'new',
  '/run': 'run',
  '/启动': 'run',
  '/remember': 'remember',
  '/记住': 'remember',
  '/memory': 'memory',
  '/记忆': 'memory',
};

export class Bridge {
  constructor({ config, credentials, sources, dshHomeProbe = null }) {
    this.config = config;
    this.credentials = credentials;
    this.sources = sources;

    /**
     * 启动环境探针（可注入，便于测试）：返回 {ok, dir, error}。
     * 默认真去 %USERPROFILE%\.dsh 里建一个临时文件再删（见 launch-context.js）。
     */
    this.dshHomeProbe = dshHomeProbe ?? (() => checkDshHomeWritable());

    this.audit = new AuditLogger({
      dir: config.logging.dir,
      retainDays: config.logging.retainDays,
      level: config.logging.level,
    });
    this.rateLimiter = new RateLimiter(config.security.rateLimit);
    this.sessions = new SessionStore(join(config.logging.dir, '..', 'state', 'sessions.json'));
    this.approvals = new ApprovalManager({ ttlMs: config.security.confirmTtlMs });

    // 长期记忆库（每个任务开始时注入给 agent，见 executeTask）
    this.memory = new MemoryBank({
      dir: config.memory?.dir,
      file: config.memory?.file,
      maxInjectChars: config.memory?.maxInjectChars,
      maxFileChars: config.memory?.maxFileChars,
      enabled: config.memory?.enabled !== false,
    });

    /** @type {Map<string, AbortController>} 正在运行的任务，供 /cancel 使用 */
    this.running = new Map();

    /** 图片下载用的 fetch（测试可注入；生产用全局 fetch） */
    this.fetchImpl = null;

    this.allowSet = new Set(config.security.allowedOpenIds.map(String));
    this.startedAt = Date.now();
    this.stats = { received: 0, authorized: 0, rejected: 0, completed: 0, failed: 0, blocked: 0 };
  }

  /** 启动前自检，打印一份人类可读的体检报告。 */
  selfCheck() {
    const lines = [];
    const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m');

    lines.push('');
    lines.push('='.repeat(64));
    lines.push(`  DSH-QQ 桥接服务 v${VERSION}  启动自检`);
    lines.push('='.repeat(64));

    const auditStatus = this.audit.status();
    lines.push(`${ok(auditStatus.healthy)} 审计日志    ${auditStatus.dir}`);
    if (!auditStatus.healthy) {
      lines.push(`      \x1b[31m审计不可用: ${auditStatus.error}\x1b[0m`);
      lines.push('      继续运行存在风险：出问题将无法追溯。建议修复后再启动。');
    }

    lines.push(`${ok(this.allowSet.size > 0)} 白名单      ${this.allowSet.size} 个用户`);
    if (this.allowSet.size === 0) {
      lines.push('      \x1b[31m空白名单 = 机器人会拒绝所有人。\x1b[0m');
      lines.push('      请先运行 src\\probe.js 取得你的 openid 后填入配置。');
    } else {
      for (const id of this.allowSet) lines.push(`      - ${id}`);
    }

    lines.push(`${ok(true)} 工作区      ${this.config.dsh.workspace}`);

    // ── 启动环境：本进程能否写 DSH 的配置目录？──────────────────────
    //
    // 真实事故（2026-10-14）：桥接被某个 DSH 会话从沙箱内拉起，它 spawn 的
    // dsh 子进程继承了低完整性令牌，写不了 workspace 之外的
    // %USERPROFILE%\.dsh\profiles\<profile>\cordis.yml —— 每条指令都在
    // 0.1 秒内 EPERM 失败。这里先真写一个探针文件，把问题在启动横幅里点破，
    // 而不是留给用户一条几百字的 Node 崩溃堆栈。
    const probe = this.dshHomeProbe();
    lines.push(`${ok(probe.ok)} DSH 配置目录 ${probe.dir}`);
    if (!probe.ok) {
      lines.push(`      \x1b[31m✗ 写不进去: ${probe.error}\x1b[0m`);
      lines.push('      本进程多半是在 DSH 会话的沙箱里被拉起的（低完整性令牌会被');
      lines.push('      子进程继承）：它启动的 dsh 子进程写不了 workspace 之外的 profile，');
      lines.push('      于是**每条指令都会以 EPERM 失败**，且现象模糊、极难定位。');
      lines.push('      修法：关掉本进程，改从普通窗口/双击启动：');
      lines.push('            scripts\\start-all.cmd（或「Qwen控制台」）');
    }
    if (this.config.dsh.nodeExe && this.config.dsh.jsEntry) {
      // 直接调 Node 入口 = 不经 cmd.exe = 任务文本不会被当 shell 语法
      lines.push(`${ok(true)} DSH 调用    直接 Node（无 cmd.exe，无注入风险）`);
      lines.push(`      Node      ${this.config.dsh.nodeExe}`);
      lines.push(`      入口      ${this.config.dsh.jsEntry}`);
    } else {
      lines.push(`${ok(false)} DSH 调用    经 cmd.exe（\x1b[31m存在命令注入风险\x1b[0m）`);
      lines.push(`      ${this.config.dsh.cliPath}`);
      lines.push('      \x1b[33m建议配置 dsh.nodeExe + dsh.jsEntry\x1b[0m');
    }
    lines.push(`${ok(true)} 任务超时    ${this.config.dsh.timeoutMs} ms`);
    if (this.config.dsh.sandboxTempDir) {
      lines.push(`${ok(true)} 沙箱临时目录 ${this.config.dsh.sandboxTempDir}`);
    }

    // DSH 权限：决定 agent 能写到哪、要不要审批。
    // ── 运行环境：强烈建议不在 DSH 会话沙箱内 ─────────────────────────
    //
    // 本服务应运行在 DSH 沙箱之外。在沙箱内的后果是：它 spawn 的 DSH 子进程
    // 可能受同一约束，导致权限配置达不到预期，且现象模糊、极难定位。
    const inDshSession = Boolean(process.env.DSH_SESSION_ID || process.env.DSH_SHELL || process.env.DSH_PROFILE);
    if (inDshSession) {
      lines.push('');
      lines.push('\x1b[33m⚠ 注意：本服务运行在 DSH 会话环境内\x1b[0m');
      lines.push(`     DSH_SESSION_ID = ${process.env.DSH_SESSION_ID ?? '(无)'}`);
      lines.push(`     DSH_PROFILE    = ${process.env.DSH_PROFILE ?? '(无)'}`);
      lines.push('     桥接已剥离这些变量再传给子进程，但若行为异常，');
      lines.push('     仍建议改到沙箱之外的普通 cmd 窗口启动（或用 scripts\\install-task.cmd）。');
      lines.push('');
    }

    // ── 权限：读**即将注入给子进程的配置值**，而非 profile 的 patch 文件 ──
    //
    // 早先的版本去解析 headless profile 的 cordis.patch.yml 来推断模式，
    // 那套逻辑连错两次（patch id 写错、机制理解错），还会给出"看起来已放开"
    // 的乐观结论。真正生效的机制是环境变量 DSH_PERMISSION_MODE，
    // 由 `dsh --dump-config` 可见：
    //     sandbox-policy.mode = DSH_PERMISSION_MODE ?? 'workspace-write'
    //     approval.policy     = DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask'
    const mode = this.config.dsh.permissionMode ?? null;

    if (mode === 'danger-full-access') {
      lines.push('\x1b[31m⚠ 权限        danger-full-access（全盘可写，DSH 内不再审批）\x1b[0m');
      lines.push('     机制      DSH_PERMISSION_MODE 环境变量');
      lines.push('     提醒：这台电脑的安全边界现在等于你的 QQ 账号。');
      lines.push('           收紧办法：config.json 的 dsh.permissionMode 改回 workspace-write');
    } else if (mode === 'workspace-write') {
      lines.push(`${ok(true)} 权限        workspace-write（仅可写工作区）`);
    } else if (mode === 'read-only') {
      lines.push('\x1b[33m⚠ 权限        read-only（agent 无法写任何文件）\x1b[0m');
    } else {
      lines.push('\x1b[33m? 权限        未指定（用 DSH 默认 workspace-write）\x1b[0m');
    }

    // 把"实际会传给 DSH 子进程的环境变量"打出来。
    //
    // 为什么需要：这一项排查了七轮都卡在"以为配好了、其实没传下去"。
    // 只要这行显示的值与预期不符，就说明运行的 jar 版本旧了或接线断了 ——
    // 看一眼即可判断，不必再去问 agent 或读日志。
    const probeEnv = buildChildEnv(process.env, {}, {
      directNode: true,
      permissionMode: this.config.dsh.permissionMode,
    });
    lines.push(`     注入子进程 DSH_PERMISSION_MODE=${probeEnv.DSH_PERMISSION_MODE ?? '(未设置)'}`);
    lines.push(`     剥离确认   DSH_PROFILE=${probeEnv.DSH_PROFILE ?? '(已剥离)'}`);
    lines.push(`${ok(true)} 凭证        AppID=${mask(this.credentials.appId)}`);

    if (this.sources.configFile) lines.push(`     配置来源    ${this.sources.configFile}`);
    if (this.sources.credsFile) lines.push(`     凭证来源    ${this.sources.credsFile}`);

    lines.push(`${ok(this.config.security.policyEnabled)} 策略引擎    ${this.config.security.policyEnabled ? '已启用' : '\x1b[31m已禁用（不推荐）\x1b[0m'}`);
    lines.push(`${ok(true)} 速率限制    每分 ${this.config.security.rateLimit.perUserPerMinute} / 每时 ${this.config.security.rateLimit.perUserPerHour}（全局每分 ${this.config.security.rateLimit.globalMinute ?? this.config.security.rateLimit.globalPerMinute}）`);
    lines.push('='.repeat(64));
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 发送审批提示（带可选按钮）。
   *
   * 优先发带按钮的版本（手机点一下即可）；按钮因权限/客户端版本等原因
   * 发送失败时，回退为纯文本（用户回复「确认 XXXX」），保证审批路径不断。
   */
  async sendApprovalPrompt(target, task, token, reasons, expiresInSec) {
    const prompt = buildApprovalPrompt(task, token, reasons, expiresInSec);
    const keyboard = buildApprovalKeyboard(token);

    if (typeof this.bot?.sendTextWithKeyboard === 'function') {
      try {
        await this.bot.sendTextWithKeyboard(target, prompt, keyboard);
        this.audit.log(AuditEvent.POLICY_CONFIRM_PENDING, {
          userId: target?.targetId,
          delivered: 'keyboard',
          token,
        });
        return;
      } catch (e) {
        // 按钮不可用（例如机器人没有相应权限）——不算致命，回退文本
        this.audit.log(AuditEvent.SEND_FAILED, {
          target: target?.targetId,
          errorMessage: `按钮发送失败，回退为文本: ${e.message}`,
        });
      }
    }

    await this.sendText(target, prompt);
    this.audit.log(AuditEvent.POLICY_CONFIRM_PENDING, {
      userId: target?.targetId,
      delivered: 'text',
      token,
    });
  }

  /**
   * 处理按钮点击（interaction 事件）。
   *
   * 安全要点：
   *   - 点按钮的人必须与创建该待确认项的人是同一个用户
   *   - button_data 是不可信输入，解析失败一律拒绝
   *   - 无论允许还是拒绝，都先 acknowledge，避免客户端一直转圈
   */
  async onInteraction(ctx, event) {
    const userId = extractInteractionUserId(event);
    const raw = extractButtonData(event);
    const parsed = parseButtonData(raw);

    // 尽力回应，避免用户看到"无响应"
    const ack = async (code, text) => {
      try {
        await this.bot?.acknowledgeInteraction?.(event?.id, code, {
          text: text ?? ackText(parsed?.action ?? ''),
        });
      } catch { /* 回应失败不影响主流程 */ }
    };

    if (!parsed) {
      this.audit.log(AuditEvent.ERROR, {
        where: 'onInteraction',
        errorMessage: '按钮数据无法解析，已拒绝',
        raw: String(raw ?? '').slice(0, 120),
        userId,
      });
      await ack(1, '⚠️ 无法识别的操作');
      return;
    }

    if (!userId) {
      // 取不到用户标识就无法做归属校验 —— 必须拒绝
      this.audit.log(AuditEvent.POLICY_CONFIRM_REJECTED, {
        reason: '按钮点击缺少用户标识，无法校验归属',
        token: parsed.token,
      });
      await ack(1, '⚠️ 无法校验身份');
      return;
    }

    // 未授权用户点了按钮也不能确认任何事
    if (!this.allowSet.has(userId)) {
      this.audit.log(AuditEvent.UNAUTHORIZED, {
        userId, where: 'onInteraction', token: parsed.token,
      });
      await ack(1);
      return;
    }

    const target = {
      scope: event?.group_openid ? 'group' : 'c2c',
      targetId: event?.group_openid ?? userId,
    };

    if (parsed.action === 'deny') {
      // 拒绝也要消费掉令牌，否则它还能被文本路径用掉
      this.approvals.consume(userId, parsed.token);
      this.audit.log(AuditEvent.POLICY_CONFIRM_REJECTED, {
        userId, token: parsed.token, via: 'button',
      });
      await ack(0);
      await this.sendText(target, '❌ 已拒绝，指令不会执行。');
      return;
    }

    const res = this.approvals.consume(userId, parsed.token);
    if (!res.ok) {
      this.audit.log(AuditEvent.POLICY_CONFIRM_REJECTED, {
        userId, token: parsed.token, reason: res.reason, via: 'button',
      });
      await ack(1, '⚠️ 已过期');
      await this.sendText(target, `⚠️ 确认失败：${res.reason}\n请重新发送原始指令。`);
      return;
    }

    this.audit.log(AuditEvent.POLICY_CONFIRMED, {
      userId, task: res.task.slice(0, 200), via: 'button',
    });
    await ack(0);
    await this.sendText(target, '✅ 已确认，开始执行…');
    await this.executeTask(res.task, target, userId, { skipPolicy: true });
  }

  /** 发送一条文本，自动分段。 */
  async sendText(target, text) {
    const chunks = withParts(
      chunkText(text, this.config.output.maxMessageChars)
    );
    for (const c of chunks) {
      try {
        await this.bot.sendText(target, c);
      } catch (e) {
        // ★ 被动回复配额：QQ 限制「针对同一条用户消息最多 4 条被动回复」
        //   （SDK 的 ReplyLimiter 默认 limit=4，窗口 1 小时）。长任务+进度播报
        //   很容易把配额吃光，于是**最终结果发不出去** —— 用户看到的现象正是
        //   "任务跑着跑着没声了"。这里降级为**主动消息**再试一次（去掉 msgId
        //   即为主动，见 SDK 的 SendMessageOptions.target 说明）。
        let recovered = false;
        if (target && target.msgId) {
          try {
            const proactive = { ...target };
            delete proactive.msgId;
            await this.bot.sendText(proactive, c);
            recovered = true;
            this.audit.log(AuditEvent.DIAG, {
              where: 'send',
              msg: '被动回复发送失败，已降级为主动消息并成功',
              error: e.message,
            });
          } catch (e2) {
            this.audit.log(AuditEvent.SEND_FAILED, {
              target: target?.targetId,
              error: `${e.message}（降级主动消息仍失败: ${e2.message}）`,
              chunkPreview: c.slice(0, 120),
            });
            break;
          }
        } else {
          this.audit.log(AuditEvent.SEND_FAILED, {
            target: target?.targetId,
            error: e.message,
            chunkPreview: c.slice(0, 120),
          });
          break;
        }
        if (recovered) continue;
      }
    }
  }

  /** 处理本地控制指令。 */
  async handleCommand(cmd, target, userId, arg = '') {
    switch (cmd) {
      case 'help':
        await this.sendText(target, [
          'DSH-QQ 桥接服务',
          '',
          '直接发自然语言指令即可，例如：',
          '  · 帮我看看 D 盘剩余空间',
          '  · 分析一下 logs 目录里的错误',
          '  · 统计这个项目有多少行代码',
          '',
          '本地指令：',
          '  /status  查看服务状态',
          ...(this.config.dsh.persistSession
            ? ['  /new     开启新会话（清空上下文）']
            : ['  /new     已默认「每条指令都是全新上下文」，本命令无需使用']),
          '  /remember 内容  让机器人长期记住（写入记忆库 md）',
          '  /memory  查看长期记忆库',
          '  /cancel  取消正在执行的任务',
          '  /help    显示本帮助',
          '',
          '安全说明：',
          '  · 只读类指令直接执行',
          '  · 会修改文件或系统的指令需要你回复「确认 XXXX」',
          '  · 破坏性指令会被永久拒绝',
        ].join('\n'));
        this.audit.log(AuditEvent.MESSAGE_IN, { userId, command: cmd });
        return true;

      case 'status': {
        const usage = this.rateLimiter.usage(userId);
        const uptimeMin = Math.round((Date.now() - this.startedAt) / 60000);
        const session = this.sessions.get(userId);
        await this.sendText(target, [
          '服务状态',
          '',
          `运行时长   : ${uptimeMin} 分钟`,
          `当前任务   : ${this.running.has(userId) ? '执行中' : '空闲'}`,
          `会话       : ${this.config.dsh.persistSession
            ? (session ? session.slice(0, 24) + '…' : '（无，下次开新会话）')
            : '（已禁用接续：每条指令都是全新上下文）'}`,
          `待确认     : ${this.approvals.countFor(userId)} 项`,
          '',
          `本分钟用量 : ${usage.lastMinute}/${usage.limits.perUserPerMinute}`,
          `本小时用量 : ${usage.lastHour}/${usage.limits.perUserPerHour}`,
          '',
          `累计接收   : ${this.stats.received}`,
          `已拦截     : ${this.stats.blocked}`,
        ].join('\n'));
        this.audit.log(AuditEvent.MESSAGE_IN, { userId, command: cmd });
        return true;
      }

      case 'new':
        this.sessions.clear(userId);
        await this.sendText(target, this.config.dsh.persistSession
          ? '✅ 已开启新会话，下次指令将不带历史上下文。'
          : '✅ 已开启新会话（当前配置本来就是每条指令都开新上下文，本条无实际影响）。');
        this.audit.log(AuditEvent.MESSAGE_IN, { userId, command: cmd });
        return true;

      case 'cancel': {
        const ctrl = this.running.get(userId);
        if (!ctrl) {
          await this.sendText(target, '当前没有正在执行的任务。');
        } else {
          ctrl.abort();
          await this.sendText(target, '🛑 已发送取消信号，正在终止任务…');
          this.audit.log(AuditEvent.TASK_CANCELLED, { userId });
        }
        return true;
      }

      case 'run': {
        // 已弃用：曾用"由桥接直接启动程序"绕开 DSH 沙箱，但那是绕过问题而非解决，
        // 且用户的目标是用**自然语言**控制电脑，不是记专用指令。
        // 保留壳只是为了给旧配置一个明确提示，实际不做启动。
        await this.sendText(target, [
          '/run 已弃用。',
          '',
          '它当初是为了绕开 DSH 沙箱（GUI 程序写 %APPDATA% 被拦）。',
          '但那是绕过症状，不是解决 —— 目标是让你用自然语言控制电脑。',
          '正确做法是修好沙箱权限，无需专用指令。',
        ].join('\n'));
        return true;
      }

      case 'remember': {
        const content = String(arg ?? '').trim();
        if (!content) {
          await this.sendText(target, [
            '用法：/remember 内容',
            '',
            '例如：',
            '  /remember 我的项目都在 D:\\work，不要动 C:\\Windows',
            '  /remember 每次给我文件时直接发文件，不要把内容贴成文字',
            '',
            `记忆库文件：${this.memory?.filePath ?? '(未配置)'}`,
            '（也可以直接编辑那个 md 文件；或直接对我说「记住：…」）',
          ].join('\n'));
          this.audit.log(AuditEvent.MESSAGE_IN, { userId, command: cmd });
          return true;
        }

        const res = this.memory.append(content);
        const stats = this.memory.stats();
        if (res.ok) {
          await this.sendText(target, [
            '✅ 已记入长期记忆',
            '',
            `现在共 ${stats.entries} 条 / ${stats.chars} 字`,
            '',
            '以后每次任务都会带上它。说「忘记…」或直接编辑文件都可以改。',
          ].join('\n'));
        } else {
          await this.sendText(target, `❌ 记入失败：${this.#memoryFailReason(res.reason)}`);
        }
        this.audit.log(AuditEvent.DIAG, {
          where: 'memory', action: 'append', ok: !!res.ok,
          reason: res.reason ?? null, chars: stats.chars, entries: stats.entries,
        });
        return true;
      }

      case 'memory': {
        const stats = this.memory.stats();
        const head = [
          '🧠 长期记忆库',
          '',
          `状态 : ${stats.enabled ? '已启用' : '已禁用（config.memory.enabled=false）'}`,
          `条数 : ${stats.entries}`,
          `大小 : ${stats.chars} 字`,
          `文件 : ${stats.path}`,
        ].join('\n');
        const content = this.memory.read().trim();
        await this.sendText(target, content
          ? `${head}\n\n———— 内容 ————\n${content}`
          : `${head}\n\n（还是空的。发 /remember 内容 就能加一条）`);
        this.audit.log(AuditEvent.MESSAGE_IN, { userId, command: cmd });
        return true;
      }

      default:
        return false;
    }
  }

  /** 把记忆写入失败的原因翻成人话。 */
  #memoryFailReason(reason) {
    switch (reason) {
      case 'disabled': return '记忆功能已关闭（config.memory.enabled=false）';
      case 'empty': return '内容为空';
      case 'no-dir': return '记忆库目录未配置（config.memory.dir）';
      case 'file-too-large': return '记忆库已满（超过 config.memory.maxFileChars），请先清理';
      case 'would-exceed': return '这一条会让记忆库超出大小上限，请精简或先清理';
      default: return String(reason ?? '未知原因');
    }
  }

  /** 主消息处理入口。 */
  async onMessage(ctx, msg) {
    const userId = String(msg?.replyTarget?.targetId ?? '');
    const target = msg?.replyTarget;
    const text = String(msg?.content ?? '').trim();
    const scope = target?.scope;

    this.stats.received++;

    // ── 2. 白名单（fail-closed）
    if (!this.allowSet.has(userId)) {
      this.stats.rejected++;
      this.audit.log(AuditEvent.UNAUTHORIZED, {
        userId,
        scope,
        preview: text.slice(0, 60),
      });
      if (this.config.security.notifyUnauthorized) {
        await this.sendText(target, '⛔ 未授权用户。');
      }
      // 静默丢弃：不回复，不暴露机器人存在
      return;
    }
    this.stats.authorized++;

    // ── 群聊默认不响应
    if (scope === 'group' && !this.config.qq.allowGroup) {
      this.audit.log(AuditEvent.MESSAGE_IN, { userId, scope, ignored: 'group-disabled' });
      return;
    }

    // ── 图片：QQ 里直接发图时 content 往往是空的，必须在"空消息"判断之前处理。
    //    下载到本地后把路径交给 agent 的 read_image（headless CLI 没有传图入口）。
    const images = extractImages(msg);
    let imagePaths = [];
    if (images.length) {
      const dir = this.config.qq.imageDir;
      const saved = await downloadImages({
        images,
        dir,
        maxBytes: this.config.qq.maxImageBytes,
        timeoutMs: this.config.qq.imageDownloadTimeoutMs,
        fetchImpl: this.fetchImpl,
        log: (m) => this.audit.log(AuditEvent.DIAG, { where: 'image', msg: m }),
      });
      imagePaths = saved.filter((s) => s.ok).map((s) => s.path);
      const failed = saved.filter((s) => !s.ok);
      this.audit.log(AuditEvent.DIAG, {
        where: 'image',
        count: images.length,
        saved: imagePaths.length,
        failed: failed.map((f) => f.reason),
      });
      if (!imagePaths.length) {
        await this.sendText(target, [
          '⚠️ 收到图片但没能保存下来，无法识别。',
          ...failed.map((f) => `· ${f.reason}`),
        ].join('\n'));
        return;
      }
    }

    if (!text && !imagePaths.length) {
      await this.sendText(target, '请发送具体指令，例如「帮我看看 D 盘剩余空间」。');
      return;
    }

    // ── 3. 本地控制指令
    //
    // /remember（/记住）需要带参数，所以按"前缀 + 内容"匹配；
    // 其余指令仍要求整条消息完全相等，避免"状态"之类被误触发。
    const rememberMatch = /^\/(?:remember|记住)\s*([\s\S]*)$/i.exec(text);
    if (rememberMatch) {
      await this.handleCommand('remember', target, userId, rememberMatch[1]);
      return;
    }

    const lower = text.toLowerCase();
    if (COMMANDS[lower]) {
      await this.handleCommand(COMMANDS[lower], target, userId);
      return;
    }

    // ── 4. 二次确认
    const confirmMatch = /^(?:确认|confirm)\s*[:：]?\s*([A-Za-z0-9]{4,10})$/i.exec(text);
    if (confirmMatch) {
      const token = confirmMatch[1];
      const res = this.approvals.consume(userId, token);
      if (!res.ok) {
        this.audit.log(AuditEvent.POLICY_CONFIRM_REJECTED, {
          userId, token, reason: res.reason,
        });
        await this.sendText(target, `⚠️ 确认失败：${res.reason}\n请重新发送原始指令。`);
        return;
      }
      this.audit.log(AuditEvent.POLICY_CONFIRMED, { userId, task: res.task.slice(0, 200) });
      await this.sendText(target, '✅ 已确认，开始执行…');
      await this.executeTask(res.task, target, userId, { skipPolicy: true });
      return;
    }

    // ── 5. 速率限制
    const rl = this.rateLimiter.check(userId);
    if (!rl.allowed) {
      this.audit.log(AuditEvent.RATE_LIMITED, { userId, scope: rl.scope, reason: rl.reason });
      await this.sendText(target, `⚠️ 操作过于频繁（${rl.reason}）\n请 ${rl.retryAfterSec} 秒后再试。`);
      return;
    }

    // ── 6. 策略分级
    if (this.config.security.policyEnabled) {
      const verdict = classify(text);

      if (verdict.verdict === 'BLOCK') {
        this.stats.blocked++;
        this.audit.log(AuditEvent.POLICY_BLOCKED, {
          userId,
          task: text.slice(0, 300),
          matched: verdict.matched,
          reasons: verdict.reasons,
        });
        await this.sendText(target, [
          '🚫 该指令被安全策略拦截，不会执行。',
          '',
          ...verdict.reasons.slice(0, 4).map((r) => `· ${r}`),
          '',
          '如果你认为这是误判，请在电脑上手动执行。',
        ].join('\n'));
        return;
      }

      if (verdict.verdict === 'CONFIRM') {
        const { token, expiresInSec } = this.approvals.create(userId, text, verdict.reasons);
        this.audit.log(AuditEvent.POLICY_CONFIRM_PENDING, {
          userId,
          task: text.slice(0, 300),
          token,
          matched: verdict.matched,
        });
        await this.sendApprovalPrompt(target, text, token, verdict.reasons, expiresInSec);
        return;
      }
    }

    // ── 7. 执行
    // 只有图片没有文字时，给一句默认意图，否则 agent 收到的是空任务。
    const taskText = text || '（用户只发来图片，没有文字）请看图并按你的判断处理或说明。';
    await this.executeTask(taskText, target, userId, { imagePaths });
  }

  /** 执行一个 DSH 任务并把结果送回。 */
  async executeTask(task, target, userId, { skipPolicy = false, imagePaths = [] } = {}) {
    // 同一用户同时只允许一个任务，避免上下文互相污染
    if (this.running.has(userId)) {
      await this.sendText(target, '⏳ 你已有一个任务在执行中。发送 /cancel 可取消，或等待其完成。');
      return;
    }

    const ctrl = new AbortController();
    this.running.set(userId, ctrl);

    const sessionId = this.config.dsh.persistSession ? this.sessions.get(userId) : null;

    // 长期记忆：每个任务开始时注入（记忆库为空则什么都不加）。
    // 为什么每次都要注入而不是只注入一次：DSH 每轮都是新进程，而记忆库
    // 可能刚被 /remember 或 agent 自己更新过。
    const memoryText = this.memory?.injectText?.() ?? '';
    const memoryPath = this.memory?.enabled ? this.memory.filePath : '';

    this.audit.log(AuditEvent.TASK_START, {
      userId,
      task: task.slice(0, 500),
      sessionId,
      skipPolicy,
    });

    // 收到任务的确认语：默认发，但本机关掉了（用户只要最终结果，
    // 而且它同样会消耗 QQ 的被动回复配额 —— 单条消息最多 4 条）。
    if (this.config.progress?.ackOnAccept !== false) {
      await this.sendText(target, `⏳ 已接受任务，正在执行…${sessionId ? '（接续上次会话）' : ''}`);
    }

    // 进度推送：长任务期间给用户反馈"现在在干什么"（工具名 + 关键参数），
    // 而不是空洞的"仍在执行"。短任务（默认 <8s 静默期）不会推送任何东西。
    const progress = new ProgressReporter({
      send: (text) => this.sendText(target, text),
      log: (msg) => this.audit.log(AuditEvent.DIAG, { where: 'progress', msg }),
      minIntervalMs: this.config.progress?.minIntervalMs,
      maxPushes: this.config.progress?.maxPushes,
      silentBeforeMs: this.config.progress?.silentBeforeMs,
    });

    // 心跳：长 prefill / 长生成期间 DSH 一个事件都不发，靠它报"还在跑、在跑什么"。
    // 计时器放在这里而不是播报模块内部：模块用假时钟测试，内建计时器会让测试
    // 不可确定，也容易在 finish 后泄漏。
    const hbMs = Number(this.config.progress?.heartbeatMs);
    const heartbeat = Number.isFinite(hbMs) && hbMs > 0
      ? setInterval(() => { progress.heartbeat().catch(() => {}); }, Math.max(1000, hbMs))
      : null;

    let result;
    try {
      result = await runDshTask(task, {
        cliPath: this.config.dsh.cliPath,
        nodeExe: this.config.dsh.nodeExe,
        jsEntry: this.config.dsh.jsEntry,
        sandboxTempDir: this.config.dsh.sandboxTempDir,
        permissionMode: this.config.dsh.permissionMode,
        workspace: this.config.dsh.workspace,
        timeoutMs: this.config.dsh.timeoutMs,
        idleTimeoutMs: this.config.dsh.idleTimeoutMs,
        sessionId,
        memoryText,
        memoryPath,
        imagePaths,
        signal: ctrl.signal,
        onEvent: (ev) => { progress.onEvent(ev).catch(() => {}); },
        logger: {
          info: (m) => this.audit.log(AuditEvent.DIAG, { where: 'runner', level: 'info', msg: m }),
          warn: (m) => this.audit.log(AuditEvent.DIAG, { where: 'runner', level: 'warn', msg: m }),
          error: (m) => this.audit.log(AuditEvent.ERROR, { where: 'runner', msg: m }),
        },
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.running.delete(userId);
    }

    // 收尾：超时/取消时补一句说明。正常结束不发（避免与正式结果重复）。
    try {
      await progress.finish(result);
    } catch { /* 进度收尾失败不影响结果回送 */ }

    // 记录会话，供下次接续
    if (result.sessionId && this.config.dsh.persistSession) {
      this.sessions.set(userId, result.sessionId);
    }

    if (result.ok) this.stats.completed++; else this.stats.failed++;

    this.audit.log(
      result.timedOut ? AuditEvent.TASK_TIMEOUT
        : result.killed ? AuditEvent.TASK_CANCELLED
          : result.ok ? AuditEvent.TASK_DONE
            : AuditEvent.TASK_ERROR,
      {
        userId,
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        turns: result.turns,
        steps: result.steps,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        // 关键：进程无事件退出时（例如 --session-id 未知导致 DSH 立即报错），
        // errorMessage 会是 null，真正的线索只在 stderr 里。
        // 之前这里没记 stderr，导致排障时完全看不到原因。
        stderr: String(result.stderr ?? '').slice(-2000),
        eventCount: result.eventCount,
        textPreview: String(result.text ?? '').slice(0, 500),
      }
    );

    // 陈旧会话自愈：
    //
    // DSH 的会话与工作目录绑定。一旦改了 workspace，旧 sessionId 就不再适用，
    // DSH 会拒绝并明说（文字在 stderr）：
    //   dsh: session "…" was recorded in "%USERPROFILE%", not "...\Desktop"
    //
    // 若不清理，这个坏会话会被反复复用，于是**每条指令都失败**。
    // 判定逻辑抽在 planSessionCleanup 里（可测）—— 原先内联在此处时，
    // 因测试把 executeTask 整个 mock 掉而从未被执行过。
    const cleanup = planSessionCleanup(result, sessionId, {
      workspace: this.config.dsh.workspace,
      persistSession: this.config.dsh.persistSession,
    });

    if (cleanup.clearSession) {
      this.sessions.clear(userId);
      this.audit.log(AuditEvent.DIAG, { where: 'session', msg: cleanup.auditMessage });
    }

    // ── 8. 回送结果
    let reply = describeResult(result);

    if (cleanup.userMessage) {
      reply = cleanup.userMessage;
    }

    const artifactLog = (event, data) => this.audit.log(AuditEvent.DIAG, {
      where: 'artifact', event, ...(data ?? {}),
    });

    // ── 8a. 用户明确要文件时，直接把文件发过去 ─────────────────────
    //
    // 这是修一个真实的设计错误：早先只有一个触发条件「结果文本超过阈值就发文件」。
    // 实测「把桌面的简历发给我」时，agent 因为没有投递通道，改为把 PDF 全文
    // 提取成文字贴出来（1295 字符 < 阈值 6000），于是桥接按文本发走 ——
    // 用户要文件，收到的是一堆文字。
    //
    // 正确的判据是「用户要的是不是文件」，与结果长短无关。
    //
    // 2026-10-12 修复：显式 `SEND_FILE:` 标记**始终生效**（它是 agent 与桥接
    // 的明确契约，系统提示里就约定过），不再依赖用户措辞是否像文件请求；
    // 只有「路径+扩展名」兜底启发式仍受 wantsFileDelivery 门控，防误报。
    // 此前「todesk 登陆」这类消息里 agent 发的 SEND_FILE 被整条忽略，
    // 用户只收到文字没收到文件。
    if (result.ok) {
      const filePath =
        extractMarkedSendFile(reply) ??
        (wantsFileDelivery(task) ? extractSendablePath(reply) : null);

      if (filePath) {
        this.audit.log(AuditEvent.DIAG, {
          where: 'artifact', event: 'requested-file-detected', path: filePath,
        });

        const sent = await sendExistingFile(this.bot, target, filePath, {
          log: artifactLog,
          content: '你要的文件',
        });

        if (sent.ok) {
          // 附一句简短说明（不含全文，避免刷屏）
          await this.sendText(target, `📄 已发送：${filePath}`);
          return;
        }

        // 发送失败（常见原因：机器人没有文件消息权限）——降级但不丢结果
        await this.sendText(target, [
          `⚠️ 找到文件但发送失败：${sent.reason}`,
          '',
          '文件位置：',
          filePath,
          '',
          '如果提示权限不足，需要在 QQ 开放平台为机器人申请文件消息权限。',
        ].join('\n'));
        return;
      }

      // 用户要文件，但输出里找不到真实存在的路径 —— 说明结果本身才是有效回答
      this.audit.log(AuditEvent.DIAG, {
        where: 'artifact', event: 'requested-file-not-found',
      });
    }

    // ── 8b. 常规回送（长结果落盘 + 文件直发 + 降级）
    const outcome = await sendArtifact(reply, task, {
      bot: this.bot,
      target,
      sendText: (text) => this.sendText(target, text),
      dir: resolve(this.config.dsh.workspace, this.config.output.artifactDir),
      thresholdChars: this.config.output.fileThresholdChars,
      sendFileWhenLarge: this.config.output.sendFileWhenLarge,
      summarize: summarizeForChat,
      log: artifactLog,
    });

    this.audit.log(AuditEvent.DIAG, {
      where: 'artifact',
      delivered: outcome?.delivered ?? 'unknown',
      path: outcome?.path ?? null,
      reason: outcome?.reason ?? null,
    });
  }

  /** 启动。 */
  async start() {
    console.log(this.selfCheck());

    // 启动环境写进审计日志：万一每条指令都 EPERM 失败，日志里直接能看到原因，
    // 而不是只有 runner 记录的 Node 崩溃堆栈。
    const launchProbe = this.dshHomeProbe();
    if (!launchProbe.ok) {
      this.audit.log(AuditEvent.ERROR, {
        where: 'launch-context',
        errorMessage: `DSH 配置目录不可写（${launchProbe.dir}）: ${launchProbe.error}`,
        hint: LAUNCH_CONTEXT_HINT,
      });
    }

    this.audit.log(AuditEvent.STARTUP, {
      version: VERSION,
      workspace: this.config.dsh.workspace,
      allowlistSize: this.allowSet.size,
      policyEnabled: this.config.security.policyEnabled,
    });

    this.bot = new QQBot({
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
      tokenPrefetch: 'sync',
      logger: {
        info: (m) => this.audit.log(AuditEvent.SDK_LOG, { where: 'qq', level: 'info', msg: m }),
        warn: (m) => this.audit.log(AuditEvent.SDK_LOG, { where: 'qq', level: 'warn', msg: m }),
        error: (m) => this.audit.log(AuditEvent.ERROR, { where: 'qq', msg: m }),
        debug: () => {},
      },
    });

    this.bot.on('ready', () => {
      console.log('\x1b[32m✅ 已连接 QQ 开放平台，等待消息。\x1b[0m');
      console.log('   给自己发一条「帮我看看 D 盘剩余空间」试试。\n');
    });

    this.bot.on('message', (ctx, msg) => {
      this.onMessage(ctx, msg).catch((e) => {
        this.audit.log(AuditEvent.ERROR, {
          where: 'onMessage',
          errorMessage: e.message,
          stack: e.stack?.slice(0, 800),
        });
        console.error(`\x1b[31m[错误] 处理消息失败: ${e.message}\x1b[0m`);
      });
    });

    this.bot.on('interaction', (ctx, event) => {
      this.onInteraction(ctx, event).catch((e) => {
        this.audit.log(AuditEvent.ERROR, {
          where: 'onInteraction',
          errorMessage: e.message,
          stack: e.stack?.slice(0, 600),
        });
        console.error(`\x1b[31m[错误] 处理按钮点击失败: ${e.message}\x1b[0m`);
      });
    });

    this.bot.on('rawEvent', (ctx) => {
      this.audit.log(AuditEvent.SDK_LOG, {
        where: 'rawEvent',
        eventType: ctx.eventType,
        level: 'debug',
      });
    });

    await this.bot.start();
  }

  /** 优雅退出。 */
  async stop() {
    this.audit.log(AuditEvent.SHUTDOWN, { stats: this.stats });
    for (const [userId, ctrl] of this.running) {
      ctrl.abort();
      this.audit.log(AuditEvent.TASK_CANCELLED, { userId, reason: 'shutdown' });
    }
    this.running.clear();
    try { this.bot?.stop?.(); } catch { /* ignore */ }
  }
}

/** 命令行入口。 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
DSH-QQ 桥接服务 v${VERSION}

用法:
  bin\\node.cmd src\\main.js [选项]

选项:
  --print-config   打印生效配置（敏感值脱敏）后退出
  --help, -h       显示本帮助

环境变量:
  QQ_APP_ID            机器人 AppID（覆盖配置文件）
  QQ_APP_SECRET        机器人 AppSecret（覆盖配置文件）
  QQ_ALLOWED_OPENIDS   逗号分隔的白名单 openid
  DSH_WORKSPACE        DSH 工作区（安全边界）
  DSH_TIMEOUT_MS       单任务超时毫秒
  LOG_LEVEL            日志级别

注意: 本服务会 spawn 子进程，必须在 DSH 沙箱之外运行。
`);
    return 0;
  }

  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error('\n\x1b[31m配置错误\x1b[0m');
      console.error(e.message);
      console.error('\n提示: 用 --help 查看可用环境变量。\n');
      return 2;
    }
    throw e;
  }

  if (args.includes('--print-config')) {
    console.log(describeConfig(loaded));
    return 0;
  }

  // ── 单例守卫
  //
  // 跑两份的后果不是"多一条日志"，而是**任务被执行两遍**：
  // 一次「确认」可能被两个进程各自执行，于是"删除日志"删两次、
  // `git push` 推两次。必须在连网关之前就拦住。
  const guard = new SingletonGuard(join(loaded.config.logging.dir, '..', 'state', 'bridge.lock'));
  const claim = guard.acquire();
  if (!claim.ok) {
    console.error('\n\x1b[31m拒绝启动：检测到另一个桥接实例\x1b[0m');
    console.error(`  ${claim.reason}`);
    if (claim.holder?.cwd) console.error(`  工作目录: ${claim.holder.cwd}`);
    console.error('');
    console.error('  为什么要拦：跑两份会让同一条指令被执行两次，');
    console.error('  确认类操作（删除/推送）后果尤其严重。');
    console.error('');
    console.error('  若是误报（比如上次崩溃留下的锁），先确认没有实例在跑：');
    console.error('    tasklist | findstr "DeepSeek Harness"');
    console.error(`  确认为孤儿锁后可删除：${guard.lockPath}`);
    console.error('');
    return 3;
  }
  if (claim.tookOver) {
    console.log('\x1b[33mℹ 发现并接管了一个残留的锁（上次可能未正常退出）\x1b[0m');
  }

  const bridge = new Bridge(loaded);

  const shutdown = async (sig) => {
    console.log(`\n收到 ${sig}，正在退出…`);
    await bridge.stop();
    guard.release();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await bridge.start();
  } catch (e) {
    bridge.audit?.log(AuditEvent.ERROR, { where: 'start', errorMessage: e.message });
    console.error(`\n\x1b[31m启动失败\x1b[0m\n${e.message}\n`);
    console.error('对照排查:');
    console.error('  · appid invalid / 100007  → AppID 不对');
    console.error('  · 4013 / 4014 / intents   → 事件权限未获批');
    console.error('  · token 相关              → AppSecret 不对');
    console.error('  · EPERM / ENOENT 子进程   → 未在沙箱外运行，或 cliPath 不对');
    console.error('');
    guard.release();
    return 1;
  }

  // 保持进程存活
  return new Promise(() => {});
}

// 仅在直接执行时运行（被 import 时不自动启动）
const isDirect = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isDirect) {
  main()
    .then((code) => { if (typeof code === 'number' && code !== 0) process.exit(code); })
    .catch((e) => {
      console.error(`\n\x1b[31m未预期错误\x1b[0m\n${e.stack || e.message}\n`);
      process.exit(1);
    });
}
