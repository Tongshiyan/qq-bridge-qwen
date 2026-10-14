# DSH-QQ 桥接服务

用手机 QQ 给机器人发消息，让家里的电脑（通过 DeepSeek Harness）替你干活。

```
手机QQ ──▶ QQ开放平台 ──▶ WebSocket ──▶ 桥接服务(PC) ──▶ dsh headless ──▶ 工作区
   ▲                                          │
   └──────────── 结果分段回送 ◀────────────────┘
```

---

## ⚠️ 先读这一节：四条硬约束

### 0. 当前权限范围：⚠️ 全盘（danger-full-access）

**本机当前状态：DSH 沙箱模式被显式设为 `danger-full-access`（无边界）。**

配置位置（DSH 的 headless profile，**不在本项目里**）：

```
%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml

- id: sandbox-policy
  name: "@deepseek-ai/dsh-sandbox-policy"
  config:
    mode: danger-full-access
    workspaceRoot: "C:\\Users\\<your-username>\\Desktop"
```

**为什么设成这个**：默认模式 `workspace-write` 只能写工作区，而"操作电脑上的
GUI 程序"（微信 / QQ 客户端等）必然要写 `%APPDATA%\...` —— 落在工作区之外，
直接被拒。实测微信启动就是这样失败的：

```
ERROR CreateFile ...\Tencent\xwechat\crashinfo\settings.dat: 拒绝访问 (0x5)
ERROR crashpad_client_win.cc(148) crash server failed to launch, self-terminating
```

**代价（务必清楚）**：

| 项 | 说明 |
| --- | --- |
| 全盘可写 | 包含 `~\.dsh` 的账号凭证、系统目录 |
| 策略引擎仍在但只是**建议性拦截** | 写操作要你手机确认 —— 但挡不住 agent 通过自己启动的子进程做任何事 |
| **安全边界 = 你的 QQ 账号** | 手机 QQ 或机器人被盗 = 这台电脑被完全控制 |

> 🔴 **强烈建议**：把这个机器人换到一个**专用 QQ 号**上，别用主力号。
> 这样风险被限制在机器人本身，而不是你整个 QQ 身份 + 整台电脑。

**想收回去**：把上面那段 patch 删掉，或把 `mode` 改成 `workspace-write`。
启动自检会显示当前模式，改完重启即可确认。

---

#### 附：`workspace-write` 模式下的边界为什么是桌面

（以下内容适用于把模式收回 `workspace-write` 的情形）

本机 `config/config.json` 把 `dsh.workspace` 设为 **`%USERPROFILE%\Desktop`**。

**为什么不是整个用户目录** —— 这是被环境约束逼出来的结论：

DSH 的 Windows ACL 沙箱在 `workspace-write` 模式下要求临时根**必须在 workspace 之外**
（源码：`assertTempRootOutsideWorkspace(workspaceRoot, os.tmpdir())`）。理由是沙箱要给
workspace 加一条常驻写入 ACE，再在临时根下开私有临时目录；临时根若在 workspace 内，
那个私有子目录会继承 workspace 权限，两个能力就混在一起。

实测的完整推理链：

```
workspace = %USERPROFILE%
  → 包住了 %TEMP% = %USERPROFILE%\AppData\Local\Temp\...
  → 所有命令行操作在沙箱启动阶段失败：
      "Windows ACL temp root must be outside the workspace"
  → 项目目录本身也在用户目录内，无法用项目内路径当临时目录
  → 用户目录之外的根目录（C:\、C:\Windows\Temp、C:\Users\Public）
    默认都需要管理员权限
  ⇒ 结论：宽 workspace 与可用的 ACL 沙箱【互斥】
```

`%USERPROFILE%\Desktop` 恰好同时满足所有条件：

| 条件 | 结果 |
| --- | --- |
| `%TEMP%` 在 workspace 之外 | ✅ 沙箱可用，命令行正常 |
| 你实际要处理的文件（桌面上的简历等） | ✅ 在范围内 |
| `~\.dsh` 凭证目录 | ✅ **自然不在圈内**（比"排除"更干净） |

> 📌 **想扩大范围**：选一个**不包含 `%TEMP%`** 的根，例如 `D:\` 下的某个目录。
> **切勿再指回 `%USERPROFILE%`** —— 那会让命令行工具整体失效。
> 配置层已加入校验：把 `sandboxTempDir` 设在 workspace 内会直接报配置错误；
> 未设置而系统 `%TEMP%` 落在 workspace 内会打印醒目告警。

### 1. 必须在 DSH 沙箱之外运行

本项目实测确认：**在 DSH 会话的沙箱内，`spawn` 子进程完全不可用**，同步异步都返回 `EPERM`。
桥接服务的核心动作就是 spawn `dsh` 子进程，因此它**不能**从 DSH 会话里启动。

复现验证：

```cmd
cd D:\dsh-workspace\qq-bridge
bin\node.cmd tests\sandbox-probe.js
```

→ 正常环境（普通 cmd 窗口双击/命令行启动）应当看到 `✅ 子进程 + 管道捕获可用`。

> **⚠️ 2026-10-14 真实事故（这次踩得更深，务必看）**
>
> 曾在某个 DSH 会话里直接 `Start-Process` 拉起桥接。沙箱令牌会被子进程**继承且无法摆脱**，
> 于是桥接虽然能起来、能连上 QQ，但它 spawn 的 `dsh --profile headless` 在启动阶段
> 写 profile 时被"禁止向上写"拦下：
>
> ```
> Error: EPERM: operation not permitted, open
>   'C:\Users\<你>\.dsh\profiles\headless\cordis.yml'
>     at writeFileSync → prepareProfile → composeProfile → runProfile → runCli
> ```
>
> 结果是**每条手机指令都在 ~0.1 秒内失败**、无任何事件，手机收到的是一整屏 Node 崩溃堆栈。
> 机制：工作区被 DSH 显式授权所以可写，工作区之外（`%USERPROFILE%\.dsh\…`）不行。
>
> 现在三道防线：
> 1. `scripts/start-all.ps1` 启动前会真写一个探针文件，写不进去就**直接拒绝启动**（退出码 7）；
> 2. 桥接启动自检会把它打印成醒目告警，并写进审计日志（`where: launch-context`）；
> 3. 真遇到这种失败时，回给手机的不再是堆栈，而是「桥接自身没有写权限 + 怎么修」。
>
> 修法始终是同一条：**关掉它，从普通窗口启动** —— `scripts\start-all.cmd`（或「Qwen控制台」）。

### 2. 这是一个"远程控制电脑"的工具，安全默认值很严格

- 白名单为空时，机器人**拒绝所有人**（fail-closed）
- 未授权用户的消息**静默丢弃**，不回复、不暴露机器人存在
- 变更类指令需要回复令牌二次确认
- 破坏性指令永久拒绝
- 全量审计日志落盘

### 3. 第一次运行前必须拿到你的 openid

QQ 使用 OpenID 体系，且**同一个用户在不同机器人下的 openid 不同**。
必须用 `src/probe.js` 取得你自己在这个机器人下的 openid，填进白名单，否则你不会收到任何回复。

---

## 快速开始

### 步骤 1：确认凭证

`config/creds.json`：

```json
{
  "appId": "你的数字AppID",
  "appSecret": "你的AppSecret"
}
```

> ⚠️ 不要用 PowerShell 的 `Set-Content -Encoding UTF8` 写这个文件 —— PowerShell 5.1 会写入
> UTF-8 BOM，导致 `JSON.parse` 失败。用记事本另存为 UTF-8（无 BOM）。
> 本项目所有读取路径都已做剥 BOM 兜底，但源文件干净更省事。

### 步骤 2：取得你的 openid

```cmd
bin\node.cmd src\probe.js
```

连接成功后，**用手机 QQ 给机器人发一条任意消息**（比如 `hi`）。
终端会打印你的 openid，类似：

```
  ── 你的白名单 openid 是 ──
  A1B2C3D4E5F6...
