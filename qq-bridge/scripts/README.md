# 开机自启：Windows 计划任务

把桥接服务注册成 Windows 计划任务，**登录后自动在后台运行，崩了自动拉起**，
不用再手开一个 cmd 窗口挂着。

```
登录 Windows ──▶ Task Scheduler ──▶ 隐藏窗口的 PowerShell ──▶ bin\node.cmd ──▶ src\main.js
                     ▲                                                              │
                     └──────────────── 退出码非 0 就按 1 分钟间隔重启 ◀───────────────┘
```

> ⚠️ **不论用哪条路径启动，桥接都必须在 DSH 沙箱之外运行**（计划任务天然满足：它由
> 任务计划服务以普通用户令牌拉起）。若从某个 DSH 会话里直接把桥接拉起来，沙箱令牌会被
> 子进程继承，桥接 spawn 的 `dsh` 写不了 `%USERPROFILE%\.dsh\profiles\…\cordis.yml`，
> 表现为**每条指令都在 ~0.1 秒内 EPERM 失败**。
> 现在 `scripts/start-all.ps1` 启动前会真写一个探针文件，写不进去就直接拒绝启动（退出码 7），
> 详见项目根 README 的「必须在 DSH 沙箱之外运行」。

---

## 一、这个任务做什么、什么时候启动

| 项 | 值 |
| --- | --- |
| 任务名 | `dsh-qq-bridge`（位于任务计划程序根目录 `\`） |
| 触发 | **当前用户登录时**；登录后延迟 **20 秒**再启动（等网络就绪） |
| 身份 | 当前用户（例如 `DESKTOP-XXXX\<your-username>`），交互式令牌，`RunLevel=Limited`（**不提权**） |
| 启动方式 | 隐藏窗口的 PowerShell → `bin\node.cmd` → `src\main.js` |
| 工作目录 | `<项目目录>`，即 `%BRIDGE_DIR%` |
| 崩溃自愈 | 退出码非 0 时，最多重启 **999 次**，每次间隔 **1 分钟** |
| 多开保护 | `IgnoreNew`：已经在运行时，系统不会启动第二份 |
| 超时 | 无限制（`PT0S`）—— 桥接是长驻服务，不能被"3 天后自动结束"杀掉 |
| 电源 | 允许电池下启动、切换到电池不停止（笔记本适用） |
| 输出 | 追加到 `logs\service.log`（UTF-8） |

> ⚠️ **工作目录必须正确**：`src/main.js` 按项目目录解析 `config\`、`logs\`、`workspace\`。
> 计划任务不设工作目录时的默认值是 `C:\Windows\System32`，相对路径会全部跑偏。
> 本脚本显式设置了 `WorkingDirectory`，行为与你手动 `cd` 进项目目录再运行完全一致。
> 用 `-Action show` 可以直接看到这一项。

---

## 二、设计取舍：为什么是「登录时触发 + 当前用户会话」

备选方案是「不管用户是否登录都运行」（需要保存密码，或改用 S4U 令牌）。**本项目不采用**，原因：

1. **桥接需要你的用户环境**：DSH 的模型凭证在 `%USERPROFILE%\.dsh`，
   QQ 凭证在 `config\creds.json`，日志和工作区也都在你的用户目录里。
2. 「不管是否登录」要求把账户密码交给任务计划程序（落盘存储），
   而 S4U 又会在没有加载用户配置的场景下运行，容易踩到权限/映射盘的坑。
3. 桥接的产物（审计日志、工作区文件）都应该是**你登录后能直接看到**的东西，
   跑在不可见的会话里只会让排错变难。

所以定稿是：**登录触发 + 以当前用户身份 + 交互式令牌**。
代价很明确：**必须处于登录状态**（锁屏没关系，注销/关机不行）。

同时刻意**不提权**：桥接会把聊天消息变成电脑上的操作，
让它以管理员身份常驻等于把提权能力交给对话方。需要管理员权限的只有"注册/删除任务"这一步。

---

## 三、用法

本机 PowerShell 执行策略会拦截未签名脚本（直接跑 `.\install-task.ps1` 报
`无法加载文件 ... 未进行数字签名`），所以**必须通过 `.cmd` 包装器调用**：
它只对当次进程使用 `-ExecutionPolicy Bypass`，不改任何机器级策略。

```cmd
cd %BRIDGE_DIR%

