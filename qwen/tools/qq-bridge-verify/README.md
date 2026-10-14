# QQ 机器人权限申请与验证指引

配套方案：[QQ机器人远程控制电脑-可行性方案.md](../QQ机器人远程控制电脑-可行性方案.md)

---

## 0. 先分清两件完全不同的事

这是最容易混淆的地方，先看清楚：

| | **凭证（AppID / AppSecret）** | **事件权限（Intents）** |
| --- | --- | --- |
| 是什么 | 证明"你是这个机器人的主人" | 证明"平台允许你接收某类事件" |
| 从哪来 | 创建机器人后自动获得 | **需要在管理端单独申请，人工审核** |
| 拿不到会怎样 | 连 AccessToken 都换不到 | 能换 token，但 WebSocket 鉴权被拒 |
| 需要等待 | 不需要，立即有 | **需要，且可能被拒** ← 最大不确定性 |
| 本工具对应 | 步骤 1 (`01-token.js`) | 步骤 2 (`02-gateway.js`) |

**关键结论**：步骤 1 成功 ≠ 权限已批。**必须跑步骤 2 才能确认权限。**

---

## 1. 为什么要跑步骤 2 而不是只看管理端

因为这里有一个常见的假阳性：

> 管理端显示「已订阅」≠ API 实际放行

管理端的订阅状态和网关的权限校验可能不同步，或者申请状态显示模糊（"审核中"vs"已通过"）。**唯一可信的验证方式是实际建立一次 WebSocket 连接并发送 Identify。**

原理来自官方文档的明确说明：

> 如果在鉴权的时候传递了无权限的 `intents`，`websocket` 会报错，并直接关闭连接。

所以这个测试的判定逻辑非常干净：

```
连上 + 收到 READY       → 该 intents 有权限 ✅
连接被立即关闭           → 该 intents 无权限 ❌
```

**不需要真的发一条 QQ 消息就能测出权限** —— 这是本工具的价值。

---

## 2. 管理端操作路径

> ⚠️ QQ 开放平台控制台改版较频繁，下面的路径是撰写时的结构。若界面不同，请找语义等价的入口（关键词：「开发设置」「事件订阅」「功能配置」「权限管理」）。

**入口**：<https://q.qq.com/> → 登录 → 选择你的机器人 → 进入开发管理

### 2.1 获取凭证

在「开发设置」页面可以看到：

- **AppID** — 机器人的唯一标识
- **AppSecret** — 密钥，用于换取 AccessToken

> 🔒 AppSecret 只显示一次或需要点击重置才能看到。丢了就重置（会导致旧值立即失效）。
> 不要截图发到任何地方，包括聊天软件。

### 2.2 申请事件权限

你需要的事件是 **`C2C_MESSAGE_CREATE`**（用户单聊给机器人发消息），
它归属这一类订阅：

```
GROUP_AND_C2C_EVENT  =  1 << 25  =  33554432
```

包含的事件：

| 事件 | 含义 | 我们要不要 |
| --- | --- | --- |
| `C2C_MESSAGE_CREATE` | **用户单聊发消息给机器人** | ✅ **核心，必须要** |
| `FRIEND_ADD` | 用户添加机器人 | 建议要 |
| `FRIEND_DEL` | 用户删除机器人 | 可选 |
| `C2C_MSG_RECEIVE` | 用户开启"主动消息"推送 | 建议要（长任务推送用） |
| `C2C_MSG_REJECT` | 用户关闭"主动消息"推送 | 可选 |
| `GROUP_AT_MESSAGE_CREATE` | 群里 @ 机器人 | 不需要 |
| `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` | 机器人被拉入/移出群 | 不需要 |

**在管理端找到「事件订阅」或「功能配置」，勾选单聊消息相关的事件并提交审核。**

> 📌 官方文档特别提示：`GUILDS`、`PUBLIC_GUILD_MESSAGES`、`GUILD_MEMBERS` 是**默认有权限**的基础事件，其余**全部需要申请**。`GROUP_AND_C2C_EVENT` 属于需要申请的那一类。

### 2.3 如果找不到申请入口

可能的原因和对策：

| 情况 | 对策 |
| --- | --- |
| 机器人未完成基础信息/未上架 | 先完成机器人资料、头像、简介等必填项 |
| 个人开发者无该事件申请权限 | 联系文档里提到的「QQ 机器人反馈助手」咨询 |
| 需要机器人先通过审核 | 先提交机器人审核，通过后再申请事件 |
| 入口叫别的名字 | 找「开发设置 → 事件订阅 / 消息订阅 / 权限申请」 |

---

## 3. 验证流程

### 3.1 运行

