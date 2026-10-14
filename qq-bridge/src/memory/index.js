/**
 * 长期记忆库
 *
 * 解决的问题：桥接每次起一个新的 DSH 进程，agent 对用户的了解只来自本次任务
 * 文本。用户教过它的事情（"我的项目都在 D:\work"、"别动 C:\Windows"、
 * "发文件用微信别用邮件"）下一轮就忘了，于是每件事都要重复交代。
 *
 * 做法：一个 markdown 文件当记忆库。
 *   - 写入：手机 QQ 发 `/remember 内容`（确定性），或者直接对 agent 说
 *     "记住：…"（运行说明里告诉它文件路径与追加格式）。
 *   - 读取：每次任务开始时把记忆库内容作为【长期记忆】注入任务文本，
 *     于是 agent 每轮都能看到。
 *   - 人工可编辑：就是普通 markdown，用户可以直接改。
 *
 * 为什么用 markdown 而不是向量库/数据库：用户要的是"我教它一些事情"，
 * 量小、要能自己看懂和改、要能进版本库。一个文件正好。
 *
 * ⚠️ 注入是有代价的：记忆越长，每一步请求的 prompt 越大（本机上行小、
 *    长上下文 prefill 慢）。因此有 maxInjectChars（只带最新的一段）与
 *    maxFileChars（拒绝无限膨胀）两道闸门。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 新建记忆库时写入的表头（给人看的说明，agent 也会读到）。 */
export const MEMORY_HEADER = [
  '# DSH-QQ 机器人长期记忆',
  '',
  '> 这份文件是机器人的**长期记忆库**：桥接在每次任务开始时会把它注入给 agent，',
  '> 让它理解你的偏好、约定和以前交代过的事情。',
  '>',
  '> - 在手机 QQ 里发 `/remember 内容` 追加一条（自动带时间戳）。',
  '> - 也可以直接编辑本文件 —— 它就是普通 markdown。',
  '> - 直接对机器人说「记住：…」通常也行，agent 会按运行说明把内容追加进来。',
  '>',
  '> ⚠️ 只有以 `## ` 开头的小标题以下的内容才会被当成记忆注入；',
  '>    本段说明（第一个 `## ` 之前的部分）只是给人看的，不会被注入。',
  '',
].join('\n');