scripts\install-task.cmd -Action status      :: 查看状态（不带参数时默认就是 status）
scripts\install-task.cmd -Action install     :: 注册 / 更新（幂等）
scripts\install-task.cmd -Action start       :: 立刻启动
scripts\install-task.cmd -Action stop        :: 停止
scripts\install-task.cmd -Action uninstall   :: 删除任务（不动任何文件）
scripts\install-task.cmd -Action show        :: 演练：只打印将要注册的定义，不做任何改动
```

| 动作 | 需要管理员？ | 说明 |
| --- | --- | --- |
| `install` | **是** | 注册或就地更新任务；重复执行不会产生第二份（内部用 `-Force`） |
| `uninstall` | **是** | 删除任务；只删任务，不删文件 |
| `status` | 否 | 状态、上次运行结果、下次运行时间、工作目录 |
| `start` / `stop` | 否\* | 立即启动 / 停止 |
| `show` | 否\*\* | 纯演练，绝对不改系统 |

> \* 本机实测：非提权会话里连**读取**任务的 CIM 接口都会被拒绝（`0x80041003`），
> 因此 `status` / `start` / `stop` 走 `schtasks.exe`（普通权限可用）。
> 如果仍被拒绝，脚本会打印明确的提权指引，而不是抛一段看不懂的异常。
>
> \*\* 非提权时 `show` 无法导出完整 XML（同样是 CIM 被拒），
> 但**完整命令行、工作目录、触发器、运行设置**都会照常打印 —— 这些才是关键信息。

### 安装（需要管理员）

```cmd
:: Win+X → 「终端(管理员)」 或 「Windows PowerShell(管理员)」
cd /d %BRIDGE_DIR%
scripts\install-task.cmd -Action install
```

也可以直接右键 `scripts\install-task.cmd` → **以管理员身份运行**。

装完再（普通窗口即可）：

```cmd
scripts\install-task.cmd -Action start
scripts\install-task.cmd -Action status
```

> ⚠️ **如果现在还有一个手动启动的窗口在跑（`bin\node.cmd src\main.js`），先把它 Ctrl+C 关掉。**
> 任务的 `IgnoreNew` 只能防止**任务自己**被启动两份，管不了你手动起的那一份 ——
> 两个实例会各自连一次 QQ 网关，消息会被抢着处理，行为很难预测。

### 可选参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-TaskName` | `dsh-qq-bridge` | 任务名（只允许字母数字和 `. _ -`） |
| `-ProjectRoot` | 本脚本所在目录的上一级 | 项目根目录，路径写错会在注册前就被拦下 |
| `-LogonDelaySeconds` | `20` | 登录后等待多少秒再启动 |

---

## 四、验证它真的生效（最重要的一节）

按顺序做，别跳步。

### 第 1 步：任务本身的健康状况

```cmd
scripts\install-task.cmd -Action status
```

健康时应当是这个样子：

```
Installed  : yes
Source     : schtasks
State      : Running
Task state : Enabled
Last run   : 2026-10-11 18:03:12
Last result: 0x00041301 (267009) - currently running
Next run   : N/A
Run as     : DESKTOP-XXXX\<your-username>
Logon mode : Interactive/Background
Working dir: %BRIDGE_DIR%
```

看三件事：

1. `Installed : yes`
2. `Last result` 是 `0x00041301 ... currently running` → 正在运行
3. `Working dir` 是**项目目录**（不是 `C:\Windows\System32`）

`Last result` 常见值（脚本已经帮你翻译成人话）：

| 代码 | 含义 |
| --- | --- |
| `0x00041301` | 正在运行（正常） |
| `0x00041303` | 还没跑过：刚注册、还没重新登录，也没手动 start |
| `0x00000001` | 通用失败：进程起来了又立刻退出 |
| `0x80070002` | 找不到要运行的程序（路径写错） |
| `0x80070005` | 访问被拒绝 |
| `0x00041306` | 被手动结束（你按了 stop 或任务计划程序里的"结束"） |
| `0xC000013A` | 被 Ctrl+C / 强制终止 |

> 任务不存在时 `status` 会明确说 `Installed : no` 并给出下一步命令，
> 退出码 **3**（不是崩溃、不是一堆红字）。

### 第 2 步：确认桥接真的在干活（而不是「任务在跑、进程早死了」）

看它自己的审计日志。**必须加 `-Encoding UTF8`** ——
PowerShell 5.1 读没有 BOM 的文件时会按 GBK 解码，中文全是乱码：

```cmd
:: 今天的审计日志，最后 20 行
powershell -NoProfile -Command "Get-Content (Join-Path .\logs ('audit-' + (Get-Date -Format yyyy-MM-dd) + '.jsonl')) -Tail 20 -Encoding UTF8"

:: 只看每次启动的 startup 记录（最近 3 条）
powershell -NoProfile -Command "Get-Content .\logs\audit-*.jsonl -Encoding UTF8 | Select-String 'startup' | Select-Object -Last 3"
```

