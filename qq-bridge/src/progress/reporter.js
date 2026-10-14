/**
 * 进度播报：把长时间执行的 DSH 任务，节流后汇报给 QQ 用户
 *
 * 背景：一个任务动辄跑几分钟，用户从手机发完指令后就再也没有反馈，
 * 会以为机器人挂了，于是重复发送同一条指令 —— 这又会把队列压垮。
 *
 * 但 QQ 机器人对主动消息有严格配额，超发会被限流甚至封禁。
 * 所以本模块的第一原则是「宁可少发，不可多发」，三条闸门依次生效：
 *
 *   1. 静默期 silentBeforeMs：这段时间内一条都不发。大多数任务十几秒就结束了，
 *      而"已接受任务，正在执行…"已经覆盖了开头，无需再打扰。
 *   2. 最小间隔 minIntervalMs：两次推送之间必须隔够这么久。
 *   3. 硬上限 maxPushes：整轮任务最多发这么多条，之后彻底静音。
 *
 * 本模块只管"要不要发、发什么"，不管怎么发（由 opts.send 注入），
 * 也不管事件从哪来（调用方把每个事件喂进 onEvent）。
 * 所有时间计算都走 opts.now，测试可以用假时钟模拟 10 分钟，而不用真的等待。
 *
 * 用法：
 *   const reporter = new ProgressReporter({
 *     send: (text) => qq.send(userId, text),
 *     log: (m) => logger.debug(m),
 *   });
 *   for await (const ev of events) await reporter.onEvent(ev);
 *   await reporter.finish(result);   // 正式结果由调用方单独发送
 *
 * ⚠️ 并发/不 await 也是安全的（桥接侧最常见的写法）：
 *
 *   onEvent: (ev) => { progress.onEvent(ev).catch(() => {}); }
 *
 * DSH 的 stdout 事件是同步连续到达的，调用方**不需要**、通常也不会 await
 * 上一次进度推送（真实网络发送要几十到几百毫秒）。因此 onEvent / finish
 * 在调用点**同步**完成"时钟快照 → 三重闸门判定 → 名额预占"，只有
 * 真正的 send 是异步的。这样无论调用方 await 与否：
 *   - 不会漏发（不存在"上一次还在发就丢弃"的守卫）
 *   - 不会错发（lastPushAt 在预占时就更新，后续调用看到的一定是已消耗的配额）
 *   - 不会虚增 suppressed（suppressed 只统计真正被闸门拦下的次数）
 * 返回的 Promise 仅在调用方需要"等这条发完再继续"时才需要 await。
 */

/** 默认：两次推送至少间隔 15 秒。 */
const DEFAULT_MIN_INTERVAL_MS = 15_000;
/** 默认：单轮任务最多 8 条进度。 */
const DEFAULT_MAX_PUSHES = 8;
/** 默认：前 8 秒完全静默。 */
const DEFAULT_SILENT_BEFORE_MS = 8_000;

/**
 * 间隔下限。
 * 机器人配额是硬约束，误配置成 minIntervalMs=50 会直接把号刷到限流，
 * 因此低于 1 秒的配置一律抬到 1 秒并记一条日志。
 */
const MIN_INTERVAL_FLOOR_MS = 1_000;

/**
 * 把毫秒格式化成简短中文时长（1 秒 / 1 分 20 秒 / 1 小时 5 分）。
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;

  const minutes = Math.floor(totalSec / 60);
  if (minutes < 60) {
    const sec = totalSec % 60;
    return sec === 0 ? `${minutes} 分` : `${minutes} 分 ${sec} 秒`;
  }

  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin === 0 ? `${hours} 小时` : `${hours} 小时 ${restMin} 分`;
}

/**
 * 取配置项里的非负整数；非法（undefined/null/NaN/负数/字符串垃圾）时回退默认值。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toCount(value, fallback) {
  // 注意：Number(null) === 0，会把"没传"误判成"显式传了 0"，必须单独挡掉
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * 工具名 → 人话动作。第二个元素是从 input 里取"最该给用户看的那一项"。
 *
 * 为什么要这张表：DSH 的事件流里有 `tool_call`（含 tool 名与 input），
 * 但早先的播报只用了 status 的轮次/步号，于是用户只看到
 * 「🔄 仍在执行（第 3 轮，第 2 步）」——他知道在跑，但不知道**在干什么**。
 */
