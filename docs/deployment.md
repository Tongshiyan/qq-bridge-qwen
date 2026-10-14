# 部署指南

本文档面向开源用户，描述从零部署「QQ → DSH → Qwen 本地 Agent」系统的完整步骤。

> **Agent 友好**：本文档结构化为「前置检查 → 分步操作 → 验证」，DSH agent 可读取后自动执行大部分步骤，仅在需要用户手动操作处暂停并提示。

---

## 0. 系统架构

```
┌──────────┐    WebSocket    ┌──────────────┐    子进程    ┌──────────────┐
│  手机QQ   │ ──────────────▶ │  qq-bridge   │ ──────────▶ │ dsh headless │
│ (用户)    │ ◀────────────── │  (Windows PC) │ ◀────────── │  (agent)     │
└──────────┘    分段回复      └──────────────┘    结果      └──────┬───────┘
                                                                   │ HTTP
                                                                   ▼
                                                          ┌──────────────────┐
                                                          │  127.0.0.1:8002   │
                                                          │ (thinking-off 代理)│
                                                          └────────┬─────────┘
                                                                   │ SSH 隧道
                                                                   ▼
                                                          ┌──────────────────┐
                                                          │  GPU 服务器       │
                                                          │  vLLM + Qwen3.8  │
                                                          │  :8000           │
                                                          └──────────────────┘
```

**组件清单**：

| 组件 | 位置 | 作用 |
|------|------|------|
| QQ 开放平台 | 云端 | 消息收发 |
| qq-bridge | Windows PC | QQ ↔ DSH 桥接 |
| dsh headless | Windows PC | Agent 运行时（工具调用、文件操作） |
| thinking-off 代理 | Windows PC (8002) | 关闭 Qwen 思考模式，降低延迟 |
| SSH 隧道 | Windows PC | 本地 8000 → 远端 8000（含压缩） |
| vLLM + Qwen | GPU 服务器 | 模型推理 |

---

## 1. 前置条件（需用户手动完成）

以下事项无法由 agent 自动完成，需要用户提前准备：

### 1.1 GPU 服务器

- [ ] 一台 Ubuntu 20.04 服务器，≥ 1× RTX 3090 (24GB)
  - 单卡：可跑 AWQ-INT4 量化版（~20GB），剩余 ~3GB 给 KV
  - 双卡：可跑 FP16 全精度（TP=2），KV 池更大
- [ ] 已安装 NVIDIA 驱动 + CUDA
- [ ] 已安装 Python 3.10+
- [ ] 记录服务器 IP、SSH 用户名、密码（或密钥）

### 1.2 Windows PC

- [ ] Windows 10/11，已安装 Node.js ≥ 22、pnpm
- [ ] 已安装 DSH（DeepSeek Harness），headless profile 可用
- [ ] 已安装 Windows MCP（可选，提供桌面操作能力）
- [ ] 能 SSH 到 GPU 服务器（网络可达）

### 1.3 QQ 机器人