```

> probe 会消耗 1 次网关连接配额（每 24 小时上限 1000 次），跑完 Ctrl+C 退出。

### 步骤 3：填白名单

创建 `config/config.json`：

```json
{
  "security": {
    "allowedOpenIds": ["把上一步的 openid 填这里"]
  }
}
```

> 也可以改用环境变量（优先级更高，且不进磁盘）：
> ```cmd
> set QQ_ALLOWED_OPENIDS=你的openid
> ```

### 步骤 4：确认 DSH 有模型 API Key

桥接只是转发，真正干活的是 DSH。DSH 需要模型凭证，否则每个任务都会报
`MISSING_CREDENTIAL: no API key for provider`。

修法（任选一）：
- 打开 DSH 的 Web 界面 → Models 页面 → 填入 DeepSeek API Key
- 或在启动桥接的环境里设置 `DEEPSEEK_API_KEY`

> 本项目会把这个错误翻译成明确的中文提示，不会让你猜。

### 步骤 5：启动

```cmd
cd D:\dsh-workspace\qq-bridge
bin\node.cmd src\main.js
```

看到自检报告和 `✅ 已连接 QQ 开放平台` 后，用手机发指令测试。

---

## 使用

### 自然语言指令

```
帮我看看 D 盘剩余空间
分析一下 logs 目录里的错误
统计这个项目有多少行代码
```

### 本地指令（不经过 DSH）

| 指令 | 作用 |
| --- | --- |
| `/status` | 服务状态、用量、当前任务、会话 |
| `/new` | 开启新会话（清空上下文） |
| `/remember 内容`（或 `/记住`） | 让机器人**长期记住**：追加一条到记忆库 md，之后每次任务都会带上 |
| `/memory`（或 `/记忆`） | 查看长期记忆库（条数、大小、文件路径、内容） |
| `/cancel` | 取消正在执行的任务 |
| `/help` | 帮助 |

### 二次确认（按钮审批）

发一条变更类指令，会收到一条**带按钮**的提示：

```
⚠️ 该指令会修改文件或系统，需要你确认。

指令：删除所有日志文件
· 命中删除动词

点下面的按钮，或回复：
确认 7K2M9P
（5 分钟内有效，仅你自己可确认）

        [ ✅ 允许 ]  [ ❌ 拒绝 ]
