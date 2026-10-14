# DSH 侧配置参考（QQ 机器人能真正干活的前置条件）

> 这个目录不是"程序"，是**新 PC 上 DSH 的配置参考**。
> 自动落地请用包根目录的 `apply-dsh-config.ps1`；本文件说明它改了什么、为什么、
> 以及桌面版 profile 该怎么手工贴。

---

## 1. 为什么 qq-bridge 迁移完了还不能用

`qq-bridge` 只是"遥控器"：它把 QQ 消息翻译成 `dsh --profile headless` 调用，
真正执行任务的是**新 PC 上的 DSH**。所以 QQ 机器人能不能用，取决于新 PC 的
headless profile 是否指向本地 vLLM（经 SSH 隧道）：

```
手机 QQ → qq-bridge → DSH(headless profile) → http://127.0.0.1:8002/v1 → thinking-off 代理
                                                                        → http://127.0.0.1:8000/v1 → SSH 隧道 → GPU 服务器 vLLM
```

链路里任何一环缺失，机器人都会报"模型/连接错误"，而不是静默退化。

---

## 2. `headless-cordis.patch.yml`（必做）

目标：`%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml`

关键两段：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: old4            # ← 默认模型改成本地 Qwen
    model: qwen3.8-27b

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      old4:
        apiKeyEnv: OLD4_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8002/v1     # ← 指向本机 thinking-off 代理
        models:
          - id: qwen3.8-27b
            name: qwen3.8-27b
            input: [text, image]              # ← 声明图片输入，read_image 才不会被拒
```

要点：

| 点 | 说明 |
| --- | --- |
| 为什么走 8002 而不是 8000 | `8000` 是隧道直连；`8002` 是本机 `qq-bridge\src\proxy\thinking-off.js`，它补上 `chat_template_kwargs.enable_thinking=false`。实测量级：开着思考 12.2s/700 token 全花在 reasoning_content，关掉后 9.5s 出正文 1022 字。 |
| 为什么不在配置里写 `compat.chatTemplateKwargs` | 该模型没有声明 reasoning 支持，`dsh-llm-pi-ai` 会把推理相关的 kwargs 整体丢掉（实测请求体里既无 `chat_template_kwargs` 也无 `reasoning_effort`）。所以只能靠透明代理截包。 |
| 权限为什么不在这里配 | 权限由**环境变量** `DSH_PERMISSION_MODE` 驱动（`sandbox-policy` 与 `approval` 成对派生），桥接 spawn DSH 时注入，值来自 `qq-bridge\config\config.json` 的 `dsh.permissionMode`。往 patch 里写 `permission-presets` / `sandbox-policy` 只会报 `patch: entry … not found`。 |
| `input: [text, image]` | 不声明的话 `read_image` 直接被拒：`model "qwen3.8-27b" does not declare image input`。换成纯文本模型时必须删掉这一行。 |

## 3. `%USERPROFILE%\.dsh\.credentials.yaml`（必做）

headless profile 用 `apiKeyEnv: OLD4_API_KEY`，该引用要从凭证库里解析：

```yaml
refs:
  OLD4_API_KEY: local-any-string
```

vLLM 本地服务不校验 Key，任意非空字符串即可。`apply-dsh-config.ps1` 会自动补上。

## 4. `desktop-cordis.patch.yml`（可选，桌面版用）

这是源 PC 桌面版 profile 的 patch 参考：它给桌面版也定义了 provider `old4`
（`baseURL: http://127.0.0.1:8000/v1`，直连隧道，**不关思考**），
并把默认模型设为 `deepseek-account/deepseek-flash`。

新 PC 若想让**桌面版 DSH** 也能切到本地 Qwen，把下面两段贴进
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（不要整文件覆盖，那里还有
UI 相关的设置）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      old4:
        apiKeyEnv: OLD4_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1
        models:
          - id: qwen3.8-27b
            name: qwen3.8-27b
            input: [text, image]
```

## 5. windows-mcp（可选，本迁移包不含）

源 PC 通过 `dsh-mcp-client` 以 stdio 接入 `CursorTouch/Windows-MCP`
（截图 / 鼠标键盘 / 开应用 / PowerShell / 文件操作，共 21 个工具）。
它的 `insert` 段长这样：

```yaml
- insert:
    - id: windows-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: windows
        transport: stdio
        command: C:\Users\<你>\.local\bin\uvx.exe      # 或 windows-mcp-venv\Scripts\windows-mcp.exe
        args: [windows-mcp, serve]
        toolCallTimeoutMs: 120000
```

- 本包**不含** `uvx.exe`、Python 环境或 `windows-mcp` 包。
- `apply-dsh-config.ps1` 的行为：检测不到 `uvx` / `windows-mcp-venv` 时，**自动从写入的配置里
  移除这个 `insert` 段**（避免 DSH 启动时反复连不上 MCP）；检测到就原样保留。
  两种情况的结论都会打印出来，便于核对。
- 要真启用：装 `uv`（`uv tool install windows-mcp`）后把上面那段贴回 profile（或重跑
  `apply-dsh-config.ps1`，它会保留源配置里已有的那段）。
- 排查小贴士：用 PowerShell 5.1 的 `Get-Content -Raw`（按 ANSI/GBK 解码）看 UTF-8 文件时，
  行尾字节可能"吃掉换行"，让你误以为少了换行。判断行结构请用
  `[System.IO.File]::ReadAllText($p,[System.Text.Encoding]::UTF8)`。

## 6. 落地与验证

```powershell
cd "$env:USERPROFILE\Desktop\qwen-migrate-package"
powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-dsh-config.ps1          # 先备份再写
powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-dsh-config.ps1 -Force  # 确认后直接替换
```

验证顺序（缺一环就会报错，别跳）：

1. 隧道在跑：`curl.exe http://127.0.0.1:8000/v1/models -H "Authorization: Bearer local-any-string"` → 200
2. 思考代理在跑：`Get-NetTCPConnection -LocalPort 8002 -State Listen`
   （用 `qq-bridge\scripts\start-all.ps1` 启动，它会同时起隧道、代理、桥接）
3. 在 DSH 里发一句"你好"，确认回复来自 `qwen3.8-27b` 而非云端模型
4. 手机 QQ 发一条指令，看 `qq-bridge\logs\bridge-stdout.log`