const TOOL_ACTIONS = {
  pwsh: ['运行命令', (i) => i?.command],
  bash: ['运行命令', (i) => i?.command],
  read: ['读取文件', (i) => i?.file_path ?? i?.path],
  write: ['写入文件', (i) => i?.file_path ?? i?.path],
  edit: ['修改文件', (i) => i?.file_path ?? i?.path],
  glob: ['查找文件', (i) => i?.pattern],
  grep: ['搜索内容', (i) => i?.pattern],
  web_search: ['联网搜索', (i) => {
    const q = i?.queries ?? i?.query;
    return Array.isArray(q) ? q.join(' / ') : q;
  }],
  web_fetch: ['抓取网页', (i) => i?.url],
  read_image: ['查看图片', (i) => i?.file_path ?? i?.path],
  todo_write: ['整理任务清单', null],
  ask_user_question: ['准备向你提问', null],
  skill: ['加载技能', (i) => i?.name],
  subagent: ['派发子代理', (i) => i?.description],
  subagent_fork: ['派发子代理', (i) => i?.description],
  spawn_teammate: ['创建协作成员', (i) => i?.name],
  send_message: ['给协作成员发消息', null],
  wait_agent: ['等待协作成员', null],
  team_task_create: ['登记协作任务', (i) => i?.subject],
  team_task_list: ['查看协作任务', null],
  team_task_update: ['更新协作任务', null],
  workflow: ['执行多代理工作流', null],
  job_list: ['查看后台任务', null],
  job_output: ['读取后台任务输出', null],
  job_kill: ['终止后台任务', null],
  present: ['整理交付文件', null],
  create_goal: ['登记目标', null],
  update_goal: ['更新目标', null],
  exit_plan_mode: ['提交计划待确认', null],
};

/** 单条进度里最多显示多少字符的细节（QQ 上太长会被折叠，也浪费配额）。 */
const MAX_DETAIL_CHARS = 48;
/** thinking 片段最多显示多少字符。 */
const MAX_THINKING_CHARS = 50;
/**
 * 让步窗口：这一步刚开始、且还不知道要调用什么工具时，先压住播报，
 * 等 tool_call 到达 —— DSH 通常在 step_start 之后 1–2 秒发出它，
 * 而"运行命令：xxx"比一句英文 thinking 片段对用户有用得多。
 */
const DEFER_FOR_ACTION_MS = 2_500;

/**
 * 把 tool_call 事件翻译成一句人话（纯函数，便于测试）。
 *
 * @param {string} tool 工具名，如 'pwsh'
 * @param {object} input 工具入参
 * @returns {string} 形如 `运行命令：Get-ChildItem D:\`；工具未知时退化为 `使用工具 xxx`
 */
export function describeToolCall(tool, input) {
  const name = String(tool ?? '').trim();
  if (!name) return '正在执行下一步';

  const entry = TOOL_ACTIONS[name];
  const label = entry ? entry[0] : `使用工具 ${name}`;
  let detail = '';
  try {
    const pick = entry?.[1];
    if (typeof pick === 'function') {
      const raw = pick(input && typeof input === 'object' ? input : {});
      if (raw !== undefined && raw !== null) detail = String(raw);
    }
  } catch {
    detail = '';
  }

  // 命令里常有换行/连续空格，压平后再截断，避免把一条消息撑成多行
  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > MAX_DETAIL_CHARS) detail = `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…`;

  return detail ? `${label}：${detail}` : label;
}