```

**点按钮即可**，不用手动输令牌。

按钮不可用时（例如机器人没有相应权限），会自动回退为纯文本，回复 `确认 7K2M9P` 同样有效。

令牌特性：
- 一次性（用过即废，防重放）
- 按用户隔离（别人的令牌无法确认，**别人的按钮也点不动**）
- 5 分钟过期
- 大小写不敏感、忽略首尾空格（手输友好）
- 令牌字母表刻意排除易混字符 `0 O 1 I`，手输不易错

> ⚠️ **安全限制**：按钮回传数据来自 QQ 客户端，属**不可信输入**。
> 实现里严格校验格式，任何无法明确解析的值一律拒绝；
> 且取不到用户标识时（无法校验归属）同样拒绝。

### 进度推送

长任务执行期间会定期回报进度，避免"发完不知道在干嘛"：

```
🔄 仍在执行（第 2 轮，第 3 步，已用时 1 分 20 秒）…
```

节流策略（QQ 有严格消息配额，刷屏会被限流甚至封禁）：

| 约束 | 默认值 | 说明 |
| --- | --- | --- |
| 静默期 | 12 秒 | 短于此不发任何进度（**绝大多数任务因此零进度消息**） |
| 最小间隔 | 20 秒 | 两条进度之间的最小间隔 |
| 每任务上限 | 6 条 | 硬上限，无论任务多长 |

超时/被取消时会补一条收尾说明；正常结束**不补**（正式结果紧接着发送，多说即重复）。

### 结果文件直发

有**两条**触发路径：

**① 你明确要文件时（优先）** —— 例如「把桌面的简历发给我」

桥接识别这个意图，然后从 agent 输出里找出**真实存在**的文件路径，直接发到 QQ。
同时在任务文本前置一段运行说明，告诉 agent：「你没有投递通道，但桥接有；
要发文件就单独输出一行 `SEND_FILE: <绝对路径>`」—— 避免它误以为只能把文件内容
提取成文字贴出来（实测一页 PDF 这样要花 43 步 / 247 秒）。

> ⚠️ 这段说明是**随任务文本**送达的（`dsh headless` 的 CLI 没有 `--system-prompt` 入口），
> 因此属于用户消息而非系统提示，权威性较低。桥接侧保留了兜底解析：
> 即使 agent 没输出标记，也会从结果里找形如 `C:\...\x.pdf` 的**真实存在**的路径。

**② 结果超过 `fileThresholdChars`（默认 6000 字）时**

落盘到 `artifacts/`，再尝试 `sendFile` 直发。

**两条路径的失败降级一致**：发送失败（例如机器人没有文件消息权限，或超过平台
100MB 上限）会自动降级为「说明原因 + 完整路径 + 摘要」，**结果不会丢**。

经验上个人机器人常常没有文件消息权限，所以降级路径是常态而非例外 —— 它被当成一等公民设计和测试。

### 后台常驻

**本机当前用的是「启动文件夹」方案（不需要管理员权限）**，见下一小节；
下面这套计划任务方案仍然可用，胜在支持崩溃自拉起。

见 [`scripts/README.md`](scripts/README.md)。装成 Windows 计划任务后开机自启、崩溃自拉起：

```cmd
scripts\install-task.cmd -Action show       # 干跑，只打印将注册的命令行
scripts\install-task.cmd -Action status     # 查看状态
scripts\install-task.cmd -Action install    # 安装（需要管理员权限）
scripts\install-task.cmd -Action uninstall  # 卸载
```

> ⚠️ **注册需要管理员权限**：非提权会话下 Task Scheduler 的 WMI provider 连**读取**都会拒绝。
> `status` / `start` / `stop` 走 `schtasks.exe`，不需要提权。

### 开机自启 + 无窗口后台运行（启动文件夹，无需管理员）

**隧道与桥接都是无窗口后台进程**，不会在任务栏 / 资源管理器里留下窗口：

| 组件 | 启动方式 | 为什么没有窗口 |
| --- | --- | --- |
| SSH 隧道 | `Start-Process powershell -WindowStyle Hidden -File tunnel.ps1` | `-WindowStyle Hidden` 让控制台在创建时就是隐藏的（不是先显示再隐藏） |
| QQ 桥接 | `Start-Process "<DSH>\DeepSeek Harness.exe" src\main.js`（`ELECTRON_RUN_AS_NODE=1`） | Electron 是 **GUI 子系统**程序，以 Node 模式运行时压根不分配控制台；旧写法 `cmd /k bin\node.cmd` 才会留下一个 cmd 窗口 |

`scripts/start-all.ps1` 是唯一的**幂等**启动器：谁没在跑就起谁，已在跑的全部跳过；
并且会先等网络就绪（登录时它可能抢在 Wi-Fi / aTrust VPN 之前跑完，而桥接连不上网关会直接退出）。
`scripts/start-all.cmd` 只是手动入口（在终端里跑，方便直接看输出）。

```cmd
scripts\start-all.cmd            # 启动缺的那些
scripts\start-all.cmd status     # 只看状态，不做改动
```

自启入口（2026-10-12 装好）：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH-QQ-Robot.vbs
    └── wscript 隐藏执行 "<项目>\qq-bridge\scripts\start-all.ps1"
```

- 用 `.vbs` 而不是 `.cmd`：wscript.exe 是 GUI 子系统程序，**开机时不闪任何窗口**；`.cmd` 会闪一个控制台。
- **关闭自启**：删掉 `DSH-QQ-Robot.vbs` 即可。
- 计划任务方案（`scripts/install-task.ps1`）功能更强（崩溃自拉起），但**注册需要管理员权限** ——
  实测未提权时 `schtasks /create /sc onlogon` 直接返回 `Access is denied`。
- 日志：`logs\autostart.log`（启动器）、`logs\tunnel-stdout/stderr.log`、`logs\bridge-stdout/stderr.log`。

> ⚠️ `start-all.ps1` / `start-all.cmd` / `DSH-QQ-Robot.vbs` 必须保持**纯 ASCII**：
> PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI/GBK 读、cmd.exe 用 OEM 代码页，中文注释会导致解析失败
> （`tunnel.ps1` 上已踩过一次）。
>
> ⚠️ 检测进程时**不能**简单按命令行含 `tunnel.ps1` / `main.js` 匹配：检测用的那个 PowerShell 自己的
> 命令行里就含这段文本，会永远报"已在运行"，自启就静默失效。当前实现改为
> 「`ssh.exe -L 8000`，或 `-File` 拉起的 keeper（排除 `-Command` 进程）」+「读 `state/bridge.lock` 的 pid」。
>
> ⚠️ 桥接以后台方式运行时**没有控制台输出**，排障请看 `logs\bridge-stderr.log` 与 `logs\audit-*.jsonl`。

### 只能跑一个实例

服务启动时会获取一个锁文件（`state/bridge.lock`）。**第二个实例会被拒绝启动**：

```
拒绝启动：检测到另一个桥接实例
  已有实例在运行（PID 12345，启动于 2026-...）

  为什么要拦：跑两份会让同一条指令被执行两次，
  确认类操作（删除/推送）后果尤其严重。
```

这不是洁癖。跑两份的代价是：

- 两个进程同时连网关，每条消息收到两份回复
- **一次「确认」可能被两个进程各自执行一遍** —— "删除日志"删两次、`git push` 推两次
- 速率限制、会话、待确认令牌各算各的，行为不可预测

崩溃或强杀留下的**孤儿锁会被自动接管**（进程已死则允许启动），所以正常重启不受影响。
若确认为误报，按提示删除 `state/bridge.lock` 即可。

> 📌 **装计划任务前先停掉手动启动的实例**。任务的 `IgnoreNew` 策略只能防止重复的**任务**实例，
> 拦不住一个手动运行的进程。

---

## 配置参考

`config/config.json`（全部可选，下面是默认值）：

