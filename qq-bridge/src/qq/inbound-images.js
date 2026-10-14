/**
 * QQ 入站图片 → 本地文件
 *
 * 问题：用户直接在 QQ 里发图，桥接此前只取 `msg.content`（文字），图片被
 * 静默丢弃 —— 模型这边看到的只是"（没有文字）"，于是答非所问。
 *
 * 做法：把消息里的图片附件下载到本地目录，然后把**绝对路径**放进任务文本，
 * 由 agent 用 `read_image` 工具去看。为什么不直接把图片塞进模型请求：
 * DSH 的 headless CLI 只接受一个任务字符串，没有传图入口；而 agent 本来就有
 * `read_image`，给它路径是最贴合现有工具链的方式。
 *
 * 安全/稳健性：
 *   - 只接受 content_type 以 image/ 开头的附件；
 *   - 限制单张大小（maxBytes）与超时；下载失败不影响任务，只是日志里记一笔；
 *   - 文件名由我们自己生成（时间戳+序号+安全扩展名），不采用远端文件名，
 *     避免路径穿越/奇怪字符；目录限定在配置的 imageDir 内。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

/** 允许的图片扩展名（由 content_type 推导，未知则 .img）。 */
const CONTENT_TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

/**
 * 从入站消息里挑出图片附件（纯函数，便于测试）。
 *
 * 两个来源都要看：
 *   - `msg.attachments`：本条消息的附件（SDK 已归一化）；
 *   - `msg.msg_elements[].attachments`：引用/富媒体场景下附件只在这里。
 *
 * @param {object} msg SDK 归一化后的入站消息
 * @returns {Array<{url: string, contentType: string, size?: number, filename?: string}>}
 */
export function extractImages(msg) {
  if (!msg || typeof msg !== 'object') return [];

  const out = [];
  const push = (a) => {
    if (!a || typeof a !== 'object') return;
    const contentType = String(a.content_type ?? a.contentType ?? '');
    const url = String(a.url ?? '');
    if (!url) return;
    if (!/^image\//i.test(contentType)) return;
    out.push({
      url,
      contentType: contentType.toLowerCase(),
      size: Number.isFinite(Number(a.size)) ? Number(a.size) : undefined,
      filename: a.filename ? String(a.filename) : undefined,
    });
  };

  if (Array.isArray(msg.attachments)) msg.attachments.forEach(push);
  if (Array.isArray(msg.msg_elements)) {
    for (const el of msg.msg_elements) {
      if (el && Array.isArray(el.attachments)) el.attachments.forEach(push);
    }
  }

  // 去重：同一条消息里 attachments 与 msg_elements 可能重复列出同一张图
  const seen = new Set();
  return out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

/**
 * 下载图片到本地。
 *
 * 任何一张图失败都不会抛异常：返回结果数组，逐项带 ok/reason，调用方
 * 可以照常执行任务（只是那张图用不了）。
 *
 * @param {object} opts
 * @param {Array<{url: string, contentType: string, size?: number}>} opts.images
 * @param {string} opts.dir 落地目录
 * @param {number} [opts.maxBytes=10*1024*1024] 单张上限
 * @param {number} [opts.timeoutMs=20000]
 * @param {Function} [opts.fetchImpl] 可注入的 fetch（测试用）
 * @param {string} [opts.prefix] 文件名前缀（默认按时间）
 * @param {(m: string) => void} [opts.log]
 * @returns {Promise<Array<{ok: boolean, path?: string, bytes?: number, contentType?: string, reason?: string, url: string}>>}
 */
export async function downloadImages({
  images,
  dir,
  maxBytes = 10 * 1024 * 1024,
  timeoutMs = 20_000,
  fetchImpl,
  prefix,
  log = () => {},
}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return [];

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const stamp = prefix ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const results = [];

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    log(`图片目录创建失败: ${dir} — ${e.message}`);
    return list.map((im) => ({ ok: false, url: im.url, reason: `mkdir-failed: ${e.message}` }));
  }

  for (let i = 0; i < list.length; i++) {
    const im = list[i];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
    try {
      if (Number.isFinite(im.size) && im.size > maxBytes) {
        results.push({ ok: false, url: im.url, reason: `too-large: ${im.size} > ${maxBytes}` });
        continue;
      }

      const res = await doFetch(im.url, {
        signal: ctl.signal,
        headers: { 'user-agent': 'dsh-qq-bridge/0.1', accept: 'image/*' },
      });
      if (!res || !res.ok) {
        results.push({ ok: false, url: im.url, reason: `http-${res?.status ?? 'error'}` });
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        results.push({ ok: false, url: im.url, reason: `too-large: ${buf.length} > ${maxBytes}` });
        continue;
      }

      const ext = CONTENT_TYPE_EXT[im.contentType] || extname(im.filename || '') || '.img';
      const path = join(dir, `${stamp}-${i + 1}${ext}`);
      writeFileSync(path, buf);
      results.push({ ok: true, path, bytes: buf.length, contentType: im.contentType, url: im.url });
      log(`已保存图片 ${path} (${buf.length} 字节)`);
    } catch (e) {
      results.push({ ok: false, url: im.url, reason: ctl.signal.aborted ? 'timeout' : String(e?.message ?? e) });
      log(`图片下载失败 ${im.url}: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

/**
 * 把成功的图片路径拼成给 agent 的任务文本块（纯函数，便于测试）。
 * @param {string[]} paths
 * @returns {string} 没有路径时返回空串
 */
export function formatImageBlock(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
  if (!list.length) return '';
  return [
    '【用户随消息发来的图片】',
    ...list.map((p) => `- ${p}`),
    '需要看图时用 read_image 工具读取上面的绝对路径。',
  ].join('\n');
}
