/**
 * DSH 任务执行器
 *
 * 通过子进程调用 `dsh --profile headless --json "<task>"`，
 * 解析事件流并返回结构化结果。
 *
 * 为什么用子进程而不是常驻实例：
 *   - 隔离性最好：单任务崩溃/挂死不会拖垮桥接服务
 *   - 语义正好匹配：headless 就是"执行一个任务、打印结果、退出"
 *   - 代价是每个任务有启动开销，Phase 1 可接受
 *
 * ⚠️ Windows 进程树清理：
 *   child.kill() 在 Windows 上只终止直接子进程，DSH 派生的孙进程
 *   （模型请求、工具子进程等）会残留成僵尸。必须用 taskkill /T /F
 *   杀掉整棵树。这是本项目在 Windows 上最容易漏掉的正确性问题。
 */

import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { NdjsonParser, RunAccumulator } from './events.js';
import { formatImageBlock } from '../qq/inbound-images.js';

/** 单次运行的最大 stdout/stderr 缓冲（防止内存被超长输出撑爆）。 */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

/**
 * 附加给 agent 的运行说明。
 *
 * 为什么用"随任务文本一起送达"这种形式：`dsh --profile headless` 的 CLI 只暴露
 * `--json` / `--session-id` / `-h`，没有 `--system-prompt` 之类的入口。
 * 局限是它属于**用户消息**而非系统提示，权威性低于真正的系统指令；
 * 因此这只是"请它配合"，桥接侧仍保留从输出里兜底解析路径的能力。
 *
 * 要解决的真实问题：用户说「把某文件发给我」时，agent 只有文件读写工具、
 * 没有投递通道，于是改把文件内容全部提取成文字贴出来（实测一页 PDF 花了
 * 43 步 / 247 秒），而桥接因为结果不够长就按文本发了 —— 用户要文件却收到一堆文字。
 * 现在告知它：桥接有投递能力，它只需报出路径。
 */
export const RUNTIME_NOTE = [
  '【运行环境说明】',
  '你通过 QQ 机器人桥接运行，用户是在手机 QQ 上和你对话。',
  '你没有发送文件或邮件的工具；但桥接层具备投递能力。',
  '如果用户想让你把某个文件发给他，请不要把文件内容提取成文字贴出来，',
  '而是单独输出一行：',
  'SEND_FILE: <该文件的绝对路径>',
  '桥接层读到这一行后会把文件直接发给他。',
  '若还想补充说明，写在这一行之外即可。',
].join('\n');

/**
 * 告诉 agent「长期记忆」是什么、放在哪、怎么追加。
 *
 * 为什么需要：用户很少会说"请用 /remember"，他更可能直接说
 * 「记住：我的项目都在 D:\work」。这句话必须让 agent 也知道怎么办 ——
 * 否则它只会回一句"好的记住了"，而下一轮它又忘了（每次都是新进程）。
 *
 * @param {string} memoryPath 记忆库文件的绝对路径
 * @returns {string}
 */
export function memoryInstruction(memoryPath) {
  return [
    '【长期记忆怎么用】',
    `你的长期记忆库是一个 markdown 文件：${memoryPath}`,
    '用户让你记住某事时（"记住…"、"以后都…"、"别再…"），请真正把它写进去：',
    '先用 read 读该文件，再用 edit 把新条目追加到文件末尾，格式为',
    '  ## YYYY-MM-DD HH:mm',
    '  （空行）',
    '  内容',
    '已经记过的内容不要重复追加；只记长期有效的偏好/约定/事实，一次性的事务不要记。',
  ].join('\n');
}

/**
 * 把运行说明附加到任务文本。
 *
 * 说明放在**任务之前**并显式分隔，避免与用户原话混在一起被误读成任务内容。
 *
 * @param {string} task
 * @param {{withNote?: boolean, memoryText?: string, memoryPath?: string}} [opts]
 */