/** 条目计数：以 `## ` 开头的小标题即为一条记忆。 */
function countEntries(text) {
  const m = String(text ?? '').match(/^## /gm);
  return m ? m.length : 0;
}

/** 时间戳：`2026-10-12 03:20`（本地时间，给人看）。 */
function formatStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}`;
}

export class MemoryBank {
  /**
   * @param {object} opts
   * @param {string} opts.dir 记忆库目录
   * @param {string} [opts.file='MEMORY.md'] 主文件名
   * @param {number} [opts.maxInjectChars=6000] 每次注入的最大字符数
   * @param {number} [opts.maxFileChars=200000] 单文件最大字符数
   * @param {boolean} [opts.enabled=true] 关闭后既不注入也不接受写入
   * @param {() => Date} [opts.now] 可注入时钟（测试用）
   */
  constructor({ dir, file = 'MEMORY.md', maxInjectChars = 6000, maxFileChars = 200000, enabled = true, now } = {}) {
    this.enabled = enabled !== false;
    this.dir = String(dir ?? '');
    this.file = String(file || 'MEMORY.md');
    this.maxInjectChars = Number.isFinite(Number(maxInjectChars)) ? Math.max(0, Math.floor(maxInjectChars)) : 6000;
    this.maxFileChars = Number.isFinite(Number(maxFileChars)) ? Math.max(0, Math.floor(maxFileChars)) : 200000;
    this.#now = typeof now === 'function' ? now : () => new Date();
  }

  /** @type {() => Date} */
  #now;

  /** 记忆文件的绝对路径（未配置目录时返回 null）。 */
  get filePath() {
    if (!this.dir) return null;
    return join(this.dir, this.file);
  }

  /** 确保目录与文件存在（新建时写入表头）。返回文件路径。 */
  ensure() {
    const p = this.filePath;
    if (!p) return null;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      if (!existsSync(p)) writeFileSync(p, MEMORY_HEADER, 'utf8');
    } catch {
      /* 目录不可写等问题交给 append/read 的调用方处理 */
    }
    return p;
  }

  /** 读取记忆库原文；不存在或读不到时返回空串（绝不抛异常）。 */
  read() {
    const p = this.filePath;
    if (!p || !existsSync(p)) return '';
    try {
      return readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      return '';
    }
  }

  /**
   * 记忆**条目**部分 = 从第一个 `## ` 小标题开始的内容。
   *
   * 为什么按小标题切、而不是按表头字符串切：
   *   1. 用户可以直接编辑这个文件，可能在开头加自己的标题/说明 —— 用字符串
   *      比对表头的话，差一个字节就会把整段说明当成"记忆"注入进 prompt。
   *   2. 体积闸门（maxFileChars / maxInjectChars）只该算真正的记忆。
   *   3. 空库（只有说明、还没有条目）自然得到空串，于是**不会**注入任何东西。
   *
   * 代价：手写的记忆也必须以 `## ` 开头才会被注入 —— 这一点写在文件表头里。
   *
   * @returns {string}
   */
  #body() {
    const content = this.read();
    if (!content) return '';
    const m = /^## /m.exec(content);
    return m ? content.slice(m.index).trim() : '';
  }

  /**
   * 追加一条记忆。
   *
   * @param {string} text 用户教的内容（多行也可以）
   * @param {{at?: Date}} [opts]
   * @returns {{ok: boolean, reason?: string, chars?: number, entries?: number, path?: string|null}}
   */
  append(text, { at } = {}) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };

    const body = String(text ?? '').trim();
    if (!body) return { ok: false, reason: 'empty' };

    const p = this.ensure();
    if (!p) return { ok: false, reason: 'no-dir' };

    // 体积按"条目部分"算（不含表头）
    const currentBody = this.#body();
    if (currentBody.length >= this.maxFileChars) return { ok: false, reason: 'file-too-large', chars: currentBody.length };
    if (currentBody.length + body.length > this.maxFileChars) return { ok: false, reason: 'would-exceed', chars: currentBody.length };

    const stamp = formatStamp(at instanceof Date ? at : this.#now());
    try {
      appendFileSync(p, `\n## ${stamp}\n\n${body}\n`, 'utf8');
    } catch (e) {
      return { ok: false, reason: `write-failed: ${e?.message ?? e}` };
    }

    const after = this.#body();
    return { ok: true, chars: after.length, entries: countEntries(after), path: p };
  }

  /**
   * 生成注入给 agent 的【长期记忆】文本。
   * 返回空串表示"没有可注入的内容"（未启用 / 文件不存在 / 文件还没内容）。
   *
   * 超出 maxInjectChars 时保留**最新**的一段：记忆是按时间追加的，
   * 越后面越新，通常也越相关。
   *
   * @returns {string}
   */
  injectText() {
    if (!this.enabled) return '';

    // 只看条目部分：刚建好、只有表头的记忆库等于"没有记忆"，不该注入样板文字
    let body = this.#body();
    if (!body) return '';

    let truncated = false;
    if (this.maxInjectChars > 0 && body.length > this.maxInjectChars) {
      body = body.slice(-this.maxInjectChars);
      const nl = body.indexOf('\n');
      if (nl >= 0) body = body.slice(nl + 1);
      truncated = true;
    }

    return [
      '【长期记忆】',
      '以下是用户此前教给你的、或你此前记录的事情（按时间从早到晚）。',
      '把它们当作用户的偏好与背景来理解他的意图；与当前这句话冲突时，以当前这句话为准。',
      truncated ? '（更早的记忆已省略）' : '',
      '',
      body,
    ].filter((line) => line !== '').join('\n').replace(/\n{3,}/g, '\n\n');
  }

  /** 状态摘要（给 /memory 命令与自检用）。 */
  stats() {
    const p = this.filePath;
    const body = this.#body();
    let bytes = 0;
    try {
      bytes = p && existsSync(p) ? statSync(p).size : 0;
    } catch { /* ignore */ }
    return {
      enabled: this.enabled,
      path: p,
      exists: !!p && existsSync(p),
      // chars 指"记忆条目"的字数（不含文件表头），bytes 是整个文件大小
      chars: body.length,
      bytes,
      entries: countEntries(body),
    };
  }
}