- 出现 `"event":"startup"`，且 `ts` 与你 start / 登录的时间吻合 → **启动成功**
- 出现 `"event":"sdk_log"`（`[qqbot:api] <<< Status: 200 OK`）→ **与 QQ 网关连着**
- 出现 `"event":"diag"` / `"task_done"` → 正在正常处理消息

### 第 3 步：端到端（最可靠的一条）

用手机 QQ 给机器人发：

```
/status
```

**有回复** → 「计划任务 → 桥接 → QQ 网关 → 白名单 → DSH」整条链路都活着。
**没回复** → 桥接没在跑，或凭证/白名单有问题（对照下一节）。

### 第 4 步：静默失败时看哪里

如果程序在"审计模块初始化之前"就挂了（比如依赖缺失、凭证读不出来），
`audit-*.jsonl` 里**不会有任何新行** —— 这时候要看任务自己的控制台输出：

```cmd
powershell -NoProfile -Command "if (Test-Path .\logs\service.log) { Get-Content .\logs\service.log -Tail 30 -Encoding UTF8 } else { 'no service.log yet' }"
```

**「成功」和「静默失败」对照表**：

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `status` 显示 Running，且 audit 里有新的 `startup` | 正常 | 无需处理 |
| `status` 显示 Running，但 audit 长期没有新行、也没有 `startup` | 进程活着但没连上（网络未就绪、网关断线） | `-Action stop` → `-Action start`；仍不行看 `service.log` |
| `status` 显示 Ready/Stopped，`Last result` 非 0 | 起来就退，任务正在按 1 分钟间隔重试 | 看 `service.log` 末尾；修好后 `-Action start` |
| `service.log` 有 `Cannot find module ...` | 依赖没装 / 路径不对 | 先在普通 cmd 窗口手动跑通：`bin\node.cmd src\main.js` |
| `service.log` 有 `MISSING_CREDENTIAL` | DSH 没有模型 API Key | DSH Web 界面 → Models 填 Key（见主 README 步骤 4） |
| audit 里 `"event":"error"` + `缺少 AppID/AppSecret` | `config\creds.json` 缺失或损坏 | 见下面「环境变量不会被继承」 |
| 每分钟重启一次、停不下来 | 崩溃自愈在生效，但根因没解决 | 先 `-Action stop`，手动跑通再 start |

> ⚠️ **计划任务不会继承你在 cmd 窗口里 `set` 的环境变量。**
> 靠临时环境变量提供的 `QQ_APP_ID` / `QQ_APP_SECRET` / `QQ_ALLOWED_OPENIDS`
> 在任务里**根本不存在**，表现为 `status` 一切正常但桥接立刻退出。
> 两种正确做法：
> 1. 写进 `config\creds.json` 与 `config\config.json`（推荐）；
> 2. 用 `setx QQ_APP_ID 123456` 写进**用户级**环境变量（写完要重新登录，任务才会看到）。

安装时脚本会顺便检查 `config\creds.json` 与 `%USERPROFILE%\.dsh`，
缺失会打印 `[WARN]`，就是提前把这类静默失败拦下来。

---

## 五、日志文件对照

| 文件 | 内容 | 谁写的 |
| --- | --- | --- |
| `logs\audit-YYYY-MM-DD.jsonl` | **权威审计日志**，每行一个 JSON 对象，按天轮转 | 桥接自己（UTF-8，无 BOM） |
| `logs\service.log` | 桥接的控制台输出（stdout + stderr），用于诊断"还没初始化就挂了" | 任务里的隐藏 PowerShell（UTF-8） |

审计日志每行形如：

```json
{"ts":"2026-10-11T10:33:04.685Z","event":"startup","version":"0.1.0","workspace":"...\\workspace","allowlistSize":1,"policyEnabled":true}
```

常用 `event`：

`startup` `shutdown` `message_in` `unauthorized` `rate_limited` `policy_blocked`
`policy_confirm_pending` `policy_confirmed` `task_start` `task_done` `task_error`
`task_timeout` `task_cancelled` `send_failed` `sdk_log` `diag` `error`

> 一行一个 JSON 的好处：`Select-String`、`findstr`、`node` 都能直接处理，
> 不用担心多行格式把某条记录切坏。

---

## 六、退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功（`status` 表示任务已存在） |
| `1` | 意外错误 |
| `2` | 参数错误（动作名不认识、任务名非法） |
| `3` | 任务尚未注册 |
| `4` | 项目文件缺失（`-ProjectRoot` 指错了） |
| `5` | 注册/删除被拒绝 → 需要用管理员身份运行 |

---

## 七、已知限制与坑（诚实清单）

