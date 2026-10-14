/**
 * QQ 按钮审批
 *
 * 背景：变更类指令（删文件、装包、改配置）需要人工确认后才执行。
 * 最初只有纯文本令牌方案 —— 用户在手机上手动输入「确认 7K2M9P」。
 * 这能用，但麻烦且容易输错。
 *
 * 本模块改用 QQ 的 inline keyboard（按钮）：
 *   [✅ 允许]  [❌ 拒绝]
 * 用户点一下即可，交互成本大幅下降。
 *
 * ── 安全设计要点 ──────────────────────────────────────────────
 *
 * 1. **令牌不可猜测**：用 crypto 随机数，不用递增序号。
 * 2. **一次性**：消费即失效，防重放。
 * 3. **按用户隔离**：A 的令牌不能被 B 确认。
 *    注意 QQ 的 interaction 事件里用户标识可能是 user_openid 或
 *    group_member_openid，两者都要能正确比对。
 * 4. **按钮数据不可信**：button_data 来自客户端，必须当作不可信输入解析；
 *    解析失败一律拒绝，绝不默认放行。
 * 5. **文本令牌作为回退**：按钮可能因客户端版本、权限等原因不可用，
 *    因此「确认 XXXX」文本路径必须继续工作。
 *
 * ── QQ 按钮协议（来自 SDK 类型定义）──────────────────────────
 *
 *   KeyboardButton {
 *     id: string                       // 按钮标识
 *     render_data: {
 *       label: string                  // 未点击时的文案
 *       visited_label: string          // 点击后的文案
 *       style: number                  // 0 灰 / 1 蓝 / 2 绿 / 3 红
 *     }
 *     action: {
 *       type: number                   // 0 = 链接, 1 = 回调, 2 = 指令
 *       permission: { type: number }   // 0 所有人 / 1 仅管理员 / 2 仅指定用户
 *       data: string                   // 回调时回传给机器人的数据
 *       click_limit?: number
 *     }
 *   }
 *
 * 点击后触发 interaction 事件，数据出现在：
 *   event.data.resolved.button_data / button_id
 */

import { randomBytes } from 'node:crypto';

/** 按钮动作的编码前缀。 */
const ACTION = {
  APPROVE: 'apv',
  DENY: 'dny',
};

/** 点击按钮后的回应文案。 */
const ACK = {
  [ACTION.APPROVE]: '✅ 已允许',
  [ACTION.DENY]: '❌ 已拒绝',
};

export class ApprovalManager {
  /**
   * @param {object} opts
   * @param {number} [opts.ttlMs=300000]      令牌有效期
   * @param {number} [opts.maxPerUser=5]      每用户待确认上限
   * @param {() => number} [opts.now]         可注入时钟（便于测试）
   */
  constructor({ ttlMs = 300_000, maxPerUser = 5, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxPerUser = maxPerUser;
    this.now = now;
    /** @type {Map<string, {userId: string, task: string, token: string, createdAt: number, reasons: string[]}>} */
    this.byToken = new Map();
  }

  /** 生成 6 位大写字母数字令牌，去掉易混字符（0/O/1/I）。 */
  static newToken() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(6);
    let out = '';
    for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  #prune() {
    const t = this.now();
    for (const [token, entry] of this.byToken) {
      if (t - entry.createdAt > this.ttlMs) this.byToken.delete(token);
    }
  }

  /**
   * 登记一个待确认操作。
   * @returns {{token: string, expiresInSec: number}}
   */
  create(userId, task, reasons = []) {
    this.#prune();
    const uid = String(userId);

    // 限制每用户待确认数量，防止刷爆内存；淘汰最旧的一条
    const mine = [...this.byToken.entries()].filter(([, e]) => e.userId === uid);
    if (mine.length >= this.maxPerUser) {
      mine.sort((a, b) => a[1].createdAt - b[1].createdAt);
      this.byToken.delete(mine[0][0]);
    }

    let token;
    do {
      token = ApprovalManager.newToken();
    } while (this.byToken.has(token));

    this.byToken.set(token, {
      userId: uid,
      task,
      token,
      createdAt: this.now(),
      reasons,
    });

    return { token, expiresInSec: Math.round(this.ttlMs / 1000) };
  }

  /**
   * 消费令牌（文本路径与按钮路径共用）。
   *
   * 失败时一律返回同一句理由，不区分「不存在」和「不属于你」，
   * 避免泄露「这个令牌确实存在」这一信息。
   *
   * @returns {{ok: true, task: string} | {ok: false, reason: string}}
   */
  consume(userId, token) {
    this.#prune();
    const key = String(token ?? '').trim().toUpperCase();
    const entry = this.byToken.get(key);

    if (!entry || entry.userId !== String(userId)) {
      return { ok: false, reason: '令牌不存在或已过期' };
    }

    this.byToken.delete(key); // 一次性
    return { ok: true, task: entry.task };
  }

  /** 某用户待确认数量。 */
  countFor(userId) {
    this.#prune();
    const uid = String(userId);
    let n = 0;
    for (const e of this.byToken.values()) if (e.userId === uid) n++;
    return n;
  }

