/**
 * 输出分段与格式化
 *
 * QQ 消息有长度上限，而 DSH 的输出经常远超（代码 diff、分析报告）。
 * 朴素地按固定长度切断会切在代码块中间，把可读内容变成垃圾。
 *
 * 实现分两阶段：
 *   阶段 1：把文本切成"原子块"（优先段落，必要时拆成行/硬切片）
 *   阶段 2：贪心装箱，装箱时跟踪 ``` 围栏状态；若必须在代码块内断开，
 *           则先补闭合围栏，再在新段开头重开
 */

const FENCE = '```';

/** 统计字符串中 ``` 的出现次数（用于判断围栏奇偶）。 */
function fenceCount(s) {
  return (s.match(/```/g) ?? []).length;
}

/**
 * 阶段 1：把文本拆成原子块。
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
function toBlocks(text, limit) {
  const blocks = [];

  // 先按空行分段
  for (const para of text.split(/\n{2,}/)) {
    if (!para) continue;

    if (para.length <= limit) {
      blocks.push(para);
      continue;
    }

    // 段落超限 → 按行拆
    for (const line of para.split('\n')) {
      if (line.length <= limit) {
        blocks.push(line);
        continue;
      }
      // 单行超限 → 硬切
      for (let i = 0; i < line.length; i += limit) {
        blocks.push(line.slice(i, i + limit));
      }
    }
  }

  return blocks;
}

/**
 * 把长文本切成适合逐条发送的片段。
 *
 * @param {string} text
 * @param {number} limit 每段最大字符数
 * @returns {string[]}
 */
export function chunkText(text, limit = 1500) {
  const src = String(text ?? '');
  // 纯空白视为无内容，避免把一堆空行当成有效输出发出去
  if (!src.trim()) return [];

  // 防御非法 limit：
  //   limit = 0 会让 toBlocks 的 `i += limit` 永远不前进（死循环）
  //   limit < 0 会让 slice 循环构造出负数长度的数组（Invalid array length）
  let cap = Number(limit);
  if (!Number.isFinite(cap) || cap < 1) cap = 1500;
  cap = Math.floor(cap);

  if (src.length <= cap) return [src];

  const blocks = toBlocks(src, cap);
  const chunks = [];

  let buf = '';
  let inFence = false;

  /** 结算当前缓冲：若在代码块内则补闭合围栏。 */
  const close = () => {
    if (inFence) {
      buf += `\n${FENCE}`;
      inFence = false;
    }
    const out = buf.replace(/\s+$/, '');
    if (out) chunks.push(out);
    buf = '';
  };

  for (const block of blocks) {
    const sep = buf ? '\n\n' : '';
    const wouldBe = buf.length + sep.length + block.length;

    if (buf && wouldBe > cap) {
      // 放不下：结算当前段
      const wasInFence = inFence;
      close();
      // 若刚才是在代码块内被断开，新段开头重开围栏，保持代码可读
      if (wasInFence) {
        buf = `${FENCE}\n`;
        inFence = true;
      }
    }

    buf += (buf ? '\n\n' : '') + block;
    // 依据累计内容重新判定围栏状态，避免状态漂移
    inFence = fenceCount(buf) % 2 === 1;

    // 块本身就可能顶满，及时结算避免下一块拼接后超限
    if (buf.length >= cap) close();
  }

  if (buf) close();
  return chunks;
}

/**
 * 给分段加上序号前缀，便于用户知道还有多少条。
 * @param {string[]} chunks
 * @returns {string[]}
 */
export function withParts(chunks) {
  if (chunks.length <= 1) return chunks;
  const n = chunks.length;
  return chunks.map((c, i) => `(${i + 1}/${n})\n${c}`);
}

/**
 * 判断输出是否应该落盘为文件。
 */
export function shouldSendAsFile(text, outputCfg) {
  return String(text ?? '').length > outputCfg.fileThresholdChars;
}

/**
 * 为落盘内容生成摘要：保留头部若干行，并说明完整内容在文件里。
 */
export function summarizeForChat(text, headLines = 12) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  if (lines.length <= headLines) return src;
  const head = lines.slice(0, headLines).join('\n');
  const omitted = lines.length - headLines;
  return `${head}\n\n…（还有 ${omitted} 行，完整内容见附件文件）`;
}

/**
 * 生成适合做文件名的安全名字（Windows 非法字符全部替换）。
 */
export function safeFileName(base, ext = 'txt') {
  const cleaned = String(base ?? 'result')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 60);
  return `${cleaned || 'result'}.${ext}`;
}