```json
{
  "dsh": {
    "nodeExe": "D:\\softwares\\dsh\\DeepSeek Harness.exe",
    "jsEntry": "D:\\softwares\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js",
    "cliPath": "D:\\softwares\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd",
    "workspace": "<项目目录>\\workspace",
    "_workspace本机现状": "本机已改为 C:\\Users\\<your-username>（整个用户目录），见开头第 0 节",
    "timeoutMs": 600000,
    "persistSession": true
  },
  "security": {
    "allowedOpenIds": [],
    "notifyUnauthorized": false,
    "rateLimit": {
      "perUserPerMinute": 6,
      "perUserPerHour": 60,
      "globalPerMinute": 20
    },
    "confirmTtlMs": 300000,
    "policyEnabled": true
  },
  "output": {
    "maxMessageChars": 1500,
    "fileThresholdChars": 6000,
    "artifactDir": ".dsh-artifacts",
    "sendFileWhenLarge": true
  },
  "logging": { "dir": "<项目目录>\\logs", "retainDays": 30, "level": "info" },
  "qq": { "allowGroup": false }
}
```

> **本机现状（2026-10-12）**：`dsh.persistSession = true` —— 同一用户的多条指令**接续同一个 DSH 会话**，
> 于是「看看 D 盘」之后可以说「那 C 盘呢」。这是有意的取舍：控制电脑很依赖上下文指代。
> 代价是上下文会越滚越大（每一步都要重传整个上下文：10 万 token ≈ 400–500KB；服务端长上下文
> prefill 也慢，12.6 万 token 时单任务曾要 117–467 秒）。缓解手段：隧道已开 `ssh -C` 压缩
> （实测同一请求 81.5s → 3.5s），并可用 `/new` 手动开新会话。想彻底关掉接续就设成 `false`。

### 长期记忆库（memory bank）

用户教机器人的事情写进一个 markdown 文件，**每次任务开始都注入给 agent**，
于是它记得你的偏好、约定与以前交代过的事 —— 而不是每轮都当陌生人。

```
qq-bridge/memory/MEMORY.md      ← 就是普通 markdown，可直接编辑
```

三种写入方式：

| 方式 | 说明 |
| --- | --- |
| 手机 QQ 发 `/remember 我的项目都在 D:\work` | 最确定：桥接直接追加，带时间戳 |
| 直接对它说「记住：我的项目都在 D:\work」 | agent 按运行说明用 read/edit 自己写进文件 |
| 在电脑上编辑 `memory/MEMORY.md` | 纯文本，随便改；`/memory` 可随时查看 |

规则（都很朴素，但踩过坑所以写清楚）：

- 记忆 = 文件里**第一个 `## ` 小标题之后**的内容；上面的说明段只是给人看的，不会被注入。
- 注入时按时间顺序，超出 `maxInjectChars` 只带**最新**的一段（越新越相关）；
  文件超过 `maxFileChars` 就拒绝追加，避免把每次请求都撑大。
- 记忆是"参考"，运行说明里明确了：与用户当前这句话冲突时，以当前这句话为准。

### 入站图片：QQ 直接发图也能识别

QQ 里直接发图时 `content` 往往是空的。桥接现在会把 `image/*` 附件下载到本地，再把
**绝对路径**放进任务文本，由 agent 用 `read_image` 去看（headless CLI 只接受一个任务
字符串，没有传图入口，所以"给路径"是最贴合现有工具链的做法）。

```
用户发图 → extractImages(msg) → downloadImages() → <项目>\inbox\<时间戳>-1.png
        → 任务文本里的【用户随消息发来的图片】块 → agent 调 read_image
```

| 情况 | 行为 |
| --- | --- |
| 只有图片、没有文字 | 仍会执行，任务文本用默认意图「（用户只发来图片，没有文字）…」 |
| 图片 + 文字 | 文字照旧是任务，图片路径一并带上 |
| 下载失败 / 超过 `qq.maxImageBytes` | 明确回复原因，不起任务（不静默丢） |
| 语音/文件等非图片附件 | 不下载，不影响文字任务 |

> ⚠️ **前提**：headless profile 的模型条目必须声明 `input: [text, image]`，
> 否则 `read_image` 会被直接拒绝：`model "…" does not declare image input`。
> 本机已在 `profiles\headless\cordis.patch.yml` 声明（Qwen3.8-27B 是原生 VLM）。
> 换成纯文本模型时必须去掉这行，否则会在请求中途被 provider 拒绝。

### 关思考代理：机器人不花时间在 reasoning 上

实测（同一 prompt）：

| | 耗时 | 结果 |
| --- | --- | --- |
| 开着思考 | 12.2s | 700 token 全花在 `reasoning_content`，正文 **0 字**（被截断） |
| 关掉思考 | 9.5s | 535 token 全是正文，正文 1022 字 |

迁移到二卡机后再测工具调用步骤：**1.9s → 1.3s（快 30%）**。也就是说思考既慢、
又可能把 token 预算烧光（在 agent 循环里表现为"某一步只思考不产出"，把任务拖长）。

为什么不在 DSH 的 provider 配置里关：`dsh-llm-pi-ai` 的 `compat.chatTemplateKwargs`
看起来是对的写法，但这个模型没声明 reasoning 支持，插件会把思考相关的 kwargs **整个丢掉**
（用透明代理截包确认：请求体里既没有 `chat_template_kwargs` 也没有 `reasoning_effort`；
写 `reasoning: high` 则直接报 `UNSUPPORTED_REASONING_EFFORT`）。

也不用服务端 `--default-chat-template-kwargs`：那会影响所有客户端（含桌面版），
且服务器是共享机器。

所以本机起一个极小的代理（`src/proxy/thinking-off.js`，监听 8002 → 8000），只给
**机器人**这条链路注入 `chat_template_kwargs.enable_thinking=false`。
桌面版的 provider 仍然直连 8000，思考照旧。

```
机器人 → http://127.0.0.1:8002/v1 （注入 enable_thinking=false）→ http://127.0.0.1:8000/v1
```

由 `scripts/start-all.ps1` 以隐藏方式拉起，`scripts/start-all.cmd status` 会显示
`proxy(thinking-off): RUNNING`。想给机器人恢复思考：把 headless profile 的
`baseURL` 改回 `http://127.0.0.1:8000/v1` 即可（代理留着不影响）。

