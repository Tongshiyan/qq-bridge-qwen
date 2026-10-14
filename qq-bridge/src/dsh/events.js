/**
 * DSH 事件流解析（纯函数，无副作用，可独立测试）
 *
 * `dsh --profile headless --json "<task>"` 会在 stdout 上输出
 * newline-delimited JSON（NDJSON），每行一个事件。已知事件类型：
 *
 *   {"type":"session","sessionId":"会话ID","cwd":"工作目录"}
 *   {"type":"status","phase":"turn_start","turn":1}
 *   {"type":"status","phase":"step_start","turn":1,"step":1}
 *   {"type":"status","phase":"step_end","turn":1,"step":1}
 *   {"type":"status","phase":"turn_end","turn":1,"reason":{...}}
 *   {"type":"final","text":"最终答案"}
 *
 * 本模块只负责把这些行转成结构化结果，不碰进程。
 */

/** 稳定的事件类型。 */
export const EventType = {
  SESSION: 'session',
  STATUS: 'status',
  FINAL: 'final',
  UNKNOWN: 'unknown',
};

/**
 * 构建 dsh CLI 参数数组。
 *
 * 用数组而非字符串，配合 spawn 的 shell:false，
 * 从根本上避免任务文本被当作 shell 语法解释（命令注入）。
 *
 * @param {string} task
 * @param {{json?: boolean, sessionId?: string}} [opts]
 * @returns {string[]}
 */
export function buildDshArgs(task, { json = true, sessionId } = {}) {
  const args = ['--profile', 'headless'];
  if (json) args.push('--json');
  if (sessionId) args.push('--session-id', sessionId);

  // 任务作为单个 argv 元素传入。多词会被 DSH 用空格重新拼接，
  // 因此这里不做任何转义——转义反而会污染任务文本。
  args.push(String(task ?? ''));
  return args;
}

/**
 * 解析一行 NDJSON。解析失败返回 null（不抛异常）。
 * @param {string} line
 * @returns {object|null}
 */
export function parseEventLine(line) {
  const s = String(line ?? '').trim();
  if (!s) return null;
  // DSH 的 stderr/progress 装饰理论上不会混进 stdout，但保险起见只认 JSON 对象
  if (!s.startsWith('{')) return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 增量 NDJSON 解析器。
 *
 * 子进程的 stdout 是任意分片的字节流，一个 JSON 对象可能跨多个 chunk，
 * 一个 chunk 也可能包含多个对象。必须按换行缓冲再解析。
 */
export class NdjsonParser {
  constructor() {
    this.buffer = '';
    this.brokenLines = 0;
  }

  /**
   * 喂入一块数据，返回本次能解析出的完整事件数组。
   * @param {string|Buffer} chunk
   * @returns {object[]}
   */
  push(chunk) {
    this.buffer += chunk.toString('utf8');
    const events = [];

    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);

      const trimmed = line.trim();
      if (!trimmed) continue;

      const ev = parseEventLine(trimmed);
      if (ev === null) {
        // 不是 JSON 的行：可能是 banner/警告，计入但不致命
        if (trimmed.startsWith('{')) this.brokenLines++;
        continue;
      }
      events.push(ev);
    }
    return events;
  }

  /** 流结束时冲刷残留（最后一行可能没有换行符）。 */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    const ev = parseEventLine(rest);
    if (ev === null) {
      if (rest.startsWith('{')) this.brokenLines++;
      return [];
    }
    return [ev];
  }
}

/**
 * headless 运行的累积状态。
 * 把事件流折叠成一个最终可读结果。
 */
export class RunAccumulator {
  constructor() {
    /** @type {string|null} */
    this.sessionId = null;
    /** @type {string|null} */
    this.cwd = null;
    /** @type {string} */
    this.finalText = '';
    /** @type {object|null} 最近一次 turn_end 的 reason */
    this.turnEndReason = null;
    /** @type {string|null} 结构化错误信息 */
    this.errorMessage = null;
    /** @type {string|null} */
    this.errorCode = null;
    /** @type {number} */
    this.turns = 0;
    /** @type {number} */
    this.steps = 0;
    /** @type {string[]} 进度行，用于向用户报告"正在做什么" */
    this.progress = [];
    /** @type {object[]} 原始事件（供审计） */
    this.events = [];
  }

