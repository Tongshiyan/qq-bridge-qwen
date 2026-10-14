/**
 * 产物落盘与「把文件直接发到 QQ」
 *
 * 背景：长输出以前只落盘 + 回一条文本路径，用户必须回到电脑前才能取文件。
 * 现在优先用 SDK 的 sendFile 把文件本体发过去，失败再退回「摘要 + 路径」。
 *
 * 关键约束：本模块处在回复链路上，任何异常都会让用户彻底拿不到结果，
 * 因此所有导出函数都保证「不抛异常」，只通过返回值与 log 汇报真实结局。
 *
 * 投递结局（sendArtifact 的 delivered 字段）：
 *   file    —— 文件已通过 QQ 送达
 *   summary —— 文件没发成/没发，回退为摘要 + 磁盘路径（含完整文本分段丢给 sendText）
 *   text    —— 连摘要都发不出去，只返回结局供调用方兜底
 *
 * 大小取舍：超过 100MB 的结果**不落盘**——反正发不出去，写下去只会白占磁盘，
 * 因此退回「摘要 + 纯文本分段」，并在日志与返回值里说明原因。
 */

import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { safeFileName, chunkText } from './chunk.js';

/**
 * 判断用户是否明确要求"把文件发过来"。
 *
 * 为什么需要：最早的实现只有一个触发条件 —— 「结果文本超过阈值就发文件」。
 * 那个假设是错的。实测场景：用户说「把桌面的简历发给我」，
 * agent 因为没有投递通道，改把 PDF 全文提取成文字贴出来（1295 字符 < 阈值 6000），
 * 于是桥接判定"结果不长"，按文本发走 —— **用户要文件，收到的是一堆文字**。
 *
 * 真正该看的不是结果多长，而是**用户要的是不是文件**。
 * 只认高置信度措辞，避免误触发（"发给我看看"是要结论，不是要文件）。
 *
 * @param {string} taskText
 * @returns {boolean}
 */
export function wantsFileDelivery(taskText) {
  const t = toStr(taskText);
  if (!t) return false;
  const zh = /(发|传|推|送|分享)(给)?我|给我(发|传|推|送)|发过来|传过来|发我|发份|来一份|打包(发|给)/;
  const en = /\b(send|share|attach|give)\s+(me|it|the\s+file)|\bsend\s+\S+\s+to\s+me\b/i;
  return zh.test(t) || en.test(t);
}

/**
 * 从 agent 的输出里提取"要投递的文件路径"。
 *
 * 两种来源，按可靠性排序：
 *   1. 显式标记 `SEND_FILE: <路径>` —— 最可靠。桥接在系统提示里要求 agent
 *      在文件场景输出这一行，避免靠猜。
 *   2. 绝对路径 + 常见扩展名 —— 兜底。必须真实存在，否则会把 agent
 *      虚构/写错的路径当文件去发。
 *
 * @param {string} text
 * @param {(p: string) => boolean} [exists] 存在性判定（可注入，便于测试）
 * @returns {string|null}
 */
/**
 * 只识别显式 `SEND_FILE: <路径>` 标记（不做「路径+扩展名」兜底）。
 *
 * 显式标记是 agent 与桥接之间的明确契约（系统提示里约定过），
 * 应当**始终生效**，与用户消息的措辞无关；只有兜底启发式
 * 才需要「用户明确要文件」这个前提来防误报。
 */
export function extractMarkedSendFile(text, exists = existsSync) {
  const body = toStr(text);
  if (!body) return null;
  const marked = /^[ \t]*SEND_FILE[ \t]*:[ \t]*`?([^\n`]+?)`?[ \t]*$/im.exec(body);
  if (marked) {
    const p = marked[1].trim();
    if (p && exists(p)) return p;
  }
  return null;
}

export function extractSendablePath(text, exists = existsSync) {
  // 1) 显式标记（容忍反引号包裹）
  const marked = extractMarkedSendFile(text, exists);
  if (marked) return marked;

  const body = toStr(text);
  if (!body) return null;

  // 2) 兜底：绝对路径 + 扩展名；从后往前取第一个真实存在的
  const ext = 'pdf|docx?|xlsx?|pptx?|txt|md|csv|json|zip|7z|rar|png|jpe?g|gif|webp|mp[34]|wav|log|py|js|ts|html?';
  const re = new RegExp(`([A-Za-z]:\\\\[^\\n\`"'<>|*?]*?\\.(?:${ext}))`, 'gi');
  const found = [...body.matchAll(re)].map((m) => m[1].trim());
  for (let i = found.length - 1; i >= 0; i--) {
    if (exists(found[i])) return found[i];
  }
  return null;
}