### 超时：硬上限 30 分钟 + 空闲 5 分钟

审计日志里出现过 **5 个任务正好卡在 600,000ms 被杀** —— 那是旧的 10 分钟硬上限，
而本地 27B 在长上下文下本来就慢。现在两道闸门：

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `dsh.timeoutMs` | 1800000（30 分钟） | 单任务硬上限，兜底 |
| `dsh.idleTimeoutMs` | 300000（5 分钟） | 连续这么久**没有任何事件**才判卡死并终止 |

用"有没有事件"当判据最贴近"是不是还在动"：真卡死的不用白等 30 分钟，
而在干活的（一直有产出）不会被误杀。超时回复里会区分两种原因。

### 进度播报：说"在干什么"，而不是"仍在执行"

> ⚠️ **本机已关闭**（`progress.maxPushes: 0`、`heartbeatMs: 0`、`ackOnAccept: false`），
> 只给最终结果。原因有两个：用户明确说这类消息没意义；更要紧的是 **QQ 限制"针对同一条
> 用户消息最多 4 条被动回复"**（SDK `ReplyLimiter` 默认 limit=4，窗口 1 小时），
> 进度最多 8 条 + 接收确认 1 条很容易把配额吃光，导致**最终结果反而发不出去** ——
> 现象就是"任务跑着跑着没声了"。另外 `sendText` 现在会在被动回复失败时
> **降级为主动消息**再试一次（去掉 `msgId` 即为主动），尽量保证结果送达。

下面是打开时的行为（配置见 `progress` 段）：

改造前用户只收到 `🔄 仍在执行（第 20 轮，第 3 步，已用时 4 分 19 秒）`——知道在跑，
不知道在干什么。现在播报的内容来自 DSH 的事件流：

| 事件 | 播报文案 |
| --- | --- |
| `tool_call`（pwsh） | `🔧 正在运行命令：Get-ChildItem D:\（第 1 轮 第 1 步 · 已用 18 秒）` |
| `tool_call`（read/edit） | `🔧 正在读取文件：…` / `🔧 正在修改文件：…` |
| 工具已结束（下一步开始时复述） | `✅ 上一步：运行命令：df -h（…）` |
| 工具失败 | `🔧 上一步失败（error），正在调整做法（…）` |
| 还没有工具调用（只有思考） | `💭 用户想让我看看磁盘剩余空间…（…）` |
| 长 prefill/长生成（无任何事件） | 心跳补一条同类文案（`heartbeatMs`） |

节流仍然是硬约束（QQ 主动消息有配额）：前 8 秒静默、两条至少隔 15 秒、每任务最多 8 条，
心跳也走同一套闸门。`step_start` 本身**不再**单独发消息 —— 它只挂起，等 `tool_call`/`thinking`
把"在干什么"填进来再发（否则 1–2 秒后真正的动作会被最小间隔拦掉，用户又只看到空洞的"正在执行"，
这是真实事件流回放实测到的）。

### 环境变量（优先级高于配置文件）

| 变量 | 说明 |
| --- | --- |
| `QQ_APP_ID` | 机器人 AppID |
| `QQ_APP_SECRET` | 机器人 AppSecret |
| `QQ_ALLOWED_OPENIDS` | 逗号分隔的白名单 |
| `QQ_NOTIFY_UNAUTHORIZED` | `1` 时回复未授权提示（默认静默） |
| `QQ_ALLOW_GROUP` | `1` 时响应群聊 @（默认只支持私聊） |
| `DSH_WORKSPACE` | DSH 工作区（安全边界） |
| `DSH_CLI_PATH` | dsh 入口路径（`.cmd`，不安全路径） |
| `DSH_NODE_EXE` | ★ Node/Electron 可执行文件（与 `DSH_JS_ENTRY` 配合，避开 cmd.exe） |
| `DSH_JS_ENTRY` | ★ dsh 的 JS 入口（与 `DSH_NODE_EXE` 配合） |
| `DSH_TIMEOUT_MS` | 单任务超时 |
| `DSH_PERSIST_SESSION` | 会话接续开关：设 `0` 关闭（本机配置文件里已设为 `false`） |
| `LOG_LEVEL` | 日志级别 |

查看最终生效配置（敏感值自动脱敏）：

```cmd
bin\node.cmd src\main.js --print-config
```

---

## 消息处理流水线

顺序不可调换，每道都是必要防线：

| # | 阶段 | 行为 |
| --- | --- | --- |
| 1 | 提取 | 取发送者 openid 与文本 |
| 2 | **白名单** | 不在名单 → 静默丢弃（不暴露机器人存在） |
| 3 | 控制指令 | `/help` `/status` `/cancel` `/new` `/remember` `/memory` 本地处理 |
| 4 | 二次确认 | 文本 `确认 XXXX` **或按钮点击** → 消费令牌后执行 |
| 5 | **速率限制** | 超限告知重试时间 |
| 6 | **策略分级** | BLOCK 拒绝 / CONFIRM 发按钮 / SAFE 放行 |
| 7 | 执行 | `dsh --profile headless --json` 子进程 + 事件流解析；期间节流推送进度 |
| 8 | 回送 | 智能分段；超长落盘并**直发文件**，失败则降级为摘要+路径 |

按钮点击走独立入口（`interaction` 事件），但同样经过白名单与归属校验后才消费令牌。

---

## 安全模型

### 分层防御

| 层 | 机制 | 防止 |
| --- | --- | --- |
| 1 | 发送者白名单 | 陌生人调用 |
| 2 | 静默拒绝 | 暴露机器人存在 |
| 3 | 策略引擎 BLOCK | 破坏性/外泄/提权 |
| 4 | 二次确认（按钮/文本令牌） | 误触发变更 |
| 5 | 按钮归属校验 | 他人代按确认 |
| 6 | 速率限制 | 刷屏、资源耗尽 |
| 7 | 进度推送节流 | 自身刷屏导致机器人被限流 |
| 8 | 工作区隔离 | 越界写文件 |
| 9 | 审计日志 | 事后无法追责 |