  /** @param {object} ev */
  apply(ev) {
    this.events.push(ev);

    switch (ev.type) {
      case EventType.SESSION:
        this.sessionId = ev.sessionId ?? this.sessionId;
        this.cwd = ev.cwd ?? this.cwd;
        break;

      case EventType.STATUS: {
        if (ev.phase === 'turn_start') {
          this.turns = Math.max(this.turns, Number(ev.turn) || 0);
          this.progress.push(`第 ${ev.turn} 轮开始`);
        } else if (ev.phase === 'step_start') {
          this.steps++;
          this.progress.push(`第 ${ev.turn} 轮 步骤 ${ev.step} 开始`);
        } else if (ev.phase === 'turn_end') {
          this.turnEndReason = ev.reason ?? null;
          this.progress.push(`第 ${ev.turn} 轮结束`);
          this.#captureError(ev.reason);
        }
        break;
      }

      case EventType.FINAL:
        this.finalText = typeof ev.text === 'string' ? ev.text : '';
        break;

      default:
        break;
    }
    return this;
  }

  #captureError(reason) {
    if (!reason || typeof reason !== 'object') return;
    if (reason.kind !== 'error') return;
    const err = reason.error ?? {};
    this.errorMessage = err.message ?? '未知错误';
    this.errorCode = err.code ?? null;
  }

  /** 是否因缺少模型凭证而失败——这是部署期最常见的问题。 */
  get isMissingCredential() {
    return this.errorCode === 'MISSING_CREDENTIAL'
      || /no API key|MISSING_CREDENTIAL/i.test(this.errorMessage ?? '');
  }

  /** 汇总成结果对象。 */
  result({ exitCode = null, stderr = '', timedOut = false, killed = false } = {}) {
    const ok = exitCode === 0 && !timedOut && !killed && !this.errorMessage;
    return {
      ok,
      sessionId: this.sessionId,
      cwd: this.cwd,
      text: this.finalText,
      errorMessage: this.errorMessage,
      errorCode: this.errorCode,
      missingCredential: this.isMissingCredential,
      turns: this.turns,
      steps: this.steps,
      exitCode,
      timedOut,
      killed,
      stderr: stderr.slice(-4000),
      progress: this.progress,
      eventCount: this.events.length,
    };
  }
}

/**
 * 判断一次失败是否属于「复用了与当前 workspace 不匹配的历史会话」。
 *
 * 背景：DSH 的会话与工作目录绑定。一旦改了 dsh.workspace，
 * 旧 sessionId 就不再适用于新目录，DSH 会拒绝并给出明确文字（在 stderr）：
 *
 *   dsh: session "session-11c2c881-…" was recorded in "%USERPROFILE%",
 *        not "%USERPROFILE%\Desktop"
 *
 * ⚠️ 这个函数是「按报错文字直接匹配」，而不是靠事件数之类的表象特征反推。
 *    早先的版本用「失败 + 零事件」当判据，结果在 DSH 先发出 `session` 事件
 *    再校验失败时（eventCount=1）就漏判了 —— 表现为用户反复收到同一条失败，
 *    因为坏会话永远清不掉。
 *
 *    DSH 自己知道正确的工作目录，也会明说，因此直接采信它的话最可靠。
 *
 * @param {object} result runDshTask 的返回值
 * @param {string|null|undefined} usedSessionId 本次实际传入的 sessionId
 * @returns {{stale: boolean, detail: string|null}}
 */
