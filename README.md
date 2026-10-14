# QQ → DSH → Qwen 本地 Agent 系统

**中文 README** | [English README](README.en.md)

用手机 QQ 发消息，家里的电脑（通过 DeepSeek Harness + 本地/远程 Qwen 模型）替你干活：
读文件、跑脚本、操作桌面、部署服务……

> **本项目即部署工具：** 这个仓库本身就是用这套系统搭建的——在 QQ 里发一条消息，DSH agent 读取 `docs/deployment.md`，自动完成仓库整理、敏感信息清洗、git 初始化和提交。你现在看到的整洁代码库，就是 agent 的产出。

```
手机QQ ──▶ QQ开放平台 ──▶ WebSocket ──▶ 桥接服务(PC) ──▶ dsh headless ──▶ 工作区
                                                       │
                                                       └──▶ SSH隧道 ──▶ GPU服务器(vLLM + Qwen)
```

## 仓库结构

| 目录 | 说明 |
|------|------|
| `qq-bridge/` | QQ 机器人桥接服务（Node.js），负责收发消息、驱动 DSH agent |
| `qwen/` | Qwen 模型部署工具集：vLLM 服务端配置、SSH 隧道、控制面板、自启脚本 |
| `docs/` | 部署指南（面向开源用户） |

## 快速开始

> 详细分步部署见 [docs/deployment.md](docs/deployment.md)。

### 前置条件

1. **一台 GPU 服务器**（Ubuntu 20.04，≥ 1× RTX 3090 24GB，或 2 卡做 TP）
2. **一台 Windows PC**（运行桥接服务 + DSH agent）
3. **QQ 开放平台机器人**（已创建，有 AppID + AppSecret）
4. **SSH 免密登录** Windows PC → GPU 服务器
5. **DSH（DeepSeek Harness）** 已安装，headless profile 已配置

### 步骤 1：部署 vLLM 服务端（GPU 服务器上）

```bash
# 安装 vLLM
pip install vllm

# 启动 Qwen3.8-27B（双卡 TP 示例，单卡去掉 --tensor-parallel-size）
vllm serve /path/to/Qwen3.8-27B \
  --tensor-parallel-size 2 \
  --max-model-len 262144 \
  --enable-prefix-caching \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}' \
  --max-num-batched-tokens 8192 \
  --port 8000
```

验证：
```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

### 步骤 2：配置 SSH 隧道（Windows PC）

```powershell
# 一键配置（首次，安装 ssh key + 建隧道 + 自启）
cd qwen
powershell -ExecutionPolicy Bypass -File setup-ssh.ps1 -Server <你的SSH地址>
```

隧道将远端 `8000` 映射到本地 `127.0.0.1:8000`，`8002` 映射到思考关闭代理。

### 步骤 3：配置 DSH

在 DSH headless profile 的 `cordis.patch.yml` 中添加模型条目，指向 `http://127.0.0.1:8002/v1`（经思考关闭代理）。

参考 `qwen/dsh-config/` 下的示例 patch 文件。

### 步骤 4：配置 QQ 桥接

```bash
cd qq-bridge
pnpm install

# 编辑 config/config.json（参考 config/config.example.json）
# 填入你的 AppID、AppSecret、openId 白名单

# 启动
pnpm start
```

### 步骤 5（可选）：安装为 Windows 服务

```bash
cd qq-bridge
pnpm task:install
```

## Agent 辅助部署

本项目设计为 **DSH agent 可读文档后自动完成大部分部署**。

对 agent 说：

> "读 docs/deployment.md，帮我部署 Qwen 本地 Agent 系统"

agent 会：
1. 检查前置条件（SSH 连通性、vLLM 是否运行、DSH 配置）
2. 引导你完成需要手动操作的步骤（如 GPU 服务器上装 vLLM）
3. 自动配置 SSH 隧道、DSH profile、QQ 桥接
4. 端到端验证（发条 QQ 消息测试）

## 架构说明

### qq-bridge（QQ 机器人桥接）

```
QQ开放平台 (WebSocket)
    │
    ▼
qq-bridge (Node.js 常驻进程)
    │  ├── 收消息 → 解析指令 → 构建 DSH 任务
    │  ├── 驱动 dsh headless (子进程)
    │  ├── 解析 agent 输出 → 分段回复 QQ
    │  ├── 进度播报（可选）
    │  ├── 文件投递（SEND_FILE 标记）
    │  ├── 长期记忆（MEMORY.md 注入）
    │  └── 安全策略（openId 白名单、写操作审批）
    ▼
dsh headless (agent 子进程)
    │  ├── 工具调用（文件、shell、MCP 等）
    │  └── LLM 请求 → 127.0.0.1:8002
    ▼
SSH 隧道 → GPU 服务器 → vLLM (Qwen)
```

### qwen（模型部署工具集）

- `tunnel.ps1` — SSH 隧道（远端 8000→本地 8000，含压缩）
- `setup-ssh.ps1` — 一键 SSH 免密配置
- `QwenControlPanel.ps1` — 图形化控制面板（启动/停止隧道、查看状态）
- `start-tunnel.cmd` — 快速启动隧道
- `install-tunnel-autostart.ps1` — 注册 Windows 自启
- `dsh-config/` — DSH profile patch 示例
- `docs/` — vLLM 部署方案、运维 SOP（已脱敏）

## 安全注意事项

- **QQ 凭证（AppID/AppSecret）** 绝不入库，通过 `config/creds.json` 管理（已 gitignore）
- **SSH 密钥** 不入库，首次部署时生成
- **openId 白名单** 限制谁能控制你的电脑
- **DSH 权限模式** 默认 `workspace-write`（受限），`danger-full-access`（全盘）需显式开启
- 建议使用**专用 QQ 号**运行机器人，不要用主力号

## 许可证

MIT（见 LICENSE）