export function composeTaskText(task, { withNote = true, memoryText = '', memoryPath = '', imagePaths = [] } = {}) {
  const body = String(task ?? '');
  const blocks = [];
  if (withNote) blocks.push(RUNTIME_NOTE);
  if (memoryPath) blocks.push(memoryInstruction(String(memoryPath)));
  if (memoryText) blocks.push(String(memoryText));
  const images = formatImageBlock(imagePaths);
  if (images) blocks.push(images);
  if (!blocks.length) return body;
  blocks.push(`【用户请求】\n${body}`);
  return blocks.join('\n\n');
}

let runCounter = 0;
function nextTaskId() {
  runCounter += 1;
  return `t${Date.now().toString(36)}-${runCounter}`;
}

/**
 * 终止整个进程树。
 *
 * 在 Windows 上用 `taskkill /PID <pid> /T /F`；/T 表示包含子树，
 * /F 表示强制。其它平台退回 SIGKILL。
 * taskkill 失败时不抛异常——尽力而为，避免取消路径本身把服务搞挂。
 */
export function killTree(pid, logger) {
  if (!pid) return Promise.resolve({ ok: false, reason: 'no pid' });

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err, stdout, stderr) => {
        if (err) {
          logger?.warn?.(`taskkill 失败 pid=${pid}: ${err.message} ${String(stderr).trim()}`);
          resolve({ ok: false, reason: err.message });
        } else {
          resolve({ ok: true, out: String(stdout).trim() });
        }
      });
    });
  }

  try {
    process.kill(pid, 'SIGKILL');
    return Promise.resolve({ ok: true });
  } catch (e) {
    return Promise.resolve({ ok: false, reason: e.message });
  }
}

/**
 * 判断路径是否是需要经 cmd.exe 启动的批处理文件。
 *
 * 为什么必须处理：Node.js 自 20.x 起为修复 CVE-2024-27980，
 * 禁止直接 spawn `.cmd` / `.bat` 文件，会抛 `spawn EINVAL`。
 * `dsh.cmd` 正是 .cmd。
 */
function isBatchFile(p) {
  return /\.(cmd|bat)$/i.test(String(p ?? ''));
}

/**
 * 计算 spawn 的 (file, args)。
 *
 * ── ⚠️ 命令注入警告（真实踩到的安全问题）──────────────────────
 *
 * 曾经的写法是 `cmd.exe /d /s /c <cliPath> <args...>`，并想当然地认为
 * "参数仍是数组、不经 shell 拼接，所以不存在注入路径"。**这个判断是错的。**
 *
 * Windows 的 CreateProcess 只接受一条命令行字符串，Node 会把 argv 数组
 * 拼成字符串；cmd.exe 随后**重新解析**该字符串，于是任务文本里的
 * `&`、`|`、`>`、`"`、`%VAR%` 全部被当作 cmd 语法执行。
 * 实测证据（由 tests/integration.test.js 发现）：
 *   - 载荷 `x&echo.>PWNED_AMP.txt`   → 真的生成了 PWNED_AMP.txt
 *   - 载荷 `explain %PATH% semantics` → argv 里 %PATH% 被展开成真实环境变量
 *
 * ── 正确解法：根本不用 cmd.exe ────────────────────────────────
 *
 * `dsh.cmd` 只是一个包装器，内部等价于：
 *     ELECTRON_RUN_AS_NODE=1 "<nodeExe>" --expose-internals "<jsEntry>" <args...>
 * 直接按这个方式调用，就同时解决两个问题：
 *   1. 绕开 Node 对 .cmd 的 EINVAL 限制
 *   2. **完全不经 cmd.exe**，任务文本永远只是 argv 元素，不参与任何解析
 *
 * 因此调用方应优先配置 `nodeExe` + `jsEntry`；
 * `cmd.exe` 分支仅作为无法解析包装器时的兜底，并在日志中告警。
 */