export function detectStaleSession(result, usedSessionId) {
  if (!usedSessionId) return { stale: false, detail: null };
  if (!result || typeof result !== 'object') return { stale: false, detail: null };
  if (result.ok) return { stale: false, detail: null };
  // 超时/取消有自己的解释，不按会话问题处理
  if (result.timedOut || result.killed) return { stale: false, detail: null };

  const text = [
    result.errorMessage,
    result.stderr,
    result.text,
  ].filter((s) => typeof s === 'string' && s).join('\n');

  if (!text) return { stale: false, detail: null };

  // DSH 的原文：session "X" was recorded in "A", not "B"
  const m = /session\s+"([^"]+)"\s+was\s+recorded\s+in\s+"([^"]+)"\s*,\s*not\s+"([^"]+)"/i.exec(text);
  if (m) {
    return {
      stale: true,
      detail: `会话 ${m[1]} 记录于 ${m[2]}，与当前 workspace ${m[3]} 不匹配`,
    };
  }

  // 兜底：容忍措辞变化，但要求同时出现会话与工作目录两个关键词
  if (/session/i.test(text) && /(was recorded in|not\s+"[^"]*")/i.test(text)) {
    return { stale: true, detail: '会话与当前 workspace 不匹配（按报错文字判定）' };
  }

  return { stale: false, detail: null };
}

/**
 * 布尔便捷包装（保持与既有调用点的兼容）。
 * @returns {boolean}
 */
export function isStaleSessionFailure(result, usedSessionId) {
  return detectStaleSession(result, usedSessionId).stale;
}

/**
 * 会话善后决策（纯函数，便于测试）。
 *
 * 原先是内联在 `executeTask` 里的，结果因为测试把 `executeTask` 整个 mock 掉，
 * 这段逻辑从未被任何测试执行过 —— 连"改了变量名却漏改一处"这种会抛
 * ReferenceError 的低级错误都溜了过去。抽出来才测得到。
 *
 * @param {object} result runDshTask 的返回值
 * @param {string|null|undefined} usedSessionId 本次实际传入的 sessionId
 * @param {{workspace: string, persistSession: boolean}} cfg
 * @returns {{clearSession: boolean, detail: string|null, userMessage: string|null, auditMessage: string|null}}
 */