```powershell
cd <your-project-dir>\qq-bridge-verify

# 首次：交互式输入凭证，只测目标权限
.\verify.cmd

# 完整对照测试（推荐首次排查用，能明确定位问题在哪一层）
.\verify.cmd -Mode all

# 想省去重复输入，把凭证存到本地（会提示风险）
.\verify.cmd -Mode all -SaveCreds
```

> ⚠️ **模式必须写成 `-Mode all`，不要写成 `verify.cmd all`。**
>
> 原因：`verify.cmd` 展开的是带尾反斜杠的路径（`"%~dp0verify.ps1"`），
> `cmd.exe` 会因此注入一个空字符串作为首个参数，而 PowerShell 按**位置**绑定参数。
> 结果 `verify.cmd all` 里的 `all` 会被绑到 `-AppId` 上，
> 脚本就会拿着 `AppID="all"` 去调 API，得到 `100007 appid invalid`。
>
> 当前版本已加入自愈（检测到 `-AppId` 是模式词时会自动改判为 `-Mode`，
> 并打印紫色 `[FIX ]` 提示），但仍建议直接写 `-Mode`。详见 5.1 节。

> ⚠️ **必须用 `verify.cmd`，不要直接跑 `verify.ps1`** ——
> 这台机器的 PowerShell 执行策略禁止运行未签名脚本，直接跑会报
> `UnauthorizedAccess` / "无法加载文件…未进行数字签名"。
> `verify.cmd` 只在**本次调用**内绕过该限制（进程级），不修改系统策略。

### 3.1.1 凭证格式要求

脚本会在发请求前做一次格式校验，避免浪费请求，也避免把坏值写进 `creds.json`：

| 字段 | 要求 |
| --- | --- |
| **AppID** | **纯数字**，通常 9–10 位（例：`102123456`）。脚本要求 `^\d{5,}$` |
| **AppSecret** | 大小写字母 + 数字的字符串，通常 32 位 |

会被直接拒绝的情况：

- `AppID` 填成模式词（`all` / `target` / `test` / `a` 等）
- `AppID` 含非数字字符（比如误填了机器人的 QQ 号）
- `AppID` 与 `AppSecret` 填成同一个值

> 💡 如果你填了合法格式但 API 仍返回 `100007 appid invalid`，
> 说明格式对但**值不对** —— 通常是 AppID 抄错，或机器人在该主体下不存在。

### 3.1.2 如果 `-SaveCreds` 存了坏凭证

`creds.json` 里的坏值会污染后续每次运行（表现为不停报 `100007`）。清掉即可：

```powershell
.\verify.cmd -ClearCreds
```


### 3.2 输出怎么读

**情况 A：权限已就绪**

```
▶ [1/1] 目标: GROUP_AND_C2C_EVENT (单聊/群聊消息)
   intents = 33554432
   判定: OK
   机器人: 你的机器人名 (id=...)
   session_id: xxxxxxxx-xxxx-...

✅ 目标 intents (33554432) 已被接受 —— 单聊消息权限可用。
   ➡️  可以开始阶段 1 的桥接服务开发。
```

**情况 B：权限未批（这是本次要排除的主要风险）**

```
   判定: CLOSED
   ❌ intents 无效：包含无权限的事件订阅 (...)
     → 这就是「权限没批下来」的信号。

❌ 目标 intents (33554432) 被拒绝。
   ➡️  需在 QQ 开放平台管理端申请「群聊/单聊消息」事件权限。
```

→ 回到第 2.2 节，去管理端申请，等审核通过再重跑。

**情况 C：结果不明确**

```
判定: TIMEOUT  /  判定: ERROR
```

→ 跑 `.\verify.cmd all`，用对照组推导。判定矩阵：

| `intents=0` | `1<<30` | `1<<25` | 结论 |
| --- | --- | --- | --- |
| ✅ | ✅ | ✅ | 全部就绪，开始开发 |
| ✅ | — | ❌ | **纯权限问题**，代码无错 |
| ❌ | ❌ | ❌ | 凭证/机器人状态/网络问题，**不是权限** |
| ✅ | ❌ | ❌ | `1<<30` 对未上架机器人也受限，需改用其他对照方式 |

### 3.3 连接配额

官方限制：**每个机器人 24 小时内最多 1000 次连接**（`session_start_limit`）。

- `mode=target` 消耗 1 次
- `mode=all` 消耗 3 次

正常排查完全够用，但**不要写循环反复重连**，配额耗尽会导致后续所有连接失败，且要等 24 小时重置。

---