  /** 列出某用户待确认项（不含令牌）。 */
  listFor(userId) {
    this.#prune();
    const uid = String(userId);
    return [...this.byToken.values()]
      .filter((e) => e.userId === uid)
      .map((e) => ({
        task: e.task,
        ageSec: Math.round((this.now() - e.createdAt) / 1000),
        reasons: e.reasons,
      }));
  }

  size() {
    this.#prune();
    return this.byToken.size;
  }
}

/**
 * 构造审批按钮面板。
 *
 * @param {string} token
 * @returns {{content: {rows: Array<{buttons: object[]}>}}}
 */
export function buildApprovalKeyboard(token) {
  const t = String(token ?? '').trim().toUpperCase();
  return {
    content: {
      rows: [
        {
          buttons: [
            {
              id: 'btn-allow',
              render_data: { label: '✅ 允许', visited_label: '已允许', style: 2 },
              action: {
                type: 1, // 回调型：点击后把 data 回传给机器人
                permission: { type: 0 }, // 所有人可见（真实校验在服务端按用户比对）
                data: `${ACTION.APPROVE}:${t}`,
                click_limit: 1, // 只允许点一次，从交互层减少重放
              },
            },
            {
              id: 'btn-deny',
              render_data: { label: '❌ 拒绝', visited_label: '已拒绝', style: 3 },
              action: {
                type: 1,
                permission: { type: 0 },
                data: `${ACTION.DENY}:${t}`,
                click_limit: 1,
              },
            },
          ],
        },
      ],
    },
  };
}

/**
 * 解析按钮回传数据。
 *
 * button_data 来自客户端，属**不可信输入** —— 任何无法明确解析的值
 * 都返回 null，由调用方拒绝。绝不猜测、绝不默认放行。
 *
 * 注意校验顺序：必须先用**原始大小写**校验字母表，再规范化。
 * 若先 toUpperCase 再校验，`0`→`O`、`1`→`I` 这类替换会让
 * 本应非法的令牌（如 `01I234`）伪装成合法 —— 那是一个真实的绕过点。
 *
 * @param {string} raw
 * @returns {{action: 'approve'|'deny', token: string} | null}
 */
export function parseButtonData(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  const idx = s.indexOf(':');
  if (idx <= 0) return null;

  const prefix = s.slice(0, idx);
  const rawToken = s.slice(idx + 1).trim();

  // 令牌形态校验：6 位，且**原始字符**必须落在字母表内
  // （字母表刻意排除易混字符 0 O 1 I）
  if (!/^[A-Za-z2-9]{6}$/.test(rawToken)) return null;
  // 排除易混字符：即使大小写归一后也不允许出现 0/1/O/I
  if (/[01OI]/i.test(rawToken)) return null;

  const token = rawToken.toUpperCase();

  if (prefix === ACTION.APPROVE) return { action: 'approve', token };
  if (prefix === ACTION.DENY) return { action: 'deny', token };
  return null;
}

/**
 * 从 interaction 事件中提取用户标识。
 *
 * QQ 在不同场景下用不同字段承载用户：
 *   - 单聊:     user_openid
 *   - 群聊:     group_member_openid（点按钮的人）
 * 两个都取不到就无法做归属校验，此时必须拒绝。
 *
 * @param {object} event
 * @returns {string|null}
 */
export function extractInteractionUserId(event) {
  if (!event || typeof event !== 'object') return null;
  const candidates = [
    event.user_openid,
    event.group_member_openid,
    event.data?.resolved?.user_id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/**
 * 从 interaction 事件中提取按钮回传数据。
 * @param {object} event
 * @returns {string|null}
 */
export function extractButtonData(event) {
  if (!event || typeof event !== 'object') return null;
  const r = event.data?.resolved;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.button_data === 'string' && r.button_data.trim()) return r.button_data.trim();
  if (typeof r.button_id === 'string' && r.button_id.trim()) return r.button_id.trim();
  return null;
}

/**
 * 按钮点击的确认文案（用于 acknowledgeInteraction 的 data）。
 * @param {'approve'|'deny'} action
 */
export function ackText(action) {
  if (action === 'approve') return ACK[ACTION.APPROVE];
  if (action === 'deny') return ACK[ACTION.DENY];
  return '已处理';
}

/**
 * 构造发给用户的审批提示文本。
 *
 * @param {string} task
 * @param {string} token
 * @param {string[]} reasons
 * @param {number} expiresInSec
 * @returns {string}
 */
export function buildApprovalPrompt(task, token, reasons = [], expiresInSec = 300) {
  const shown = task.length > 200 ? `${task.slice(0, 200)}…` : task;
  const lines = [
    '⚠️ 该指令会修改文件或系统，需要你确认。',
    '',
    `指令：${shown}`,
  ];

  const rs = reasons.slice(0, 3).filter(Boolean);
  if (rs.length) {
    lines.push('');
    for (const r of rs) lines.push(`· ${r}`);
  }

  lines.push('');
  lines.push('点下面的按钮，或回复：');
  lines.push(`确认 ${token}`);
  lines.push(`（${Math.round(expiresInSec / 60)} 分钟内有效，仅你自己可确认）`);

  return lines.join('\n');
}