/**
 * 发送一个已存在的文件（不做上传/降级决策，失败即返回原因）。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function sendExistingFile(bot, target, filePath, opts = {}) {
  const log = opts.log;
  if (!bot || typeof bot.sendFile !== 'function') {
    return { ok: false, reason: 'bot 不可用或不支持 sendFile' };
  }
  if (!target || !target.targetId) {
    return { ok: false, reason: '缺少发送目标' };
  }
  try {
    await bot.sendFile(target, { localPath: filePath }, {
      fileName: opts.fileName,
      content: opts.content,
    });
    log?.('artifact.sent-requested-file', { path: filePath });
    return { ok: true };
  } catch (e) {
    const reason = e?.message ?? String(e);
    log?.('artifact.requested-file-failed', { path: filePath, error: reason });
    return { ok: false, reason };
  }
}

/** QQ 平台 FILE 类型上限（USAGE.md §10.3），超过它 sendFile 必然失败，不做无用尝试。 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** 摘要默认保留的头部行数。 */
const DEFAULT_HEAD_LINES = 12;

/** 落盘扩展名（safeFileName 的 ext 参数）。 */
const DEFAULT_EXT = 'txt';

/** 空值安全的字符串化。 */
function toStr(v) {
  return typeof v === 'string' ? v : String(v ?? '');
}

/** 空值安全的日志：log 本身也可能是坏值。 */
function safeLog(log, event, data) {
  if (typeof log !== 'function') return;
  try {
    log(event, data);
  } catch {
    // 诊断链路出问题不能影响投递
  }
}

/** 把任意异常压成一行可读文本（SDK 错误体常常是对象而不是 Error）。 */
function errText(e) {
  if (!e) return 'unknown';
  if (typeof e === 'string') return e;
  const code = e.code ?? e.errCode ?? e.errcode;
  const msg = e.message ?? e.msg ?? e.error ?? '';
  return [code, msg].filter(Boolean).join(' ') || String(e);
}

/**
 * 同一毫秒内的自增序号。
 *
 * 时间戳只精确到毫秒，同一毫秒内的两次落盘会算出同名文件而互相覆盖；
 * 一个进程内的自增序号即可消解这种情况（桥接服务是单进程）。
 */
let seq = 0;

/**
 * 生成带时间戳的产物文件名。
 * 时间戳（毫秒级）保证重复运行不互相覆盖，safeFileName 负责清掉 Windows 非法字符。
 * @param {string} taskText
 * @param {string} ext
 * @returns {string}
 */
function artifactName(taskText, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  seq = (seq + 1) % 1000;
  return `${stamp}-${String(seq).padStart(3, '0')}-${safeFileName(taskText, ext)}`;
}

/**
 * 探测磁盘上文件的大小（字节）。
 *
 * 独立成函数是为了可测试：100MB 的守卫无法靠真的写一个 100MB 文件来验证，
 * 测试可用 ctx.maxFileBytes 注入小阈值，再喂一个刚过界的小文件。
 *
 * @param {string} filePath
 * @returns {number} 拿不到大小时返回 -1（此时不拦截，交给 SDK 自己报错）
 */
export function probeFileSize(filePath) {
  try {
    const st = statSync(filePath);
    return Number.isFinite(st.size) ? st.size : -1;
  } catch (e) {
    safeLog(null, 'artifact.size-probe-failed', { path: filePath, error: errText(e) });
    return -1;
  }
}

/**
 * 把长结果落盘，返回文件信息；失败或超上限返回 null（绝不抛）。
 *
 * 大小上限默认 MAX_FILE_BYTES，且在**写入之前**用 UTF-8 字节数预判，
 * 因此不会为了一个反正发不出去的结果把磁盘写满。
 *
 * @param {string} text 要落盘的完整内容
 * @param {string} taskText 原始任务文本，仅用于生成可读文件名
 * @param {{dir: string, ext?: string, maxBytes?: number}} opts dir 为绝对产物目录
 * @returns {{path: string, bytes: number, fileName: string} | null}
 */