## 4. 常见错误码对照

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `10004` | 机器人不存在 | AppID 抄错，或机器人未创建完成 |
| `100007` / 其他 | 凭证类错误 | 检查 AppSecret 是否被重置过 |
| close `4004` | 鉴权失败 | token 格式错误（忘加 `QQBot ` 前缀）或已过期 |
| close `4013` | **intents 无效** | **权限没批下来** ← 本次重点 |
| close `4014` | **intents 被拒绝** | **权限没批下来** ← 本次重点 |
| close `4008` | 限流 | 连接太频繁，等待后重试 |
| close `4914` | 机器人已下架 | 回管理端处理上架状态 |
| close `4915` | 机器人被封禁 | 检查是否违反运营规范 |

---

## 5. 目录结构

```
qq-bridge-verify/
├── verify.cmd              ← 入口，用这个
├── verify.ps1              ← 实际逻辑（ASCII-only，有编码原因）
├── bin/
│   └── node.cmd            ← 复用 DSH 自带 Node 的包装脚本
├── src/
│   ├── 01-token.js         ← 步骤 1：凭证 → AccessToken
│   └── 02-gateway.js       ← 步骤 2：网关连接 + intents 权限
├── config/                 ← creds.json（若用了 -SaveCreds）
└── .gitignore
```

### 为什么有这些"奇怪"的设计

编写过程中实测发现的两个真实环境约束，已写进代码注释：

1. **`bin\node.cmd` 必须纯 ASCII**
   本机 PATH 里没有 node，必须复用 DSH 自带的运行时。一开始我在 `node.cmd` 里写了中文注释，结果 `cmd.exe` 按 GBK 解析 UTF-8 字节，把中文注释当成命令执行，报了一堆
   `'em' is not recognized as an internal or external command`。

2. **`verify.ps1` 必须纯 ASCII**
   Windows PowerShell 5.1 按系统 ANSI 代码页（中文系统是 GBK）读取 `.ps1`。UTF-8 中文被误解码后不仅显示乱码，还会破坏字符串边界导致语法错误
   （`The string is missing the terminator`）。
   → 所以用户可见的中文全部放在 `.js` 里（Node 固定按 UTF-8 读取），`.ps1` / `.cmd` 只用英文。

3. **必须用 `verify.cmd` 启动**
   本机执行策略禁止未签名脚本。

4. **模式参数必须写 `-Mode all`，不能写 `verify.cmd all`**
   见 5.1 节，这是本项目最容易踩的坑。

---

## 5.1 位置绑定坑（重点）

这是实测踩到的真实问题，会导致**看起来像"凭证错误"，实际是参数错位**。

### 现象

```
AppID    : a***                     ← 应该是数字，这里是个字母
响应: {"code":100007,"message":"appid invalid"}
```

### 原因

`verify.cmd` 里启动 PowerShell 的写法是：

```bat
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify.ps1" %ARGS%
                                          ^^^^^^^^^^^^^^^^^^
                                          路径以反斜杠结尾
```

`%~dp0` 展开后**带尾部反斜杠**，`cmd.exe` 会把它拆成
`"...\qq-bridge-verify\"` + 空字符串两个 token，于是 PowerShell 收到的
第一个参数是**空串**。而 PowerShell 的参数是**按位置**绑定的：

```
verify.cmd all -SaveCreds
             ↓
PS 收到:  ''        'all'      '-SaveCreds'
绑定到:  $AppId     $AppSecret
```

结果 `all` 落进了 `$AppId`，`$Mode` 保持默认 `target`，
`-SaveCreds` 顺手把这个坏值写进了 `creds.json` ——
**之后每次运行都会读到它，表现成持续报 `100007`。**

### 已做的修复

1. **模式词自愈** —— `$AppId` 若是模式词（`all`/`target`/`baseline`/`zero`），
   自动改判为 `$Mode` 并打印 `[FIX ]` 提示
2. **去掉 `$Mode` 默认值** —— 便于区分"没传"和"传成了别的"
3. **凭证格式校验** —— `AppID` 必须是纯数字；与模式词相同、或与
   `AppSecret` 相同都会被拦下，**且不会写入 `creds.json`**
4. **文档统一改用 `-Mode`** —— 不再推荐 `verify.cmd all` 这种写法

### 正确写法

```powershell
.\verify.cmd -Mode all -SaveCreds
```

---

## 6. 下一步

- ✅ **步骤 2 判定 OK** → 进入阶段 1：搭建桥接服务骨架
- ❌ **判定 CLOSED / 4013 / 4014** → 回第 2.2 节申请权限，等待审核
- ⚠️ **判定不明确** → 跑 `.\verify.cmd all`，把完整输出留档再分析

> 📌 建议把每次验证的完整输出存档。如果权限申请被拒需要申诉，这些日志是有用的证据。

---

## 附录：官方文档

- [启动接入](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html)
- [接口调用与鉴权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)
- [事件订阅与通知（intents 定义）](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
- [获取通用 WSS 接入点](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html)
- [QQ 开放平台](https://q.qq.com/#/)