### 策略引擎分级

- **SAFE** — 只读/查询：查看、列出、统计、分析、`git status`、`ipconfig`……
- **CONFIRM** — 有副作用但正常：删除/修改/新建文件、装包、下载、`git push`、改服务……
- **BLOCK** — 永久拒绝：`rm -rf`、`format`、`reg delete`、关闭防火墙、`runas`/`sudo`、
  管道执行远程脚本（`curl … | sh`）、`-EncodedCommand`、
  读取浏览器 `Login Data`/`cookie`、`id_rsa`、`mimikatz`、
  中文的数据外发意图（「把密码上传到…」）……

> ⚠️ **诚实说明**：基于正则的策略**永远不完备**，绕过方式无穷。
> 它的价值是拦掉误触和明显的坏意图，**不是**提供安全保证。
> 真正的边界是白名单 + 工作区隔离 + 二次确认 + 审计。

### 提权指令的处置（已知残留风险，请阅读）

提权被分成两档，这是有意的设计取舍：

| 形态 | 判定 | 例子 |
| --- | --- | --- |
| **提权到交互式高权会话** | BLOCK | `sudo -i`、`sudo -s`、`sudo bash`、`runas /user:Administrator cmd`、`-Verb RunAs`、`runas /savecred` |
| **单条提权命令** | CONFIRM | `sudo apt install curl`、`runas /user:guest notepad` |

**理由**：交互式高权会话等于把整台机器的最高权限交给对话方，且后续所有命令都脱离审查，
因此永久拒绝；而单条提权命令至少还留下一条可审计的执行记录，且必须人工确认。

> ⚠️ **残留风险**：`CONFIRM` 档意味着你可以通过手机回复令牌来批准一条提权命令。
> 这仍然是一次权限边界穿越 —— 令牌的确认动作本身没有二次验证要件
> （没有密码、没有 TOTP）。**如果你的威胁模型包含"手机被他人短暂拿到"，
> 应该把 `sudo`/`runas` 一律改为 BLOCK。**

改成一律拒绝（单行改动）：把 `src/policy/index.js` 中 `privilege-escalation-session`
规则的 `when:` 谓词整体替换为：

```js
re: /(?:\bsudo\b|\brunas\b|-verb\s+runas)/i,
```

改完必须重跑 `bin\node.cmd tests\policy.test.js` —— 该套件断言
`runas /user:Administrator cmd` → BLOCK，替换后仍应通过。

### 已知误判（有意为之）

策略引擎的 BLOCK 档是**术语盲**的：只要句子里出现高危词就拦，不判断语境。因此：

| 输入 | 判定 | 说明 |
| --- | --- | --- |
| `解释一下 rm -rf 是什么意思` | BLOCK | 只是提问，但含高危词 |
| `mimikatz 是什么工具` | BLOCK | 同上 |

**这是刻意的**：误拦一个提问的代价，远小于漏放一条真命令。
被误拦时在电脑上手动执行即可。

### Windows 特有注意事项

`child.kill()` 在 Windows 上**只终止直接子进程**，DSH 派生的孙进程会残留成僵尸。
本项目用 `taskkill /PID <pid> /T /F` 杀整棵进程树（见 `src/dsh/runner.js`）。
这是最容易漏掉的正确性问题。

---

## 目录结构

```
qq-bridge/
├── bin/
│   ├── node.cmd          # 复用 DSH 自带 Node v24（系统 PATH 无 node）
│   └── pnpm.cmd          # 复用 DSH 自带 pnpm 11.7
├── config/
│   ├── config.json       # 非敏感配置（带中文说明的模板）
│   └── creds.json        # 凭证（勿提交）
├── scripts/
│   ├── start-all.ps1     # 幂等启动器（隧道 + 桥接，均无窗口后台运行）
│   ├── start-all.cmd     # 手动入口（转发到 .ps1）
│   ├── install-task.ps1  # 计划任务：安装/卸载/状态/启停（注册需管理员）
│   ├── install-task.cmd  # 启动器（绕过未签名脚本限制）
│   └── README.md         # 后台常驻说明与验证方法
├── src/
│   ├── main.js           # 入口 + 流水线编排
│   ├── probe.js          # openid 探测工具
│   ├── config/index.js   # 配置加载 + 脱敏 + 占位符识别
│   ├── audit/index.js    # 审计日志（JSONL 按天轮转）
│   ├── ratelimit/index.js# 滑动窗口限流
│   ├── policy/index.js   # 三级策略引擎
│   ├── guard/index.js    # 单例守卫（防重复实例）
│   ├── qq/approval.js    # 按钮审批（键盘构造 + 不可信数据解析）
│   ├── progress/reporter.js # 进度推送（说"在干什么" + 三重闸门节流 + 心跳）
│   ├── memory/index.js    # 长期记忆库（markdown 追加 + 注入 + 体积闸门）
│   ├── dsh/
│   │   ├── events.js     # 事件流解析（纯函数）
│   │   └── runner.js     # 子进程（直调 Node，不经 cmd）+ 进程树清理 + 记忆注入
│   ├── output/
│   │   ├── chunk.js      # 代码块感知分段
│   │   └── artifacts.js  # 落盘 + 文件直发 + 降级回退
│   └── state/index.js    # 会话持久化
├── memory/MEMORY.md      # 长期记忆库本体（markdown，可直接编辑）
├── tests/                # 单元/集成测试（无需凭证即可跑）
├── workspace/            # DSH 操作边界
└── logs/                 # 审计日志
```

### 为什么有这些"奇怪"的写法

编写过程中实测踩到的环境坑，已固化进代码：

1. **`bin/*.cmd` 必须纯 ASCII** — `cmd.exe` 按 OEM 代码页解析 `.cmd`，
   UTF-8 中文注释会被当成命令执行（报 `'em' is not recognized...`）。
2. **`ws` 必须显式装成直接依赖** — pnpm 的 junction 软链 + Electron 从 asar 内解析 ESM
   时穿不过软链，报 `Cannot find package 'ws'`，即使它就在 `.pnpm` 里。