export function saveArtifact(text, taskText, opts) {
  const dir = opts?.dir;
  if (!dir) return null; // 没有目录就没法落盘，交回调用方走纯文本路径
  try {
    const body = toStr(text);
    const ext = opts?.ext || DEFAULT_EXT;

    // 预估字节数（UTF-8 下界是字符数，中文等会更大，这里用 Buffer 精确算）
    const ceiling = Number.isFinite(opts?.maxBytes) ? opts.maxBytes : MAX_FILE_BYTES;
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > ceiling) return null; // 超上限：不写盘，让调用方回退为文本

    const fileName = artifactName(taskText, ext);

    mkdirSync(dir, { recursive: true });

    const path = join(dir, fileName);
    writeFileSync(path, body, 'utf8');

    const st = statSync(path);
    return { path, bytes: st.size, fileName };
  } catch {
    // 磁盘满 / 权限不足 / 路径非法：返回 null，让调用方退回文本
    return null;
  }
}

/**
 * 构造回退文案：摘要 + 磁盘路径。
 *
 * 有路径时优先带上路径——这本身就是「当前行为」的兜底，用户至少知道文件在哪。
 * 连落盘都失败时退回纯摘要（或纯文本分段），保证结果不丢。
 *
 * @param {string} body 完整文本
 * @param {string} path 产物路径，可能为 null
 * @param {object} ctx
 * @param {string} note 为什么没能发文件（会展示给用户）
 * @returns {string[]} 待发送的文本分段
 */
function buildFallback(body, path, ctx, note) {
  const headLines = Number.isFinite(ctx?.headLines) ? ctx.headLines : DEFAULT_HEAD_LINES;
  let summary;
  try {
    summary = typeof ctx?.summarize === 'function'
      ? toStr(ctx.summarize(body, headLines))
      : body;
  } catch {
    summary = body; // 摘要器坏了不是丢内容的理由
  }
  if (!summary.trim()) summary = body.slice(0, 3000);

  // 顺序很重要：降级原因与磁盘路径必须排在摘要前面。
  // 摘要可能长到被 chunkText 切成多条，若把原因放在最后，用户看到的第一条
  // 就只剩半截内容、完全不知道发生了什么。
  const parts = [];
  if (note) parts.push(`⚠️ 未作为文件发送：${note}`);
  if (path) parts.push(`📄 完整结果已保存:\n${path}`);
  parts.push(summary);

  // 走桥接的 sendText 时按 maxMessageChars 分段，避免单条超限被平台拒收
  const limit = Number.isFinite(ctx?.maxMessageChars) ? ctx.maxMessageChars : undefined;
  return chunkText(parts.join('\n\n'), limit);
}

/**
 * 落盘（按需）并通过 QQ 投递结果。
 *
 * 回退链：sendFile(localPath) → 摘要 + 路径（失败原因告知用户）→ 只返回结局。
 *
 * @param {string} text 完整结果
 * @param {string} taskText 原始任务文本
 * @param {{
 *   bot?: object,
 *   target?: {scope: string, targetId: string, msgId?: string},
 *   sendText?: (text: string) => Promise<void>,
 *   dir?: string,
 *   thresholdChars?: number,
 *   sendFileWhenLarge?: boolean,
 *   summarize?: (text: string, headLines: number) => string,
 *   headLines?: number,
 *   log?: (event: string, data?: object) => void,
 *   ext?: string,
 *   maxMessageChars?: number,
 *   maxFileBytes?: number,
 * }} ctx
 * @returns {Promise<{delivered: 'file'|'text'|'summary', path: string|null, reason?: string}>}
 */