export function resolveSpawn(cliPath, args, opts = {}) {
  // opts 可能显式传 null（例如调用方统一写 resolveSpawn(cli, args, maybeOpts)），
  // 直接解构会抛 "Cannot destructure property ... of null"。
  const { nodeExe, jsEntry } = opts ?? {};
  // 首选：直接调用 Node 入口，不经任何 shell
  if (nodeExe && jsEntry) {
    return {
      file: nodeExe,
      args: ['--expose-internals', jsEntry, ...args],
      viaCmd: false,
      safe: true,
      note: 'direct-node',
    };
  }

  if (process.platform === 'win32' && isBatchFile(cliPath)) {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', cliPath, ...args],
      viaCmd: true,
      // 明确标记为不安全：调用方应据 this 告警
      safe: false,
      note: 'cmd-fallback',
    };
  }

  return { file: cliPath, args, viaCmd: false, safe: true, note: 'direct' };
}

/**
 * 构建传给 DSH 子进程的环境变量。
 *
 * 有三件事必须在这里处理，每一件都对应一个真实踩到的坑：
 *
 * 1. **剥掉 desktop profile 变量**（最难发现的一个）
 *    若桥接服务从 DSH 会话环境里启动，会继承桌面版设的 `DSH_PROFILE=desktop`、
 *    `DSH_PROFILE_DIR=…\profiles\desktop`、`DSH_SESSION_ID=…`。
 *    子进程继承后，**尽管命令行传了 `--profile headless`，DSH 仍解析到 desktop
 *    profile** —— 写在 headless profile 里的权限预设、模型 provider 全部被静默忽略。
 *    现象只是"改了配置毫无效果"，没有任何报错指向 profile。排查了三轮才定位。
 *    `DSH_HOME` 必须保留（模型凭证在里面）。
 *
 * 2. **临时目录覆盖**：DSH 的 Windows ACL 沙箱要求临时根在 workspace 之外
 *    （它内部用 os.tmpdir()，而 os.tmpdir() 遵循 TEMP/TMP）。
 *
 * 3. **ELECTRON_RUN_AS_NODE**：DSH 自带的"node"其实是 Electron 可执行文件。
 *
 * @param {object} base 基础环境（通常是 process.env）
 * @param {object} [overrides] 调用方额外注入的变量
 * @param {{directNode: boolean, sandboxTempDir?: string|null, permissionMode?: string|null}} opts
 * @returns {object}
 */
export function buildChildEnv(base, overrides = {}, {
  directNode = false,
  sandboxTempDir = null,
  permissionMode = null,
} = {}) {
  const childEnv = { ...(base ?? {}), ...(overrides ?? {}) };

  // 1) 剥掉会覆盖 --profile 的桌面版变量
  for (const k of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID']) {
    delete childEnv[k];
  }

  // 3) Electron 以 Node 模式运行
  if (directNode) childEnv.ELECTRON_RUN_AS_NODE = '1';

  // 4) 权限模式（DSH 的官方开关）
  //
  // 真实教训：我先后试过改 sandboxPolicy.mode、改 permissionPresets 的
  // defaultPreset，全部无效 —— 因为 **DSH 的权限模式是环境变量驱动的**，
  // 由 `--dump-config` 可以清楚看到：
  //     - id: sandbox-policy
  //       config:
  //         mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
  //     - id: approval
  //       config:
  //         policy: !!js (… DSH_PERMISSION_MODE …) === 'danger-full-access'
  //                        ? 'never' : 'ask'
  // 两者从同一个变量派生（这就是"预设配对"的实现方式），
  // 所以只要设这一个变量，沙箱与审批会一起切换，preset 自然匹配。
  //
  // 取值：read-only | workspace-write | danger-full-access
  if (permissionMode) childEnv.DSH_PERMISSION_MODE = permissionMode;

  // 2) 临时目录（失败则回退系统默认，由调用方决定是否告警）
  if (sandboxTempDir) {
    childEnv.TEMP = sandboxTempDir;
    childEnv.TMP = sandboxTempDir;
  }

  return childEnv;
}