1. **必须处于登录状态**。登录触发 + 交互式令牌：注销后任务不运行，锁屏不影响。
2. **睡眠 / 休眠会断**。整机挂起时桥接不可能响应；唤醒后 WebSocket 可能已经断开。
   最省事的恢复方式：`-Action stop` 再 `-Action start`。
3. **模型凭证来自 `%USERPROFILE%\.dsh`**。桥接只是转发，真正干活的是 DSH；
   任务是以"你"的身份跑的，所以用的就是你的 DSH 配置，换用户就得重新配。
4. **环境变量不会被继承**（见第四节末尾）。这是最容易误判成"任务装了但没用"的坑。
5. **`stop` 可能留下子进程**。任务计划程序结束的是任务进程树；
   若发现残留的 `node` / `cmd`，用 `tasklist` 检查并手动结束。
   残留进程会继续占着 QQ 连接 —— 这时会出现"任务显示没在跑，但机器人还在回消息"的怪现象。
6. **登录瞬间可能闪一下黑框**。`-WindowStyle Hidden` 已经隐藏窗口，
   个别机器仍会有一帧闪现。要彻底无窗口，可自行改成 VBS 包装（`WScript.Shell.Run` 带 `0`）。
7. **任务在「任务计划程序」里可见**：根目录，名字 `dsh-qq-bridge`，`taskschd.msc` 可查。
   `-Action status` 给的信息更全（含解码后的运行结果）。
8. **改了代码不用重装任务**：任务只是启动 `src\main.js`。
   只有**项目路径变了**（或 DSH 自带的 Node 位置变了）才需要重新 `install`。
9. **非提权下 CIM 接口被拒**（本机实测 `0x80041003`）：所以 `status/start/stop` 用
   `schtasks.exe`，只有 `install`/`uninstall` 需要管理员。
10. **`status` 里的 `Task to run` 可能被 `schtasks` 截断**（列宽限制）。
    要看**完整**命令行请用 `-Action show`。

---

## 八、彻底清除（任务 + 所有痕迹）

```cmd
scripts\install-task.cmd -Action stop

:: 需要管理员
scripts\install-task.cmd -Action uninstall

:: 可选：删掉运行时产生的数据（按需）
rmdir /s /q %BRIDGE_DIR%\logs
rmdir /s /q %BRIDGE_DIR%\state
rmdir /s /q %BRIDGE_DIR%\workspace
del %BRIDGE_DIR%\config\creds.json
```

确认任务真的没了（应提示找不到该任务）：

```cmd
schtasks /query /tn "\dsh-qq-bridge"
```

> `uninstall` **只删任务，不删任何文件** —— 日志和凭证的去留由你决定。
> 注册表里没有本脚本留下的东西：一切都是标准计划任务对象，`uninstall` 一并删掉。

---

## 九、为什么这两个脚本必须纯 ASCII

（对应主 README 的「为什么有这些'奇怪'的写法」）

1. **`.cmd` 必须纯 ASCII**：`cmd.exe` 按 OEM 代码页（本机 936/GBK）解析 `.cmd`，
   UTF-8 中文会被当成命令执行。本项目真踩过这个坑。
2. **`.ps1` 必须纯 ASCII**：Windows PowerShell 5.1 按系统 ANSI 代码页（GBK）读 `.ps1`，
   UTF-8 中文会被错误解码，可能直接解析失败（`The string is missing the terminator`）。
   这也是本项目真实踩过的坑。

具体做法：

- 脚本里**所有面向用户的提示都是英文**（中文说明全部在这个 `.md` 里，
  Markdown / 编辑器 / Node 都按 UTF-8 读，不存在编码问题）；
- `schtasks` 在**中文 Windows 上会输出中文标签**（`上次运行结果` 等），
  为了既能匹配中文、又保持文件纯 ASCII，这些标签在 `.ps1` 里不是字面量，
  而是运行时由 UTF-16 码点拼出来的（见脚本里的 `New-LocalizedText`）。

自查（两个文件都应输出 `0`）：

```cmd
powershell -NoProfile -Command "$b=[IO.File]::ReadAllBytes('install-task.ps1'); ($b | Where-Object {$_ -gt 127}).Count"
powershell -NoProfile -Command "$b=[IO.File]::ReadAllBytes('install-task.cmd'); ($b | Where-Object {$_ -gt 127}).Count"
```

---

## 十、相关文档

- 主文档（凭证、白名单、策略引擎、排错）：`..\README.md`
- 权限验证工具：`..\..\qq-bridge-verify\README.md`
- 手动启动方式（排错时用）：

  ```cmd
  cd %BRIDGE_DIR%
  bin\node.cmd src\main.js
  ```