export async function sendArtifact(text, taskText, ctx) {  const c = ctx ?? {};
  const log = c.log;
  const body = toStr(text);
  /** @type {{delivered: 'file'|'text'|'summary', path: string|null, reason?: string}} */
  const result = { delivered: 'text', path: null };

  // 发送文本：sendText 缺失或它自己抛错都只记日志，不影响后续判断
  const trySendText = async (chunks) => {
    if (typeof c.sendText !== 'function') {
      return { ok: false, reason: 'sendText 不可用' };
    }
    try {
      for (const part of chunks) {
        if (!part) continue;
        await c.sendText(part);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: errText(e) };
    }
  };

  try {
    // ── 空内容：没什么可发的，但要如实汇报
    if (!body.trim()) {
      result.reason = 'empty-text';
      safeLog(log, 'artifact.empty', { taskChars: toStr(taskText).length });
      return result;
    }

    // ── 是否值得落盘
    const threshold = Number.isFinite(c.thresholdChars) ? c.thresholdChars : 0;
    const wantFile = body.length > threshold;

    // 文件大小上限：用于决定「值不值得写盘」以及「能不能发」。可覆盖以便测试注入。
    const ceiling = Number.isFinite(c.maxFileBytes) ? c.maxFileBytes : MAX_FILE_BYTES;
    const bodyBytes = Buffer.byteLength(body, 'utf8');

    // sendFileWhenLarge === false 时：仍然落盘（调用方要 path），但绝不尝试 sendFile
    const fileAllowed = c.sendFileWhenLarge !== false;

    let saved = null;
    if (wantFile) {
      saved = saveArtifact(body, taskText, { dir: c.dir, ext: c.ext, maxBytes: ceiling });
      result.path = saved?.path ?? null;
      if (saved) {
        safeLog(log, 'artifact.saved', { path: saved.path, bytes: saved.bytes });
      } else {
        safeLog(log, 'artifact.save-failed', {
          dir: c.dir ?? null, chars: body.length, bytes: bodyBytes, ceiling,
        });
      }
    } else {
      safeLog(log, 'artifact.below-threshold', { chars: body.length, threshold });
    }

    // ── 不值得落盘：直接原文分段发出去
    if (!wantFile) {
      const sent = await trySendText(chunkText(body, c.maxMessageChars));
      if (sent.ok) {
        result.delivered = 'text';
        safeLog(log, 'artifact.sent-text', { chars: body.length });
      } else {
        result.delivered = 'text';
        result.reason = `send-text-failed: ${sent.reason}`;
        safeLog(log, 'artifact.send-text-failed', { error: sent.reason });
      }
      return result;
    }

    // ── 不尝试文件的原因，按优先级判定（先便宜后昂贵）
    let skipReason = null;
    if (!fileAllowed) {
      skipReason = '配置关闭了 sendFileWhenLarge';
    } else if (bodyBytes > ceiling) {
      skipReason = `内容 ${bodyBytes} 字节超过文件上限 ${ceiling} 字节`;
    } else if (!saved) {
      skipReason = '落盘失败，无法作为文件发送';
    } else if (!c.bot || typeof c.bot.sendFile !== 'function') {
      skipReason = c.bot ? 'bot.sendFile 不可用' : 'bot 不可用';
    } else if (!c.target?.targetId) {
      skipReason = '缺少有效的 replyTarget';
    } else {
      // 二次确认磁盘上的真实大小（写盘与发送之间可能有别的进程改动）
      const bytes = probeFileSize(saved.path);
      if (bytes >= 0 && bytes > ceiling) {
        skipReason = `文件 ${bytes} 字节超过上限 ${ceiling} 字节`;
      }
    }

    // ── 主路径：把文件本体发过去
    if (!skipReason) {
      try {
        await c.bot.sendFile(c.target, { localPath: saved.path }, { fileName: saved.fileName });
        result.delivered = 'file';
        safeLog(log, 'artifact.sent-file', {
          path: saved.path,
          bytes: saved.bytes,
          targetId: c.target?.targetId,
          scope: c.target?.scope,
        });
        return result;
      } catch (e) {
        // 无文件消息权限 / 主动消息额度用尽 / 网络错误 / 超限：一律退化为文本
        skipReason = errText(e);
        safeLog(log, 'artifact.send-file-failed', {
          path: saved.path,
          bytes: saved.bytes,
          hasMsgId: Boolean(c.target?.msgId),
          error: skipReason,
        });
      }
    } else {
      safeLog(log, 'artifact.send-file-skipped', { path: saved?.path ?? null, reason: skipReason });
    }

    // ── 回退链：摘要 + 路径（即改造前的行为），必要时附上失败原因
    const chunks = buildFallback(body, saved?.path ?? null, c, skipReason);
    const sent = await trySendText(chunks);
    if (sent.ok) {
      result.delivered = 'summary';
      result.reason = `degraded: ${skipReason}`;
      safeLog(log, 'artifact.degraded-to-summary', { path: saved?.path ?? null, reason: skipReason });
    } else {
      // 连摘要都没发出去：不抛，把真实情况写进返回值让调用方决定怎么办
      result.delivered = 'text';
      result.reason = `send failed: ${sent.reason}; file error: ${skipReason}`;
      safeLog(log, 'artifact.send-summary-failed', { error: sent.reason, path: saved?.path ?? null });
    }
    return result;
  } catch (e) {
    // 兜底：上面的分支都做过防御，但绝不能让任何意外冒泡到回复链路
    result.reason = `unexpected: ${errText(e)}`;
    safeLog(log, 'artifact.unexpected-error', { error: result.reason });
    return result;
  }
}