3. **读写 JSON 都要防 BOM** — PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
   `JSON.parse` 不接受。
4. **`spawn` 必须 `shell: false` + 参数数组** —— 任务文本作为单个 argv 元素传入。
   但**这还不够**：见下一节，Windows 上 `cmd.exe` 仍会重新解析命令行字符串，
   所以真正的防线是**根本不经过 `cmd.exe`**。

### `.cmd` 启动限制与命令注入（真实踩到的两个 bug）

**现象 1**：所有任务一律失败

```
[audit] task_error  user=...  错误=无法启动 dsh 进程: spawn EINVAL
```

**根因 1**：Node.js 自 20.x 起，为修复
[CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)，
**禁止直接 `spawn` `.cmd` / `.bat` 文件** —— 直接抛 `EINVAL`，根本不会尝试执行。
而 `dsh.cmd` 正是 `.cmd`。

**当时的（错误）解法**：改用 `cmd.exe /d /s /c <cliPath> <args...>`，
并认为"参数仍是数组、不经 shell 拼接，所以安全"。

**现象 2（更严重）**：这个判断是**错的**。

Windows 的 `CreateProcess` 只接受**一条命令行字符串**；Node 会把 argv 数组拼成
字符串，`cmd.exe` 随后**重新解析**它。于是任务文本里的 `&`、`|`、`>`、`"`、`%VAR%`
全部被当作 cmd 语法执行。实测证据（由 `tests/integration.test.js` 发现）：

```cmd
载荷 x&echo.>PWNED_AMP.txt          → 真的生成了 PWNED_AMP.txt
载荷 x|echo.>PWNED_PIPE.txt         → 真的生成了 PWNED_PIPE.txt
载荷 a" & echo.>PWNED_QUOTE.txt & "b → 真的生成了 PWNED_QUOTE.txt
载荷 explain %PATH% semantics        → argv 里 %PATH% 被展开成真实环境变量
```

也就是说：**任何人只要能往这个机器人发一句话，就能在你电脑上执行任意命令** ——
完全绕过策略引擎（策略引擎检查的是任务文本，而注入发生在它下游）。

**正确解法：根本不用 `cmd.exe`。**

`dsh.cmd` 只是一个包装器，内部等价于：

```bat
set ELECTRON_RUN_AS_NODE=1
"D:\softwares\dsh\DeepSeek Harness.exe" --expose-internals "<...>\dsh-desktop-host\lib\cli.js" %*
```

按这个方式直接调 Node 入口，就同时解决两个问题：

1. 绕开 Node 对 `.cmd` 的 `EINVAL` 限制
2. **完全不经 `cmd.exe`**，任务文本永远只是 argv 元素，不参与任何解析

配置项（见 `config/config.json` 的 `dsh.nodeExe` / `dsh.jsEntry`）：

```json
"nodeExe": "D:\\softwares\\dsh\\DeepSeek Harness.exe",
"jsEntry": "D:\\softwares\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js"
```

> `jsEntry` 位于 `app.asar` 内，普通 `Test-Path` 看不到它 —— 但 Electron 的 fs 层能解析，
> 所以 `nodeExe` 必须是 **Electron 本体**而非独立 node 运行时。

若未配置这两项，服务仍可启动，但会：

- 在自检报告里显示 `DSH 调用  经 cmd.exe（存在命令注入风险）`
- 启动时打印配置告警
- `resolveSpawn` 返回 `safe: false`，运行期再告警一次

`tests/spawn-cmd-probe.js` 可复现 `.cmd` 的 `EINVAL`；注入的端到端断言在
`tests/integration.test.js`（需在沙箱外的普通 cmd 窗口运行）。

---

## 测试

不需要凭证，沙箱内即可运行：

```cmd
bin\node.cmd tests\events.test.js      # 事件流解析 + 会话不匹配自愈 + profile 写入被拒识别（49 项）
bin\node.cmd tests\launch-context.test.js # 启动环境探针：能不能写 DSH 配置目录（9 项）
bin\node.cmd tests\chunk.test.js       # 输出分段（19 项）
bin\node.cmd tests\state.test.js       # 会话持久化（17 项）
bin\node.cmd tests\memory.test.js      # 长期记忆库（17 项）
bin\node.cmd tests\images.test.js      # 入站图片下载（13 项）
bin\node.cmd tests\proxy.test.js       # 关思考代理（7 项）
bin\node.cmd tests\config.test.js      # 配置合并 + 沙箱临时目录校验（44 项）
bin\node.cmd tests\runner.test.js      # 启动方式：直调 Node vs cmd 兜底（39 项）
bin\node.cmd tests\guard.test.js       # 单例守卫（19 项）
bin\node.cmd tests\policy.test.js      # 策略引擎（65 项）
bin\node.cmd tests\approval.test.js    # 按钮审批 + 不可信数据解析（41 项）
bin\node.cmd tests\progress.test.js    # 进度节流 + 并发安全（27 项）
bin\node.cmd tests\artifacts.test.js   # 落盘 + 文件直发 + 降级（38 项）
bin\node.cmd tests\pipeline.test.js    # 完整流水线（53 项）
bin\node.cmd tests\integration.test.js # 真实子进程链路（需要真实 dsh + 模型）
bin\node.cmd tests\sandbox-probe.js    # 沙箱子进程能力探测
bin\node.cmd tests\spawn-cmd-probe.js  # .cmd 启动实测对比
```

合计 **457 项**（不含 `integration.test.js`），当前全部通过。

> ⚠️ `integration.test.js` 在 DSH 沙箱内会**明确跳过** 7 项真实子进程断言
> （输出 `通过 7 项，失败 0 项，跳过 7 项`，并声明"跳过不是通过"）。
> 要完整跑它，请在**普通 cmd 窗口**执行 —— 那正是生产运行环境。