/**
 * 把 thinking 事件压成一句可播报的片段（纯函数）。
 * 模型的自述（"用户想让我列出 D 盘…"）比轮次/步号更能说明"在干什么"。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function describeThinking(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > MAX_THINKING_CHARS ? `${s.slice(0, MAX_THINKING_CHARS - 1)}…` : s;
}


/**
 * 取事件里的正轮次/步号，非法时保留上一次的值。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export class ProgressReporter {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<void>} opts.send 推送一条消息（通常是 QQ 主动消息）
   * @param {number} [opts.minIntervalMs=20000] 两次推送之间的最小间隔（低于 1000 会被抬到 1000）
   * @param {number} [opts.maxPushes=6] 单轮任务最多推送条数，0 表示完全不推送
   * @param {number} [opts.silentBeforeMs=12000] 静默期，这段时间内一条都不发
   * @param {() => number} [opts.now] 可注入时钟，测试用假时钟实现确定性
   * @param {(msg: string) => void} [opts.log] 诊断日志出口
   */
  constructor({ send, minIntervalMs, maxPushes, silentBeforeMs, now, log } = {}) {
    /** @type {(text: string) => Promise<void>|undefined|null} 推送通道 */
    this.#send = typeof send === 'function' ? send : null;
    /** @type {() => number} */
    this.#now = typeof now === 'function' ? now : Date.now;
    /** @type {((msg: string) => void)|null} */
    this.#logFn = typeof log === 'function' ? log : null;

    /** 最小推送间隔（毫秒）。 */
    const requested = toCount(minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
    this.minIntervalMs = Math.max(MIN_INTERVAL_FLOOR_MS, requested);

    /** 单轮任务推送条数上限。 */
    this.maxPushes = toCount(maxPushes, DEFAULT_MAX_PUSHES);

    /** 静默期（毫秒），0 表示不静默。 */
    this.silentBeforeMs = toCount(silentBeforeMs, DEFAULT_SILENT_BEFORE_MS);

    /** 当前轮次（从事件流里跟踪，仅用于措辞）。 */
    this.turn = 0;
    /** 当前步骤（从事件流里跟踪，仅用于措辞）。 */
    this.step = 0;
    /** 会话 id（拿到后可提示用户续接）。 */
    this.sessionId = null;
    /** 最近一次工具调用的人话描述（"现在到底在干什么"的主要来源）。 */
    this.lastAction = null;
    /** 该动作是否已结束（决定文案用"正在…"还是"上一步：…"）。 */
    this.actionDone = false;
    /** 最近一次 thinking 的片段（还没有工具调用时用来交代意图）。 */
    this.lastThinking = null;
    /** 本轮任务发生过的工具调用次数（诊断用）。 */
    this.toolCalls = 0;
    /** 本步已开始但还没播报（等"在干什么"的内容到位，见 #flushPendingStep）。 */
    this.pendingStepPush = false;
    /** 本步是否已经产出正文（产出了就不再补"正在执行"，否则紧挨着正式结果很吵）。 */
    this.sawTextInStep = false;
    /** 本步开始的时刻（用于"让一让 tool_call"的让步窗口）。 */
    this.stepStartedAt = null;
    /** turn_end 里带出的错误信息（由调用方随结果发送，这里只记录）。 */
    this.errorMessage = null;

    this.#startedAt = this.#readNow();
    if (requested !== this.minIntervalMs) {
      this.#log(`minIntervalMs=${requested} 过小，已提升为 ${this.minIntervalMs}ms 以防刷屏`);
    }
  }

  // ---------------------------------------------------------------- 只读统计

  /** 已成功推送的条数。 */
  get pushed() {
    return this.#pushed;
  }

  /**
   * 被闸门拦下的次数：静默期内被压住的事件，以及被最小间隔/硬上限拦下的推送。
   * 用于测试与线上诊断"为什么用户没收到进度"。
   */
  get suppressed() {
    return this.#suppressed;
  }

  /** 推送抛异常的次数（失败同样计入上限，但不影响任务本身）。 */
  get failed() {
    return this.#failed;
  }

  /** 已占用的推送名额（含发送中/失败的），即 maxPushes 的消耗量。 */
  get attempts() {
    return this.#attempts;
  }

  /** 从构造到现在的耗时（毫秒）。 */
  get elapsedMs() {
    return Math.max(0, this.#readNow() - this.#startedAt);
  }

  /** 是否已经调用过 finish（避免重复结算）。 */
  get finished() {
    return this.#finished;
  }

  // ------------------------------------------------------------------ 主流程

  /**
   * 喂入一个已解析的 DSH 事件。可能触发一次推送（受三重闸门约束）。
   * 本方法永远不抛异常：进度播报失败绝不能影响任务执行。
   *
   * **调用方不需要 await**：闸门判定与配额预占在调用点同步完成，
   * 因此 `onEvent(ev).catch(() => {})` 这种不等待上一次的连发写法
   * 同样能正确节流、不漏发。需要"等这条发完再继续"时再 await 返回值。
   *
   * @param {object} event 形如 {type:'status', phase:'step_start', turn:1, step:2}
   * @returns {Promise<void>}
   */
  async onEvent(event) {
    try {
      if (this.#finished) return;
      // 防御性：null/undefined/数组/字符串/数字一律当噪声丢掉
      if (!event || typeof event !== 'object' || Array.isArray(event)) return;

      const nowMs = this.#readNow();

      if (event.type === 'session') {
        if (typeof event.sessionId === 'string') this.sessionId = event.sessionId;
        return;
      }

      // ── 内容来源：thinking / tool_call / tool_result ───────────────
      if (event.type === 'thinking') {
        // 记下模型当前的想法，但不单独推送：每一步都会思考，单推必刷屏。
        // 它的价值是在下一次播报里交代"打算干什么"。
        const snippet = describeThinking(event.text);
        if (snippet) this.lastThinking = snippet;
        await this.#flushPendingStep(nowMs);
        return;
      }
      if (event.type === 'tool_call') {
        // 这是"现在到底在干什么"最准确的信号（工具名 + 关键入参）。
        // 每一次工具调用都值得试一次播报：闸门会把它压到"每 minIntervalMs 最多一条"，
        // 因此连续快速调用自然合并，而不会刷屏。
        this.lastAction = describeToolCall(event.tool, event.input);
        this.actionDone = false;
        this.lastThinking = null;
        this.toolCalls++;
        this.pendingStepPush = true;
        await this.#flushPendingStep(nowMs);
        return;
      }
      if (event.type === 'tool_result') {
        const status = String(event.status ?? '').toLowerCase();
        const failed = status && !['completed', 'success', 'ok'].includes(status);
        if (failed) {
          // 工具失败是用户最需要知道的异常，值得单独试一条
          this.lastAction = `上一步失败（${status}），正在调整做法`;
          this.actionDone = false;
          this.pendingStepPush = true;
          await this.#flushPendingStep(nowMs);
        } else {
          // 成功：保留动作描述，下一次播报仍能说明"刚做完什么"
          this.actionDone = true;
        }
        return;
      }
      // 正文与最终答案由调用方发送，这里不播报（否则紧挨着正式结果很吵）
      if (event.type === 'text' || event.type === 'final') {
        this.sawTextInStep = true;
        this.pendingStepPush = false;
        return;
      }
      if (event.type !== 'status') return;

      if (event.phase === 'turn_start') {
        this.turn = toPositiveInt(event.turn, this.turn);
        this.step = 0; // 新一轮，步号重新计
        this.stepStartedAt = null;
        this.pendingStepPush = true;
        return;
      }
      if (event.phase === 'step_start') {
        this.turn = toPositiveInt(event.turn, this.turn);
        this.step = toPositiveInt(event.step, this.step);
        this.sawTextInStep = false;
        this.stepStartedAt = nowMs;
        // 不在这里立刻播报 —— 见 #flushPendingStep 的说明
        this.pendingStepPush = true;
        return;
      }
      if (event.phase === 'step_end') {
        await this.#flushPendingStep(nowMs);
        return;
      }
      if (event.phase === 'turn_end') {
        // 失败详情由调用方随结果一起发，这里只记录
        if (event.reason && typeof event.reason === 'object' && event.reason.kind === 'error') {
          this.errorMessage = event.reason.error?.message ?? '未知错误';
        }
        await this.#flushPendingStep(nowMs);
        return;
      }
      return;
    } catch (e) {
      this.#log(`onEvent 处理异常（已忽略）: ${e?.message ?? e}`);
    }
  }

  /**
   * 结算"这一步开始了但还没播报"的挂起状态。
   *
   * 为什么不直接在 step_start 播报：DSH 在 step_start 之后 1–2 秒内就会给出
   * thinking / tool_call，**那才是"在干什么"**。若让 step_start 抢先占掉配额，
   * 紧接着真正的动作反而被最小间隔闸门拦掉，用户只看到一条空洞的"正在执行"
   * （这正是改造前实测到的现象）。因此把两者合并成一条：等到有内容再发。
   *
   * @param {number} nowMs
   */
  async #flushPendingStep(nowMs) {
    if (!this.pendingStepPush) return;
    // 本步已经产出正文：正式结果马上就到，不必再补一条"正在执行"
    if (this.sawTextInStep) {
      this.pendingStepPush = false;
      return;
    }
    // 闸门没过就**保留挂起状态**，等下一个事件再试 —— 否则这一步的播报
    // 会被静默丢弃（改造前实测：thinking 与 tool_call 相隔 1.5 秒，
    // 后者的"运行命令：…"正好被最小间隔拦掉，用户又只看到"正在执行"）。
    if (!this.#canPush(nowMs)) {
      this.#noteSuppressed();
      return;
    }
    // 还不知道要用什么工具、且这一步刚开始：再等一会儿，优先报具体的动作。
    // 注意这一条不算"被闸门拦下"（是刻意等待），所以放在 #canPush 之后。
    if (!this.lastAction
      && this.stepStartedAt !== null
      && nowMs - this.stepStartedAt < DEFER_FOR_ACTION_MS) return;
    this.pendingStepPush = false;
    await this.#dispatch(nowMs, this.#progressText(nowMs));
  }

  /**
   * 由调用方定时驱动的"心跳"。
   *
   * 为什么需要：DSH 在 step_start 之后可能几十秒不发任何事件（长 prefill、
   * 长生成），而本模块的播报是事件驱动的 —— 改造后 step_start 不再抢先占配额，
   * 于是"长时间静默"这一段用户会完全没消息。心跳补上这一条，并且说的仍然是
   * "在干什么"（最近一次工具调用），而不是空洞的"仍在执行"。
   *
   * 为什么计时器放在调用方而不是本模块内建：测试用假时钟，
   * 内建 setInterval 会让测试不可确定，也容易在 finish 后泄漏。
   * 调用方（bridge）在任务期间每 ~10 秒调一次即可，闸门会把它压到
   * 每 minIntervalMs 最多一条。
   *
   * @returns {Promise<void>}
   */
  async heartbeat() {
    try {
      if (this.#finished) return;
      this.pendingStepPush = true;
      await this.#flushPendingStep(this.#readNow());
    } catch (e) {
      this.#log(`heartbeat 处理异常（已忽略）: ${e?.message ?? e}`);
    }
  }

  /**
   * 任务结束时调用，必要时补一条收尾提示。
   * 正常结束不发任何东西——调用方紧接着会发送正式结果，多说一句就是刷屏。
   * 只有"被取消/超时"这种用户会困惑"怎么没结果了"的场景才补一句。
   * 同样受三重闸门与上限约束；永远不抛异常；调用方同样可以不 await。
   * 重复调用 finish 只生效一次（第二次直接返回）。
   *
   * @param {ReturnType<import('../dsh/events.js').RunAccumulator['result']>} result
   * @returns {Promise<void>}
   */
  async finish(result) {
    try {
      if (this.#finished) return;
      this.#finished = true;

      const nowMs = this.#readNow();
      const dur = formatDuration(Math.max(0, nowMs - this.#startedAt));

      let text = null;
      if (result && typeof result === 'object') {
        if (result.killed) {
          text = `🛑 已用时 ${dur}，任务已取消，正式结果随后发送。`;
        } else if (result.timedOut) {
          text = `⏱ 已用时 ${dur}，任务超时结束，正式结果随后发送。`;
        }
      }
      if (!text) return;

      await this.#dispatch(nowMs, text);
    } catch (e) {
      this.#log(`finish 处理异常（已忽略）: ${e?.message ?? e}`);
    }
  }

  // -------------------------------------------------------------------- 内部

  /**
   * 处理一次"可能推送"：先同步判定闸门并占用配额，再异步发送。
   *
   * 关键点：**判定与预占是同步的**，send 的调用也在同一次同步执行里发生
   * （async 函数体在第一个 await 之前是同步跑的）。
   *
   * 为什么不能把判定推迟到 Promise 链（`.then`）里：
   *   1. 假时钟下调用方在两次 onEvent 之间推进时钟，若判定延后到微任务，
   *      同一个微任务批次里所有事件读到的都是最后的时钟值，间隔判定全错。
   *   2. 真实调用方（不 await）也依赖"配额在调用点就被扣掉"，否则一批同步
   *      事件会全部通过闸门。
   *   3. 调用方在 onEvent 之后立刻观察 pushed / suppressed 时，语义必须一致。
   *
   * 之前的实现用一个 `#inFlight` 守卫"上一条没发完就丢弃"，在调用方不 await
   * 时会把整个任务压成 1 条推送，并让 suppressed 虚高——这里彻底去掉该守卫。
   *
   * @param {number} nowMs 调用点抓拍的时钟
   * @param {string} text
   * @returns {Promise<boolean>} 是否真的推送成功（被闸门拦下时为 false）
   */
  #dispatch(nowMs, text) {
    if (!this.#reserve(nowMs)) return Promise.resolve(false);
    return this.#deliver(text);
  }

  /**
   * 只读判定：现在能不能推一条（**不改任何状态**）。
   *
   * 与 #reserve 共用同一套闸门，避免两处逻辑漂移：
   * #flushPendingStep 需要"先问能不能推，不能就保留挂起"，而 #reserve 还要
   * 顺带计数与告警。
   *
   * @param {number} nowMs
   * @returns {boolean}
   */
  #canPush(nowMs) {
    const elapsed = Math.max(0, nowMs - this.#startedAt);
    if (elapsed < this.silentBeforeMs) return false;   // 闸门 1：静默期
    if (this.#attempts >= this.maxPushes) return false; // 闸门 2：硬上限
    if (this.#lastPushAt !== null && nowMs - this.#lastPushAt < this.minIntervalMs) return false; // 闸门 3
    if (!this.#send) return false;
    return true;
  }

  /**
   * 记一次"想推但被闸门拦下"。
   *
   * 单独抽出来是因为有两条路径会走到这里：#reserve（显式推送被拦）与
   * #flushPendingStep（挂起的播报被拦）。后者若不计入，超限时就看不到
   * suppressed 增长 —— 那正是排障时最需要的信息。
   */
  #noteSuppressed() {
    this.#suppressed++;
    if (this.#attempts >= this.maxPushes && !this.#warnedCap) {
      this.#warnedCap = true;
      this.#log(`进度推送已达上限 ${this.maxPushes} 条，本轮不再发送进度`);
    }
    if (!this.#send && !this.#warnedNoSend) {
      this.#warnedNoSend = true;
      this.#log('未注入 send 通道，进度将无法推送');
    }
  }

  /**
   * 三重闸门 + 名额预占。同步执行，返回是否占到了名额。
   * @param {number} nowMs
   * @returns {boolean}
   */
  #reserve(nowMs) {
    if (!this.#canPush(nowMs)) {
      // 计数与"只告警一次"留在这里：调用方靠 suppressed 诊断"为什么用户没收到进度"
      this.#noteSuppressed();
      return false;
    }

    // 预占：立刻推进 lastPushAt 与尝试计数。
    // 这一步必须在 send 之前完成——调用方不 await 时，下一个事件就是靠
    // 这两个值看到"这一条已经发出去了"，从而被正确地节流。
    this.#attempts++;
    this.#lastPushAt = nowMs;
    return true;
  }

  /**
   * 真正调用 send 并结算统计。永不抛异常。
   * send 会在这里同步被调用（首个 await 之前），其异常/拒绝都在此吞掉。
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async #deliver(text) {
    try {
      await this.#send(text);
      this.#pushed++;
      this.#log(`进度已推送（第 ${this.#pushed} 条）: ${text}`);
      return true;
    } catch (e) {
      // 推送失败绝不能让任务失败。lastPushAt 已在预占时推进：
      // 否则发送通道持续报错时会变成每来一个事件就重试一次的死亡循环。
      this.#failed++;
      this.#log(`进度推送失败（已忽略，不影响任务）: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * 拼一条进度文案。
   *
   * 优先交代"在干什么"（工具调用 → thinking 片段），实在没有才退回
   * 「🔄 正在执行」这种位置信息。位置信息仍然附在末尾，因为它能说明
   * 任务是刚起步还是已经绕了很多步。
   *
   * @param {number} nowMs
   * @returns {string}
   */
  #progressText(nowMs) {
    const dur = formatDuration(Math.max(0, nowMs - this.#startedAt));

    let where = '';
    if (this.turn > 0 && this.step > 0) where = `第 ${this.turn} 轮 第 ${this.step} 步`;
    else if (this.turn > 0) where = `第 ${this.turn} 轮`;
    const tail = `${where ? `${where} · ` : ''}已用 ${dur}`;

    if (this.lastAction) {
      return this.actionDone
        ? `✅ 上一步：${this.lastAction}（${tail}）`
        : `🔧 正在${this.lastAction}（${tail}）`;
    }
    if (this.lastThinking) return `💭 ${this.lastThinking}（${tail}）`;
    return `🔄 正在执行（${tail}）`;
  }

  /** 读时钟，并保证拿到的是有限数字；时钟本身抛异常也不能影响任务。 */
  #readNow() {
    try {
      const t = Number(this.#now());
      return Number.isFinite(t) ? t : Date.now();
    } catch {
      return Date.now();
    }
  }

  /** 诊断日志；日志出口自己抛异常也要吞掉。 */
  #log(msg) {
    if (!this.#logFn) return;
    try {
      this.#logFn(String(msg));
    } catch {
      /* 日志失败无关紧要 */
    }
  }

  // ------------------------------------------------------------------ 私有态

  /** @type {((text: string) => Promise<void>)|null} */
  #send;
  /** @type {() => number} */
  #now;
  /** @type {((msg: string) => void)|null} */
  #logFn;
  /** @type {number} */
  #startedAt = 0;
  /** @type {number|null} */
  #lastPushAt = null;
  /** @type {number} */
  #pushed = 0;
  /** @type {number} */
  #suppressed = 0;
  /** @type {number} */
  #failed = 0;
  /** @type {number} 已预占的推送名额（含仍在发送中/已失败），用于硬上限 */
  #attempts = 0;
  /** @type {boolean} */
  #finished = false;
  /** @type {boolean} */
  #warnedCap = false;
  /** @type {boolean} */
  #warnedNoSend = false;
}
