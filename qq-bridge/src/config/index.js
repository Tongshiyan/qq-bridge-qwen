/**
 * 配置加载层
 *
 * 职责：
 *   - 从 config/config.json 读非敏感配置
 *   - 从 config/creds.json 或环境变量读凭证
 *   - 提供脱敏工具（日志里绝不能出现完整密钥）
 *
 * 配置优先级：环境变量 > config/creds.json > 内置默认值
 *
 * 关于 BOM：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写入
 * UTF-8 BOM，而 JSON.parse 不接受 BOM。本模块读取时统一剥掉，避免用户
 * 手写配置文件时踩坑。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '..', '..');

/** 读取 JSON，自动剥 BOM，失败时给出可操作的错误信息。 */
function readJson(path, { required = false, label = path } = {}) {
  if (!existsSync(path)) {
    if (required) {
      throw new ConfigError(
        `找不到 ${label}\n  期望路径: ${path}` +
        `\n  请创建该文件，或改用环境变量提供。`
      );
    }
    return null;
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`无法读取 ${label}: ${e.message}`);
  }
  // 剥掉 UTF-8 BOM（PowerShell 5.1 的常见产物）
  const cleaned = raw.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new ConfigError(
      `${label} 不是合法 JSON: ${e.message}\n  路径: ${path}` +
      `\n  常见原因: 尾随逗号、单引号、或复制时混入了不可见字符。`
    );
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 密钥脱敏：保留首尾少量字符，中间打码。 */
export function mask(secret) {
  if (secret === null || secret === undefined || secret === '') return '(未设置)';
  const s = String(secret);
  if (s.length <= 6) return s[0] + '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

/**
 * 脱敏任意对象中的敏感字段，用于安全地写日志。
 * 递归处理，遇到敏感键名即替换为脱敏值。
 */
const SENSITIVE_KEY_RE = /(secret|token|password|passwd|credential|apikey|api_key|authorization|cookie)/i;

export function redact(value, depth = 0) {
  if (depth > 6) return '[深度截断]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = typeof v === 'string' ? mask(v) : '[已脱敏]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function resolveFromRoot(p) {
  return isAbsolute(p) ? p : resolve(PROJECT_ROOT, p);
}

/** 解析布尔型环境变量。 */
function envBool(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** 解析列表型环境变量（逗号分隔）。 */
function envList(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function envInt(name) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 占位符识别。
 *
 * 为什么需要：配置文件是带注释的模板，用户很容易忘记替换占位符就启动。
 * 更糟的是占位符会让白名单"看起来非空"，从而掩盖掉"空白名单"告警 ——
 * 用户以为配好了，实际谁都进不来，且没有任何提示。
 * 这里主动识别占位符并给出明确指引。
 */
const PLACEHOLDER_RE = /在这里填入|填入你的|你的\s*openid|your[_\s-]?openid|xxx+|todo|changeme|<.*>/i;

function isPlaceholder(s) {
  return typeof s === 'string' && PLACEHOLDER_RE.test(s);
}

/** 剔除注释键（以 _ 开头）与占位符白名单项。 */
export function sanitizeAllowedIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const real = [];
  const placeholders = [];
  for (const v of list) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    if (isPlaceholder(s)) { placeholders.push(s); continue; }
    real.push(s);
  }
  return { real, placeholders };
}

/**
 * 判断 `candidate` 是否等于 `root` 或位于其内部（目录边界比较）。
 *
 * 用于临时目录与 workspace 的关系判定。用 path.relative 而非字符串前缀，
 * 避免 `C:\Users\Shane2` 被误判为在 `%USERPROFILE%` 之内这类经典错误。
 */
export function isInsideDirectory(root, candidate) {
  if (!root || !candidate) return false;
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * 检查沙箱临时目录是否满足 DSH Windows ACL 沙箱的硬要求。
 *
 * 返回 null 表示通过；否则返回人类可读的错误说明。
 * 抽成纯函数是为了可测 —— 这条约束一旦不满足，
 * 该 profile 下所有命令行工具都会失效，但报错出现在工具调用层，
 * 现象是"PowerShell 莫名其妙用不了"，很难追到根因。
 *
 * @param {string} workspaceRoot
 * @param {string|null|undefined} tempDir 为 null 表示用系统默认
 * @returns {{severity: 'error'|'warning', message: string, effectiveTemp: string}|null}
 */
export function checkSandboxTemp(workspaceRoot, tempDir) {
  const ws = resolve(String(workspaceRoot));
  const explicit = tempDir != null && String(tempDir).trim() !== '';
  const effective = explicit ? resolve(String(tempDir)) : tmpdir();

  if (!isInsideDirectory(ws, effective)) return null;

  const detail =
    `      workspace : ${ws}\n` +
    `      临时目录  : ${effective}${explicit ? '' : '（系统默认，来自 %TEMP%）'}\n` +
    `      原因: DSH 的 Windows ACL 沙箱要求临时根在 workspace 之外，\n` +
    `            否则 workspace 的常驻写入权限会被私有临时目录继承。\n` +
    `            不满足时该 profile 下【所有命令行操作】都会在沙箱启动阶段失败，\n` +
    `            报 "Windows ACL temp root must be outside the workspace"。`;

  if (explicit) {
    return {
      severity: 'error',
      effectiveTemp: effective,
      message:
        `dsh.sandboxTempDir 不能位于 dsh.workspace 之内。\n${detail}` +
        `      修法: 设成 workspace 之外的绝对路径（注意项目目录本身可能也在\n` +
        `            workspace 内），或把 dsh.workspace 收窄到不含 %TEMP% 的目录。`,
    };
  }

  return {
    severity: 'warning',
    effectiveTemp: effective,
    message:
      `系统临时目录落在 dsh.workspace 之内，命令行工具将无法启动。\n${detail}` +
      `      修法: 配置 dsh.sandboxTempDir 指向 workspace 之外的目录。`,
  };
}

/**
 * 读取 headless profile 的 patch 层，推断 DSH 的有效权限。
 *
 * 为什么需要可见性：权限是"配置写了才生效"的东西，而 patch 的 id 或字段一旦写错
 * 就会**静默失效** —— 用户会以为已经放开，实际仍受限，然后在排查时浪费大量时间。
 * 本项目为此踩过两次坑：provider 配置，以及**把 sandboxPolicy.mode 单独改成
 * danger-full-access 却没配 approval，导致"沙箱+审批"组合匹配不上任何预设，
 * 整个权限插件拒绝激活**（表现为：改了配置反而更受限）。
 *
 * 因此这里除了读值，还会对"危险组合"给出明确告警。
 *
 * 注意：本函数只解析 YAML 字面值用于**展示与告警**，不改变 DSH 行为 ——
 * 真正的判定权在 DSH 自己。读不到时返回 null 而不是猜一个。
 *
 * @param {string} [profileName='headless']
 * @returns {{mode: string|null, preset: string|null, approval: string|null,
 *            workspaceRoot: string|null, source: string|null,
 *            error: string|null, warning: string|null}}
 */
export function readHeadlessSandboxMode(profileName = 'headless') {
  const empty = {
    mode: null, preset: null, approval: null, workspaceRoot: null,
    source: null, error: null, warning: null,
  };
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
  const patchPath = join(home, 'profiles', profileName, 'cordis.patch.yml');

  try {
    if (!existsSync(patchPath)) {
      return { ...empty, error: `未找到 ${patchPath}` };
    }
    return parsePermissionPatch(readFileSync(patchPath, 'utf8'), patchPath);
  } catch (e) {
    return { ...empty, source: patchPath, error: e.message };
  }
}

/** 内置预设的「沙箱 + 审批」配对关系（见 dsh-permission-presets 的 Config 定义）。 */
export const KNOWN_PRESETS = {
  'workspace-write': { mode: 'workspace-write', approval: 'ask' },
  'danger-full-access': { mode: 'danger-full-access', approval: 'never' },
  'read-only': { mode: 'read-only', approval: 'ask' },
};

/**
 * 解析 patch 层文本，推断有效权限（纯函数，便于测试）。
 *
 * @param {string} text
 * @param {string|null} [source] 仅用于回报来源
 * @returns {{mode: string|null, preset: string|null, approval: string|null,
 *            workspaceRoot: string|null, source: string|null,
 *            error: string|null, warning: string|null}}
 */
export function parsePermissionPatch(text, source = null) {
  const body = String(text ?? '').replace(/^\uFEFF/, '');
  const empty = {
    mode: null, preset: null, approval: null, workspaceRoot: null,
    source, error: null, warning: null,
  };

  const grab = (key) =>
    new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*["']?([^"'\\n\\r]+?)["']?[ \\t]*$`, 'm')
      .exec(body)?.[1]?.trim() ?? null;

  const rawRoot = grab('workspaceRoot');
  // YAML 里 Windows 路径常写成 "C:\\Users\\..."（双反斜杠），展示时还原成单个
  const workspaceRoot = rawRoot ? rawRoot.replace(/\\\\/g, '\\') : null;

  // 路径 A（推荐）：defaultPreset 一次性指定，沙箱与审批成对生效
  const preset = grab('defaultPreset');
  if (preset) {
    const known = KNOWN_PRESETS[preset];
    return {
      ...empty,
      preset,
      mode: known?.mode ?? null,
      approval: known?.approval ?? null,
      workspaceRoot,
      warning: known ? null : `未知的 preset "${preset}"，请核对 dsh-permission-presets 的定义`,
    };
  }

  // 路径 B：直接改 sandboxPolicy.mode —— 只在同时配对 approval 时才安全
  if (/dsh-sandbox-policy/.test(body)) {
    const mode = grab('mode');
    let warning = null;
    if (mode === 'danger-full-access') {
      // 这正是踩过的坑：只改 mode 会让「沙箱+审批」组合匹配不上任何预设
      warning =
        '只改了 sandboxPolicy.mode=danger-full-access 却没配 approval，' +
        '组合会匹配不上任何预设，导致权限插件拒绝激活（反而更受限）。' +
        '请改用 defaultPreset: danger-full-access';
    }
    return { ...empty, mode, workspaceRoot, warning };
  }

  // 两条都没写 —— 用 bundle 默认（具体值只有 DSH 知道，这里不猜）
  return { ...empty, workspaceRoot };
}

/** 内置默认配置。 */
export const DEFAULTS = {
  // ── DSH 调用 ────────────────────────────────────────────────
  dsh: {
    // dsh CLI 入口（DSH 桌面版自带）
    cliPath: 'D:\\softwares\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd',
    // ★ 直接调用 Node 入口的路径。优先于 cliPath 使用。
    //
    // 为什么不用 cliPath：dsh.cmd 必须经 cmd.exe 启动（Node 20+ 禁止直接
    // spawn .cmd），而 cmd.exe 会重新解析命令行字符串，导致任务文本里的
    // `&`、`|`、`>`、`%VAR%` 被当作 shell 语法执行 —— 实测确认存在命令注入。
    // 按 dsh.cmd 内部的等价写法直接调 Node，就完全绕开了 cmd.exe。
    //
    // jsEntry 位于 app.asar 内，普通 Test-Path 看不到它，但 Electron 的 fs
    // 层能解析 —— 因此 nodeExe 必须是 Electron 本体而非独立 node。
    nodeExe: 'D:\\softwares\\dsh\\DeepSeek Harness.exe',
    jsEntry: 'D:\\softwares\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
    // ★ 传给 DSH 子进程的权限模式（DSH_PERMISSION_MODE）。
    //
    // 这是**官方开关**，由 `dsh --dump-config` 可以清楚看到它是环境变量驱动的：
    //     - id: sandbox-policy
    //       config:
    //         mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    //     - id: approval
    //       config:
    //         policy: !!js (… DSH_PERMISSION_MODE …) === 'danger-full-access'
    //                        ? 'never' : 'ask'
    // 沙箱与审批从这个变量**成对派生** —— 这正是"权限预设"的实现方式。
    //
    // 取值：read-only | workspace-write | danger-full-access（null = 不干预，用默认）
    //
    // ⚠️ 别再去改 profile 的 patch 层了。我为此连续排查多轮，全部无效：
    //   · 改 sandboxPolicy.mode → 组合匹配不上任何预设，权限插件拒绝激活
    //   · 改 permissionPresets.defaultPreset → 该 id 不存在（patch 被丢弃）
    //   · 剥 DSH_PROFILE 环境变量 → 与权限无关
    // 真正有效的只有这一个环境变量。想收紧时改这里即可。
    permissionMode: 'danger-full-access',
    // 子命令：headless 表示"执行一个任务、打印结果、退出"
    mode: 'headless',
    // DSH 允许操作的工作目录（安全边界）
    workspace: join(PROJECT_ROOT, 'workspace'),
    // ★ 传给 DSH 子进程的 TEMP/TMP 覆盖（可为 null 表示用系统默认）。
    //
    // 为什么需要：Windows ACL 沙箱在 workspace-write 模式下有一道硬校验 ——
    //   assertTempRootOutsideWorkspace(workspaceRoot, os.tmpdir())
    // 它要求临时根**必须在 workspace 之外**。理由是沙箱要给 workspace 加一条
    // 常驻写入 ACE，再在临时根下开一个私有临时目录；若临时根在 workspace 内，
    // 那个私有子目录会继承 workspace 权限，两个能力就混在一起了。
    //
    // 后果：只要 workspace 覆盖了 %TEMP% 的祖先目录（例如把 workspace 设成
    // %USERPROFILE%，而 TEMP=%USERPROFILE%\AppData\Local\Temp\...），
    // 该 profile 下**所有命令行操作都会在沙箱启动阶段失败**，
    // 报 "Windows ACL temp root must be outside the workspace"。
    //
    // 因此当 workspace 较宽时必须把它指到外面去。设为 null 则交给系统默认。
    //
    // ⚠️ 注意「项目目录本身也可能在 workspace 之内」（例如 workspace 就是
    //    你的用户目录），所以这个值**不能**设在项目里，必须是真正的
    //    workspace 之外路径。配置校验会拦住设错的情况。
    sandboxTempDir: null,
    // 单任务硬超时（毫秒）。本地 27B + 长上下文本来就慢，默认给足 30 分钟。
    timeoutMs: 1_800_000,
    // 空闲超时（毫秒）：连续这么久没有任何事件，就判定卡死并终止。
    // 它比硬超时更实用 —— 真卡死的不必等 30 分钟，而在干活的（一直有事件）不会被误杀。
    // 0 = 关闭空闲判定。
    idleTimeoutMs: 300_000,
    // 是否在任务间保持会话（同一用户的多条指令接续同一个 DSH 会话，保留上下文）
    //
    // ★ 取舍（本机实测）：接续让"它知道我们在说什么"（"看看 D 盘" → "那 C 盘呢"），
    //   代价是上下文越滚越大 —— 每一步都要把整个上下文重传给模型服务，服务端
    //   长上下文的 prefill 也慢。实测 12.6 万 token 时单任务要 117–467 秒。
    //   隧道加了 ssh -C 压缩后上传代价已大幅下降（235KB 载荷 15.1s → 2.3s），
    //   所以现在默认保留接续；想回到"每条指令都是全新上下文"就设成 false。
    persistSession: true,
  },

  // ── 进度播报 ────────────────────────────────────────────────
  //
  // QQ 机器人对主动消息有严格配额，本模块的原则是"宁可少发，不可多发"。
  // ⚠️ 还有一个平台硬限制：针对**同一条**用户消息，QQ 最多接受 4 条被动回复
  //    （SDK 的 ReplyLimiter 默认 limit=4）。进度发太多会把配额吃光，
  //    导致最终结果发不出去。本机因此把 maxPushes 设成 0（只给结果）。
  progress: {
    // 前多少毫秒完全静默：短任务不该被打扰
    silentBeforeMs: 8_000,
    // 两次进度之间的最小间隔（低于 1000 会被强制抬到 1000，防止把号刷到限流）
    minIntervalMs: 15_000,
    // 单任务最多推送几条进度（0 = 完全不发进度，只给最终结果）
    maxPushes: 8,
    // 心跳间隔：长 prefill / 长生成期间 DSH 不发任何事件，
    // 靠心跳报"还在跑、在跑什么"（0 = 关闭）
    heartbeatMs: 10_000,
    // 收到任务时是否回一句"已接受任务，正在执行…"
    ackOnAccept: true,
  },

  // ── 长期记忆库 ──────────────────────────────────────────────
  //
  // 用户教给机器人的事情写进一个 markdown 文件，之后每次任务开始都注入给
  // agent，让它理解用户的偏好与约定。文件可直接手写编辑。
  memory: {
    // 是否启用（false = 不注入，也不响应 /remember）
    enabled: true,
    // 记忆库目录（默认在项目下，便于随仓库一起查看/备份）
    dir: join(PROJECT_ROOT, 'memory'),
    // 主文件名（markdown）
    file: 'MEMORY.md',
    // 每次注入给 agent 的最大字符数（超出只带最新的那部分）
    maxInjectChars: 6_000,
    // 单个记忆文件最大字符数（超过则拒绝追加，避免无限膨胀把每次请求撑大）
    maxFileChars: 200_000,
  },

  // ── 安全 ────────────────────────────────────────────────────
  security: {
    // 允许调用机器人的用户 openid 列表；为空则拒绝所有人（fail-closed）
    allowedOpenIds: [],
    // 未授权用户是否回复提示（false = 静默丢弃，不暴露机器人存在）
    notifyUnauthorized: false,
    // 速率限制
    rateLimit: {
      perUserPerMinute: 6,
      perUserPerHour: 60,
      globalPerMinute: 20,
    },
    // 需要二次确认的操作，确认令牌有效期（毫秒）
    confirmTtlMs: 300_000,
    // 是否启用策略引擎
    policyEnabled: true,
  },

  // ── /run 白名单 ──────────────────────────────────────────────
  //
  // 由**桥接**直接启动的本机程序。存在的理由：DSH 子进程的工具层带文件沙箱，
  // GUI 程序要写 %APPDATA%\<厂商>\... 会被拦（进程秒退，拒绝访问 0x5），
  // 而桥接不在那个沙箱里。
  //
  // 只允许这里列出的路径，避免变成任意命令执行入口。
  launch: {},

  // ── 输出 ────────────────────────────────────────────────────
  output: {
    // 单条 QQ 消息的最大字符数
    maxMessageChars: 1500,
    // 超过此长度则落盘为文件并回复摘要
    fileThresholdChars: 6000,
    // 结果落盘目录（相对 workspace）
    artifactDir: '.dsh-artifacts',
    // 超长输出是否附带文件
    sendFileWhenLarge: true,
  },

  // ── 日志 ────────────────────────────────────────────────────
  logging: {
    dir: join(PROJECT_ROOT, 'logs'),
    // 审计日志保留天数
    retainDays: 30,
    level: 'info',
  },

  // ── QQ ──────────────────────────────────────────────────────
  qq: {
    // 是否响应群聊 @（Phase 1 默认关闭，只支持私聊）
    allowGroup: false,
    // 用户发来的图片落地目录（默认在项目内，便于清理与排查）
    imageDir: join(PROJECT_ROOT, 'inbox'),
    // 单张图片大小上限（字节）
    maxImageBytes: 10 * 1024 * 1024,
    // 单张图片下载超时（毫秒）
    imageDownloadTimeoutMs: 20_000,
  },
};

/** 深合并：后者覆盖前者，仅处理普通对象。 */
export function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;

  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 剥掉注释键（以 `_` 开头）。
 *
 * 配置文件是带中文说明的模板，这些键只给人看，不应进入运行时配置，
 * 也不应出现在 --print-config 输出里。
 */
export function stripCommentKeys(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(stripCommentKeys);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('_')) continue;
    out[k] = stripCommentKeys(v);
  }
  return out;
}

/**
 * 合并配置：默认值 ← 文件 ← 环境变量 → 剥注释键 → 清洗白名单。
 *
 * 抽成纯函数是为了可测：**部分配置绝不能丢掉未提及的默认值**。
 * 例如用户只写 `{"security":{"allowedOpenIds":[...]}}` 时，
 * `security.rateLimit` 必须仍然存在 —— 否则速率限制会静默失效。
 *
 * @returns {{config: object, placeholders: string[]}}
 */
export function mergeConfig(fileConfig, envConfig = {}) {
  let config = deepMerge(DEFAULTS, fileConfig ?? {});
  config = deepMerge(config, envConfig);
  config = stripCommentKeys(config);

  const { real, placeholders } = sanitizeAllowedIds(config.security?.allowedOpenIds);
  config.security.allowedOpenIds = real;
  config.security.placeholderIds = placeholders;

  return { config, placeholders };
}

/** 加载并校验完整配置。
 * @returns {{config: object, credentials: {appId: string, appSecret: string}, sources: object}}
 */
export function loadConfig({ configPath, credsPath } = {}) {
  const cfgFile = configPath ? resolveFromRoot(configPath) : join(PROJECT_ROOT, 'config', 'config.json');
  const credFile = credsPath ? resolveFromRoot(credsPath) : join(PROJECT_ROOT, 'config', 'creds.json');

  // 1) 文件配置（可选）
  const fileConfig = readJson(cfgFile, { label: 'config/config.json' }) ?? {};

  // 2) 环境变量覆盖
  const envConfig = {
    dsh: {
      cliPath: process.env.DSH_CLI_PATH,
      nodeExe: process.env.DSH_NODE_EXE,
      jsEntry: process.env.DSH_JS_ENTRY,
      workspace: process.env.DSH_WORKSPACE,
      sandboxTempDir: process.env.DSH_SANDBOX_TEMP,
      permissionMode: process.env.DSH_PERMISSION_MODE,
      timeoutMs: envInt('DSH_TIMEOUT_MS'),
      persistSession: envBool('DSH_PERSIST_SESSION'),
    },
    security: {
      allowedOpenIds: envList('QQ_ALLOWED_OPENIDS'),
      notifyUnauthorized: envBool('QQ_NOTIFY_UNAUTHORIZED'),
    },
    logging: {
      level: process.env.LOG_LEVEL,
    },
    qq: {
      allowGroup: envBool('QQ_ALLOW_GROUP'),
    },
  };

  // 剔除 undefined，避免覆盖掉有值的下层配置
  const pruneUndefined = (o) => {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const pv = pruneUndefined(v);
      if (pv === undefined) continue;
      if (typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length === 0) continue;
      out[k] = pv;
    }
    return out;
  };

  const { config, placeholders } = mergeConfig(fileConfig, pruneUndefined(envConfig));

  // 3) 凭证
  const fileCreds = readJson(credFile, { label: 'config/creds.json' });
  const appId = process.env.QQ_APP_ID ?? fileCreds?.appId;
  const appSecret = process.env.QQ_APP_SECRET ?? fileCreds?.appSecret;

  const sources = {
    configFile: existsSync(cfgFile) ? cfgFile : null,
    credsFile: existsSync(credFile) ? credFile : null,
    appIdFrom: process.env.QQ_APP_ID ? 'env' : (fileCreds?.appId ? 'file' : null),
    appSecretFrom: process.env.QQ_APP_SECRET ? 'env' : (fileCreds?.appSecret ? 'file' : null),
  };

  // 4) 校验
  const problems = [];

  if (!appId) problems.push('缺少 AppID（设置 QQ_APP_ID 或写 config/creds.json）');
  else if (!/^\d{5,}$/.test(String(appId).trim())) {
    problems.push(`AppID 格式异常: "${mask(appId)}" —— 应为纯数字。注意别填成机器人的 QQ 号。`);
  }

  if (!appSecret) problems.push('缺少 AppSecret（设置 QQ_APP_SECRET 或写 config/creds.json）');

  if (placeholders.length) {
    // 填了占位符但没换成真值 —— 这是很容易犯且后果隐蔽的错误
    console.warn('');
    console.warn('[配置错误] security.allowedOpenIds 里还是占位符，不是真实 openid：');
    for (const p of placeholders) console.warn(`           · ${JSON.stringify(p)}`);
    console.warn('           已忽略这些值。机器人现在会拒绝所有用户。');
    console.warn('           请先运行  bin\\node.cmd src\\probe.js  取得你的 openid。');
    console.warn('');
  }

  if (!config.security.allowedOpenIds.length) {
    // 不算致命错误，但必须显著告警——空白名单会导致机器人对所有人无响应
    console.warn('[配置警告] security.allowedOpenIds 为空 —— 机器人将拒绝所有用户。');
    console.warn('           首次运行请用 src/probe.js 拿到你的 openid 后填入。');
  }

  // 调用方式：优先 nodeExe + jsEntry（避开 cmd.exe，无注入风险）；
  // 二者都不给时才退回 cliPath（此时会经 cmd.exe，存在注入风险）。
  const hasDirect = !!(config.dsh.nodeExe && config.dsh.jsEntry);
  if (hasDirect) {
    if (!isAbsolute(config.dsh.nodeExe)) {
      problems.push(`dsh.nodeExe 必须是绝对路径: ${config.dsh.nodeExe}`);
    }
    if (!isAbsolute(config.dsh.jsEntry)) {
      problems.push(`dsh.jsEntry 必须是绝对路径: ${config.dsh.jsEntry}`);
    }
  } else {
    if (!config.dsh.cliPath) {
      problems.push('必须配置 dsh.nodeExe + dsh.jsEntry，或至少配置 dsh.cliPath');
    } else if (!isAbsolute(config.dsh.cliPath)) {
      problems.push(`dsh.cliPath 必须是绝对路径: ${config.dsh.cliPath}`);
    }
  }

  // 只给了一半也必须报错——否则会在运行时才以难懂的方式失败
  if (!!config.dsh.nodeExe !== !!config.dsh.jsEntry) {
    problems.push('dsh.nodeExe 与 dsh.jsEntry 必须同时配置（只给一个无法启动）');
  }

  // 用了 cliPath 兜底就必须显著告警：那条路径下任务文本里的 shell 元字符会被执行
  if (!hasDirect && config.dsh.cliPath) {
    console.warn('');
    console.warn('[配置警告] 未配置 dsh.nodeExe + dsh.jsEntry —— 将经 cmd.exe 启动 .cmd。');
    console.warn('           该路径下任务文本中的 shell 元字符会被 cmd.exe 解释执行，');
    console.warn('           存在命令注入风险（实测可复现）。强烈建议改用直接调 Node 入口。');
    console.warn('');
  }

  if (problems.length) {
    throw new ConfigError('配置校验未通过:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  }

  // 规范化
  config.dsh.workspace = resolveFromRoot(config.dsh.workspace);
  config.logging.dir = resolveFromRoot(config.logging.dir);

  // ── 沙箱临时目录必须落在 workspace 之外 ──────────────────────────
  //
  // 这是 DSH Windows ACL 沙箱的硬要求（它内部用 os.tmpdir() 做同一个判断）。
  // 不满足时该 profile 下所有命令行操作会在沙箱启动阶段失败，
  // 而报错出现在工具调用层，用户只会看到"命令行用不了"这种模糊现象。
  // 因此在启动期就把它变成一条明确的配置错误 / 告警。
  if (config.dsh.sandboxTempDir) {
    config.dsh.sandboxTempDir = resolveFromRoot(config.dsh.sandboxTempDir);
  }
  const tempCheck = checkSandboxTemp(config.dsh.workspace, config.dsh.sandboxTempDir);
  if (tempCheck?.severity === 'error') {
    problems.push(tempCheck.message);
  } else if (tempCheck?.severity === 'warning') {
    console.warn('');
    for (const line of tempCheck.message.split('\n')) console.warn(`[配置警告] ${line}`);
    console.warn('');
  }

  return {
    config,
    credentials: { appId: String(appId).trim(), appSecret: String(appSecret).trim() },
    sources,
  };
}

/** 供 --print-config 使用：打印脱敏后的最终配置。 */
export function describeConfig({ config, credentials, sources }) {
  const lines = [];
  lines.push('生效配置（敏感值已脱敏）');
  lines.push('='.repeat(60));
  lines.push(`配置文件   : ${sources.configFile ?? '(无，使用内置默认值)'}`);
  lines.push(`凭证文件   : ${sources.credsFile ?? '(无)'}`);
  lines.push(`AppID 来源 : ${sources.appIdFrom ?? '(未提供)'}`);
  lines.push(`密钥来源   : ${sources.appSecretFrom ?? '(未提供)'}`);
  lines.push(`AppID      : ${mask(credentials.appId)}`);
  lines.push(`AppSecret  : ${mask(credentials.appSecret)}`);
  lines.push('-'.repeat(60));
  lines.push(JSON.stringify(redact(config), null, 2));
  return lines.join('\n');
}