覆盖重点：
- 事件流跨 chunk 边界重组、损坏行容错
- 分段不丢内容、不切坏代码块（含"重建校验"）
- 确认令牌一次性/跨用户隔离/过期；按钮数据不可信输入严格拒绝
- 进度推送三重闸门；**并发调用（不 await）下仍正确节流**
- 文件直发失败时降级不丢结果；超平台上限的守卫真实生效
- 单例守卫：拒绝第二个实例、抢占崩溃残留锁、PID 复用防护
- **启动环境探针**：能不能写 DSH 配置目录（沙箱内启动 → 探针失败 → 拒绝启动/醒目告警）
- 配置占位符识别（防止"白名单看起来非空"掩盖告警）
- `.cmd` 必须经 `cmd.exe` 启动（Node 20+ 限制）
- **命令注入防护**：任务文本中的 `&` / `|` / `>` / `%VAR%` 不得被解释执行
- 高危指令必 BLOCK、变更必 CONFIRM、只读为 SAFE
- 策略引擎绝不抛异常且失败即拒绝
- 完整流水线：未授权静默丢弃、BLOCK 不执行、确认后执行、限流、落盘

> `pipeline.test.js` 用 mock bot 注入，因此能在无凭证、无网络、
> 无子进程权限的环境下验证全部安全关键路径 —— 这是本项目最重要的测试。

---

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 回复「复用了与当前工作目录不匹配的历史会话」 | 改过 `dsh.workspace`。DSH 的会话**与工作目录绑定**，会拒绝并明说：`session "…" was recorded in "A", not "B"` | 桥接已**自动清除**并提示；**重新发送一次**即可。或手工清空 `state/sessions.json` 的 `sessions` |
| 回复「系统临时目录落在 workspace 之内」/ 报 `Windows ACL temp root must be outside the workspace` | `dsh.workspace` 覆盖了 `%TEMP%`（例如设成 `%USERPROFILE%`），该会话下**所有命令行操作**都会失败 | 把 `workspace` 收窄到不含 `%TEMP%` 的目录（如 `…\Desktop`），或把 `sandboxTempDir` 指到 workspace 之外。启动期配置校验也会拦 |
| 启动报 `appid invalid` / `100007` | AppID 不对 | 核对 AppID（纯数字） |
| `4013` / `4014` / intents 报错 | 事件权限未获批 | 去开放平台申请单聊消息权限 |
| token 相关错误 | AppSecret 不对 | 重新复制或重置 |
| 手机发消息没反应 | 白名单没配，或未加开发体验用户 | 跑 probe 取 openid；在开放平台「开发设置」把自己加成开发体验用户 |
| 任务回复 `MISSING_CREDENTIAL` | DSH 没有模型 API Key | DSH Web 界面 → Models 填 Key |
| 日志 `spawn EINVAL` | 直接 spawn 了 `.cmd` 文件 | 已修复（改经 cmd.exe）。若仍出现，确认用的是最新 `src/dsh/runner.js` |
| `EPERM` 且提到 spawn / cmd.exe | 在 DSH 沙箱内运行 | 改到普通 cmd 窗口启动 |
| 手机收到「❌ 任务执行失败：桥接服务自己没有写权限」/ 日志里 `EPERM … .dsh\profiles\…\cordis.yml` | 桥接进程**自己**被从 DSH 沙箱内拉起（例如某个 DSH 会话直接 `Start-Process main.js`）。沙箱令牌被子进程继承，写不了工作区之外的 profile，于是每条指令都在 ~0.1s 内失败 | 停掉它，从普通窗口/双击启动：`scripts\start-all.cmd`（`start-all.ps1` 现在会先探针检查并直接拒绝这类启动） |
| 控制台只有 `[audit] task_error` 却不显示原因 | 早期版本的日志缺陷 | 已修复（现在会打印 `错误=...`） |
| 启动报「检测到另一个桥接实例」 | 已有实例在跑，或上次崩溃残留锁 | 先 `tasklist \| findstr "DeepSeek"` 确认；确认为孤儿锁则删 `state\bridge.lock` |
| 手机收到两份回复 | 跑了两个实例 | 同上，只保留一个 |
| 自检显示「经 cmd.exe（存在命令注入风险）」 | 未配置 `dsh.nodeExe` / `dsh.jsEntry` | 补上这两项配置，见「`.cmd` 启动限制与命令注入」 |
| `scripts\install-task.cmd -Action install` 报权限不足 | 注册计划任务必须提权 | 用管理员终端运行 |
| 结果只收到一部分 | 被动回复窗口过期 | 见下节 |
| `/cancel` 后进程还在 | 理论上不应发生 | 检查 taskkill 是否被安全软件拦截 |

### 被动回复窗口

QQ 机器人通常只能在收到用户消息后的有限时间内回复。跑 10 分钟的长任务时，
完成时可能已超窗口，导致结果发不出去。

本项目已做的缓解：
- 收到任务立即回「已接受」，保住会话
- 发送失败会被审计并停止重试
- 完整结果在超长时已落盘，可随时用只读指令取回

**兜底**：长时间任务如果没收到结果，给机器人发任意一条消息（比如 `/status`），
任务结果在会话里仍可查询。

---

## 已完成 / 后续可做

原先规划的五项已全部实现（见「使用」与「测试」章节）：

- ✅ QQ 按钮审批（`sendTextWithKeyboard`），文本令牌保留为回退
- ✅ 进度推送（三重闸门节流，并发安全）
- ✅ 结果文件直发（`sendFile`），失败自动降级
- ✅ Windows 计划任务自启（`scripts/`）
- ✅ 真实子进程集成测试（`tests/integration.test.js`）

尚未做的、可以考虑的方向：

- 多用户支持（每个用户独立工作区与会话）
- 定时任务（「每天早上 8 点帮我查一下…」）
- 结果文件在内网/公网的可取回方式（当前依赖 QQ 直发或本地路径）
- 语音消息（SDK 支持 `sendVoice`，但需 SILK 编解码）
- 把审计日志做成可查询的本地小面板

---

## 相关文档

- [QQ 机器人介绍与接入指南](https://bot.q.qq.com/wiki/bot_new_product-intro/)
- [事件订阅与通知（opcode / intents）](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
- [官方 Node.js SDK](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)
- 配套可行性方案：`../QQ机器人远程控制电脑-可行性方案.md`
- 权限验证工具：`../qq-bridge-verify/README.md`