/**
 * 运行一个 DSH 任务。
 *
 * @param {string} task 任务文本
 * @param {object} opts
 * @param {string} opts.cliPath     dsh 入口绝对路径
 * @param {string} [opts.nodeExe]   Node 可执行文件（与 jsEntry 一起优先使用，避开 cmd.exe）
 * @param {string} [opts.jsEntry]   dsh 的 JS 入口
 * @param {string} opts.workspace   工作目录（安全边界）
 * @param {number} opts.timeoutMs   超时
 * @param {string} [opts.sessionId] 续接已有会话
 * @param {object} [opts.env]       额外环境变量
 * @param {object} [opts.logger]
 * @param {(ev: object) => void} [opts.onEvent] 事件回调（可用于进度上报）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} 见 RunAccumulator.result()
 */
export function runDshTask(task, opts) {
  const {
    cliPath,
    workspace,
    timeoutMs = 1_800_000,
    idleTimeoutMs = 0,
    sessionId,
    nodeExe,
    jsEntry,
    sandboxTempDir,
    permissionMode,
    env = {},
    logger,
    onEvent,
    signal,
  } = opts;

  const taskId = nextTaskId();
  const startedAt = Date.now();

  // 优先直接调 Node 入口（不经 cmd.exe）—— 见 resolveSpawn 的注入警告
  const args = ['--profile', 'headless', '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push(composeTaskText(task, {
    withNote: opts.runtimeNote !== false,
    memoryText: opts.memoryText,
    memoryPath: opts.memoryPath,
    imagePaths: opts.imagePaths,
  }));

  const spawnSpec = resolveSpawn(cliPath, args, { nodeExe, jsEntry });

  // 环境变量构建：见 buildChildEnv 的注释
  // （剥离 profile 覆盖 / 临时目录 / 权限模式 / ELECTRON_RUN_AS_NODE）
  let childEnv = buildChildEnv(process.env, env, {
    directNode: spawnSpec.note === 'direct-node',
    sandboxTempDir,
    permissionMode,
  });

  if (sandboxTempDir) {
    try {
      mkdirSync(sandboxTempDir, { recursive: true });
    } catch (e) {
      logger?.warn?.(`沙箱临时目录创建失败（将回退系统默认）: ${sandboxTempDir} — ${e.message}`);
      childEnv = buildChildEnv(process.env, env, {
        directNode: spawnSpec.note === 'direct-node',
        sandboxTempDir: null,
        permissionMode,
      });
    }
  }

  logger?.info?.(
    `启动 DSH 任务 ${taskId}: ${JSON.stringify(task.slice(0, 100))}` +
    ` (启动方式=${spawnSpec.note})`
  );

  if (!spawnSpec.safe) {
    // 无法解析包装器而退回 cmd.exe —— 此时任务文本里的 shell 元字符会被执行。
    // 这是已知的降级风险，必须让人看见，而不是悄悄接受。
    logger?.warn?.(
      '⚠️ 未能直接调用 Node 入口，已降级为经 cmd.exe 启动 .cmd。' +
      '此路径下任务文本中的 shell 元字符（& | > " %VAR%）可能被解释执行，存在命令注入风险。' +
      '建议配置 dsh.nodeExe / dsh.jsEntry 以避开 cmd.exe。'
    );
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spawnSpec.file, spawnSpec.args, {
        cwd: workspace,
        // shell:false 不够 —— Windows 上 cmd.exe 仍会重新解析命令行字符串。
        // 真正的防线是走 direct-node 分支，压根不经过 cmd.exe。
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      });
    } catch (e) {
      const hint = e.code === 'EINVAL' && isBatchFile(cliPath)
        ? '（.cmd 需经 cmd.exe；更推荐配置 dsh.nodeExe / dsh.jsEntry 直接调 Node 入口）'
        : '';
      resolve({
        ok: false,
        taskId,
        errorMessage: `无法启动 dsh 进程: ${e.code ?? ''} ${e.message}${hint}`,
        exitCode: null,
        timedOut: false,
        killed: false,
        text: '',
        stderr: '',
        // 若这里缺 eventCount，调用方用 `?? 0` 兜底会把"启动失败"误判成
        // "陈旧会话"（其特征是 用了 sessionId + 失败 + 零事件）。
        eventCount: 0,
      });
      return;
    }

    const parser = new NdjsonParser();
    const acc = new RunAccumulator();
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let settled = false;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);

      // 冲刷残留事件
      for (const ev of parser.flush()) {
        acc.apply(ev);
        try { onEvent?.(ev); } catch { /* 回调异常不影响结果 */ }
      }

      const result = acc.result({ exitCode, stderr, timedOut, killed });
      result.taskId = taskId;
      result.durationMs = Date.now() - startedAt;
      // 'total' = 撞到硬上限；'idle' = 长时间没有任何事件（卡死）
      if (timeoutKind) result.timeoutKind = timeoutKind;
      logger?.info?.(
        `任务 ${taskId} 结束 ok=${result.ok} exit=${exitCode} ` +
        `耗时=${result.durationMs}ms 事件=${result.eventCount}`
      );
      resolve(result);
    };

    // ── 超时
    //
    // 两道闸门：
    //   1) 硬上限 timeoutMs —— 兜底，防止任务永远占着进程。
    //   2) 空闲超时 idleTimeoutMs —— 连续这么久**没有任何事件**才杀。
    // 为什么必须有第二道：实测有任务正好卡在 10 分钟硬上限被杀，而它其实还在
    // 正常干活（本地 27B + 长上下文就是慢）；反过来真卡死的任务也不该白等 30 分钟。
    // 判据用"有没有事件"最贴近"是不是还在动"。
    let timeoutKind = null;
    let idleTimer = null;
    const armIdle = () => {
      if (!(idleTimeoutMs > 0)) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        if (settled) return;
        timedOut = true;
        timeoutKind = 'idle';
        logger?.warn?.(`任务 ${taskId} 空闲超时（${idleTimeoutMs}ms 无任何事件），正在终止进程树`);
        await killTree(child.pid, logger);
        setTimeout(() => finish(null), 2000);
      }, idleTimeoutMs);
    };

    const timer = setTimeout(async () => {
      timedOut = true;
      timeoutKind = 'total';
      logger?.warn?.(`任务 ${taskId} 超时 (${timeoutMs}ms)，正在终止进程树`);
      await killTree(child.pid, logger);
      // 给 close 事件一点时间；若不来则兜底结算
      setTimeout(() => finish(null), 2000);
    }, timeoutMs);
    armIdle();

    // ── 外部取消
    let onAbort = null;
    if (signal) {
      onAbort = async () => {
        killed = true;
        logger?.warn?.(`任务 ${taskId} 被取消，正在终止进程树`);
        await killTree(child.pid, logger);
        setTimeout(() => finish(null), 2000);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // ── stdout：事件流
    child.stdout.on('data', (chunk) => {
      // 有输出就说明还在动：把空闲超时重新计时
      armIdle();
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STREAM_BYTES) {
        if (!killed) {
          killed = true;
          logger?.warn?.(`任务 ${taskId} stdout 超过 ${MAX_STREAM_BYTES} 字节，强制终止`);
          killTree(child.pid, logger).then(() => finish(null));
        }
        return;
      }
      for (const ev of parser.push(chunk)) {
        acc.apply(ev);
        try { onEvent?.(ev); } catch { /* ignore */ }
      }
    });

    // ── stderr：诊断信息，保留尾部
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    child.on('error', (e) => {
      logger?.error?.(`任务 ${taskId} 进程错误: ${e.message}`);
      stderr += `\n[spawn error] ${e.message}`;
      finish(null);
    });

    child.on('close', (code) => finish(code));
  });
}