- [ ] 在 [QQ 开放平台](https://q.qq.com) 创建机器人应用
- [ ] 获取 AppID + AppSecret
- [ ] 记录自己的 openId（用于白名单）
- [ ] （推荐）使用**专用 QQ 号**，不要用主力号

### 1.4 SSH 免密（agent 可自动完成）

Windows PC 需要能免密 SSH 到 GPU 服务器。agent 可以自动完成此步骤。

---

## 2. 部署步骤

### 步骤 A：GPU 服务器上部署 vLLM（需用户手动）

> ⚠️ 此步骤需要用户在 GPU 服务器上操作，agent 可通过 SSH 指导但无法代替。

```bash
# 1. 安装 vLLM
pip install vllm

# 2. 下载/放置 Qwen 模型权重
#    模型需要 ≥ 50GB 磁盘空间（FP16）或 ~20GB（INT4）
#    模型目录需包含：config.json、tokenizer.json、*.safetensors、model.safetensors.index.json

# 3. 启动 vLLM（双卡 TP 示例）
vllm serve /path/to/Qwen3.8-27B \
  --tensor-parallel-size 2 \
  --max-model-len 262144 \
  --enable-prefix-caching \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}' \
  --max-num-batched-tokens 8192 \
  --port 8000 \
  --host 0.0.0.0

# 单卡版（去掉 --tensor-parallel-size）
```

**关键参数说明**：

| 参数 | 作用 | 建议值 |
|------|------|--------|
| `--tensor-parallel-size` | 多卡并行 | 卡数 |
| `--max-model-len` | 最大上下文 | 262144（模型上限） |
| `--enable-prefix-caching` | 前缀缓存（agent 刚需） | 开启 |
| `--speculative-config` | 投机解码（MTP） | 见上 |
| `--max-num-batched-tokens` | 批处理 token 数 | 8192 |

**验证**：
```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

**可选：设为 systemd 服务**（服务器重启后自动拉起）：
```bash
sudo tee /etc/systemd/system/qwen38.service << 'EOF'
[Unit]
Description=Qwen3.8-27B vLLM Service
After=network.target

[Service]
User=<你的用户名>
WorkingDirectory=/path/to/
ExecStart=/path/to/vllm serve /path/to/Qwen3.8-27B --tensor-parallel-size 2 --max-model-len 262144 --enable-prefix-caching --speculative-config {"method":"mtp","num_speculative_tokens":3} --max-num-batched-tokens 8192 --port 8000 --host 0.0.0.0
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable qwen38
sudo systemctl start qwen38
```

### 步骤 B：配置 SSH 免密 + 隧道（agent 可自动）

```powershell
# 在 Windows PC 上，qwen/ 目录：
cd qwen

# 一键配置（生成 key、安装到服务器、建隧道、设自启）
powershell -ExecutionPolicy Bypass -File setup-ssh.ps1 -Server <user>@<server-ip>
```

`setup-ssh.ps1` 会：
1. 生成 ed25519 密钥对（如不存在）
2. 将公钥安装到服务器 `~/.ssh/authorized_keys`
3. 配置 SSH 隧道：本地 8000 → 远端 127.0.0.1:8000
4. 配置 thinking-off 代理：本地 8002 → 远端 127.0.0.1:8000
5. 注册 Windows 自启任务（可选）

**手动替代**（如果不想用脚本）：
```powershell
# 1. 生成 key
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519

# 2. 安装公钥
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh <user>@<ip> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# 3. 手动开隧道
ssh -N -C -L 8000:127.0.0.1:8000 <user>@<ip>
```

### 步骤 C：配置 DSH（agent 可自动）

DSH headless profile 需要知道 Qwen API 在哪里。

**方法 1：使用仓库中的 patch 文件**

参考 `qwen/dsh-config/headless-cordis.patch.yml`，将模型条目指向 `http://127.0.0.1:8002/v1`：

```yaml
- id: llm-qwen-local
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    provider: openai-compatible
    baseUrl: http://127.0.0.1:8002/v1
    model: qwen3.8-27b
    input: [text, image]
```

**方法 2：让 agent 直接改**

对 agent 说：
> "把 DSH headless profile 的模型指向 http://127.0.0.1:8002/v1，model 名 qwen3.8-27b，声明 input: [text, image]"

agent 会找到 `~/.dsh/profiles/headless/cordis.patch.yml` 并添加条目。

**验证**：
```bash
dsh --print-config | findstr qwen
```

### 步骤 D：配置 QQ 桥接（agent 可自动）

```bash
cd qq-bridge
pnpm install
```

创建配置文件：
```bash
# 从示例复制
copy config\config.example.json config\config.json
copy config\creds.example.json config\creds.json
```

编辑 `config/creds.json`：
```json
{
  "appId": "<你的AppID>",
  "appSecret": "<你的AppSecret>"
}
```

编辑 `config/config.json`：
- `security.allowedOpenIds`：填入你的 openId
- `dsh.workspace`：设为工作目录（建议桌面）
- `qq.imageDir`：图片下载目录（可选）

**启动**：
```bash
pnpm start
```

**验证**：在 QQ 里给机器人发消息，应收到回复。

### 步骤 E：安装为 Windows 服务（可选，agent 可自动）

```bash
cd qq-bridge
pnpm task:install
```

重启电脑后桥接自动启动。

---

## 3. 端到端验证

1. QQ 发："你好"
2. 应收到 Qwen 的回复（经 DSH agent 转发）
3. QQ 发："帮我看看桌面上有什么文件"
4. agent 应调用工具列出桌面文件并回复
5. QQ 发："记住：我叫张三"
6. 下次对话应能记住

---

## 4. 常见问题

### Q: QQ 机器人无回复
- 检查 `logs/` 下桥接日志
- 确认 AppID/AppSecret 正确
- 确认 openId 在白名单
- 用 `qwen/tools/qq-bridge-verify/` 下的工具验证 QQ 凭证

### Q: DSH 报模型不可用
- 确认隧道在运行：`netstat -an | findstr 8000`
- 确认 vLLM 在运行：`curl http://127.0.0.1:8000/v1/models`
- 确认 DSH 配置指向 8002（不是 8000）

### Q: 回复很慢
- 检查 SSH 隧道是否开了压缩（`-C` 参数）
- 检查 vLLM 是否开了 prefix caching
- 长上下文时 TTFT 会升高（上传整个会话 JSON）

### Q: 桥接改完代码不生效
- 桥接是常驻进程，改完 `src/` 必须重启
- `taskkill /f /im node.exe` 后重新 `pnpm start`
- 或 `pnpm task:uninstall && pnpm task:install` 重启服务

---

## 5. 目录结构参考

```
<repo>/
├── README.md
├── LICENSE
├── .gitignore
├── docs/
│   └── deployment.md        # 本文档
├── qq-bridge/
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── .npmrc
│   ├── .gitignore
│   ├── src/
│   │   ├── main.js          # 入口
│   │   ├── config/          # 配置加载
│   │   ├── dsh/             # DSH 驱动（runner、events、launch-context）
│   │   ├── qq/              # QQ 消息处理（approval、inbound-images）
│   │   ├── output/          # 输出（chunk 分段、artifacts 文件投递）
│   │   ├── proxy/           # thinking-off 代理
│   │   ├── memory/          # 长期记忆
│   │   ├── guard/           # 安全守卫
│   │   ├── policy/          # 策略引擎
│   │   ├── ratelimit/       # 限流
│   │   ├── state/           # 状态管理
│   │   ├── audit/           # 审计
│   │   └── progress/        # 进度播报
│   ├── tests/               # 测试（16 个）
│   ├── scripts/             # 启动/安装脚本
│   └── config/
│       ├── config.example.json   # 配置示例
│       └── creds.example.json    # 凭证示例
└── qwen/
    ├── tunnel.ps1           # SSH 隧道
    ├── setup-ssh.ps1        # SSH 免密配置
    ├── QwenControlPanel.ps1 # 控制面板
    ├── start-tunnel.cmd     # 快速启动隧道
    ├── start-console.cmd    # 快速启动控制面板
    ├── install-tunnel-autostart.ps1  # 自启注册
    ├── disable-autostart.ps1         # 取消自启
    ├── make_qwen_icon.py  # 图标生成
    ├── QwenLauncher.cs    # C# 启动器源码
    ├── dsh-config/        # DSH patch 示例
    ├── tools/
    │   ├── dsh-probe.js   # DSH 探针
    │   └── qq-bridge-verify/  # QQ 凭证验证工具
    └── docs/              # vLLM 部署文档（已脱敏）
```