export function planSessionCleanup(result, usedSessionId, cfg = {}) {
  const none = { clearSession: false, detail: null, userMessage: null, auditMessage: null };
  if (!cfg.persistSession) return none;

  const { stale, detail } = detectStaleSession(result, usedSessionId);
  if (!stale) return none;

  const workspace = cfg.workspace ?? '(未知)';
  const raw = typeof result?.stderr === 'string' ? result.stderr.trim() : '';

  const userMessage = [
    '⚠️ 复用了与当前工作目录不匹配的历史会话，任务未能启动。',
    '',
    `当前工作目录：${workspace}`,
    detail ? `冲突详情：${detail}` : '',
    '',
    '已自动清除该会话。请**重新发送一次刚才的指令**，这次会开新会话。',
    '',
    raw ? `DSH 原文：\n${raw.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');

  return {
    clearSession: true,
    detail,
    userMessage,
    auditMessage:
      `已清除不匹配的会话（${detail}）；当前 workspace=${workspace}。下一条指令将开新会话。`,
  };
}

/**
 * 判断一次失败是否属于「桥接进程本身被沙箱限制，写不了 DSH 自己的 profile」。
 *
 * 现场证据（真实事故，2026-10-14，手机发「hello」）：
 *
 *   Error: EPERM: operation not permitted, open
 *     '%USERPROFILE%\.dsh\profiles\headless\cordis.yml'
 *       at writeFileSync (node:fs:2422:20)
 *       at prepareProfile (…/profile-boot-*.js:189:2)
 *       at composeProfile → runProfile → runCli → runDesktopCli
 *
 * 机制：桥接服务**自己**跑在某个 DSH 会话的沙箱里（那个会话直接
 * Start-Process 了 main.js）。Windows 沙箱是一枚低完整性令牌，子进程继承后
 * 无法摆脱；于是 dsh 子进程在启动阶段写 profile 时被"禁止向上写"拦下 ——
 * 工作区里可写，工作区之外（%USERPROFILE%\.dsh\…）EPERM。
 *
 * ⚠️ 外观与「进程根本没起来」一模一样（exit=1、eventCount=0、errorMessage=null），
 *    唯一线索在 stderr 里，所以只能按报错文字判定（同 detectStaleSession 的理由）。
 *
 * @param {object} result runDshTask 的返回值
 * @returns {{denied: boolean, path: string|null}}
 */
export function detectProfileWriteDenied(result) {
  const no = { denied: false, path: null };
  if (!result || typeof result !== 'object') return no;
  if (result.ok || result.timedOut || result.killed) return no;

  const text = [result.errorMessage, result.stderr, result.text]
    .filter((s) => typeof s === 'string' && s)
    .join('\n');
  if (!text) return no;

  if (!/\b(EACCES|EPERM)\b/.test(text)) return no;
  // 必须同时指向 DSH 的配置目录，避免把别的 EPERM（例如 spawn EPERM）误判。
  if (!/[\\/]\.dsh[\\/]/i.test(text) && !/cordis\.ya?ml/i.test(text)) return no;

  const m = /open\s+'([^']+)'/.exec(text) ?? /path:\s*'([^']+)'/.exec(text);
  return { denied: true, path: m ? m[1] : null };
}

/**
 * 从 dsh 的运行结果生成面向用户的中文回复。
 * @param {ReturnType<RunAccumulator['result']>} result
 * @returns {string}
 */
export function describeResult(result) {
  if (result.ok) {
    return result.text?.trim() || '（任务已完成，但没有返回文本结果）';
  }

  if (result.timedOut) {
    // 区分两种超时：撞到硬上限 vs 长时间没有任何事件（卡死）
    const why = result.timeoutKind === 'idle'
      ? '长时间没有任何输出，判定为卡死'
      : '超过单任务时间上限';
    return [
      `⏱ 任务超时（${why}），已被终止。`,
      result.sessionId ? `可用会话继续: ${result.sessionId}` : '',
      result.text?.trim() ? `\n已产生的部分结果:\n${result.text.trim()}` : '',
    ].filter(Boolean).join('\n');
  }

  if (result.killed) {
    return '🛑 任务已被取消。';
  }

  if (result.missingCredential) {
    return [
      '❌ DSH 缺少模型 API Key，无法执行任务。',
      '',
      '这是部署问题，不是任务本身的问题。请任选一种方式修复：',
      '  1. 打开 DSH 的 Web 界面 → Models 页面 → 填入 DeepSeek API Key',
      '  2. 或在启动桥接服务的环境里设置 DEEPSEEK_API_KEY',
      '',
      `原始错误: ${result.errorMessage ?? '(无)'}`,
    ].join('\n');
  }

  // 桥接自己的启动环境问题：跑在 DSH 沙箱里 → 写不了 workspace 之外的 profile。
  // 必须在兜底分支之前拦下来，否则用户收到的是几百字的 Node 崩溃堆栈。
  const denied = detectProfileWriteDenied(result);
  if (denied.denied) {
    // 只摘出 EPERM 那一行：手机用户需要"哪个文件"，不需要 Node 调用栈。
    const rawLine = String(result.errorMessage || result.stderr || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /\b(EACCES|EPERM)\b/.test(l)) ?? '';
    return [
      '❌ 任务执行失败：桥接服务自己没有写权限。',
      '',
      '这不是任务本身的问题，而是**桥接进程的启动环境**问题：',
      '桥接进程跑在 DSH 的文件沙箱里，它启动的 dsh 子进程继承同一限制，',
      '于是写不了工作区之外的 DSH 配置文件 —— 每条指令都会这样失败。',
      '',
      denied.path ? `写不进去的文件：${denied.path}` : '',
      '',
      '修法（在电脑上操作，不要从 DSH 会话里启动桥接）：',
      '  1. 先停掉当前的桥接进程（占用 state\\bridge.lock 里那个 PID）',
      '  2. 改从普通窗口 / 双击运行：scripts\\start-all.cmd',
      '     （或在「Qwen控制台」里点启动）',
      '',
      rawLine ? `原始错误：${rawLine.slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');
  }

  const detail = result.errorMessage || result.stderr?.trim() || '（无错误详情）';
  return `❌ 任务执行失败\n退出码: ${result.exitCode ?? '未知'}\n\n${detail}`;
}
