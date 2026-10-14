# QQ → DSH → Qwen Local Agent System

[中文 README](README.md) | **English README**

Send messages from QQ on your phone, and your home PC (powered by DeepSeek Harness + a local/remote Qwen model) does the work for you: reading files, running scripts, controlling the desktop, deploying services…

> **Fun fact:** this repository was itself organized, sanitized, and set up as a git project *by this very system* — a QQ message told the DSH agent to "make this a GitLab repo," and it did the rest.

```
Phone QQ ──▶ QQ Open Platform ──▶ WebSocket ──▶ Bridge Service (PC) ──▶ dsh headless ──▶ Workspace
                                                        │
                                                        └──▶ SSH Tunnel ──▶ GPU Server (vLLM + Qwen)
```

## Repository Layout

| Directory | Description |
|-----------|-------------|
| `qq-bridge/` | QQ bot bridge service (Node.js) — message handling, DSH agent driver |
| `qwen/` | Qwen model deployment toolkit — vLLM config, SSH tunnel, control panel, autostart |
| `docs/` | Deployment guide (for open-source users) |

## Quick Start

> See [docs/deployment.md](docs/deployment.md) for the full step-by-step guide.

### Prerequisites

1. **A GPU server** (Ubuntu 20.04, ≥ 1× RTX 3090 24GB, or 2 GPUs for tensor parallelism)
2. **A Windows PC** (runs the bridge service + DSH agent)
3. **A QQ Open Platform bot** (created, with AppID + AppSecret)
4. **SSH key-based login** from the Windows PC to the GPU server
5. **DSH (DeepSeek Harness)** installed, with a configured headless profile

### Step 1: Deploy the vLLM Server (on the GPU server)

```bash
# Install vLLM
pip install vllm

# Launch Qwen3.8-27B (2-GPU TP example; drop --tensor-parallel-size for single GPU)
vllm serve /path/to/Qwen3.8-27B \
  --tensor-parallel-size 2 \
  --max-model-len 262144 \
  --enable-prefix-caching \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}' \
  --max-num-batched-tokens 8192 \
  --port 8000
```

Verify:
```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

### Step 2: Set Up the SSH Tunnel (on the Windows PC)

```powershell
# One-shot setup (first time: installs SSH key + tunnel + autostart)
cd qwen
powershell -ExecutionPolicy Bypass -File setup-ssh.ps1 -Server <your-ssh-address>
```

The tunnel maps remote `8000` to local `127.0.0.1:8000`, and `8002` to the thinking-off proxy.

### Step 3: Configure DSH

Add a model entry to your DSH headless profile's `cordis.patch.yml`, pointing to `http://127.0.0.1:8002/v1` (through the thinking-off proxy).

See the example patch files under `qwen/dsh-config/`.

### Step 4: Configure the QQ Bridge

```bash
cd qq-bridge
pnpm install

# Edit config/config.json (see config/config.example.json)
# Fill in your AppID, AppSecret, and openId whitelist

# Start
pnpm start
```

### Step 5 (Optional): Install as a Windows Service

```bash
cd qq-bridge
pnpm task:install
```

## Agent-Assisted Deployment

This project is designed so that a **DSH agent can read the docs and automate most of the deployment**.

Tell the agent:

> "Read docs/deployment.md and help me deploy the Qwen local agent system"

The agent will:
1. Check prerequisites (SSH connectivity, vLLM status, DSH config)
2. Walk you through the steps that require manual action (e.g. installing vLLM on the GPU server)
3. Auto-configure the SSH tunnel, DSH profile, and QQ bridge
4. Run an end-to-end verification (send a test QQ message)

## Architecture

### qq-bridge (QQ Bot Bridge)

```
QQ Open Platform (WebSocket)
    │
    ▼
qq-bridge (Node.js daemon)
    │  ├── Receive message → parse → build DSH task
    │  ├── Drive dsh headless (child process)
    │  ├── Parse agent output → chunked QQ replies
    │  ├── Progress reporting (optional)
    │  ├── File delivery (SEND_FILE marker)
    │  ├── Long-term memory (MEMORY.md injection)
    │  └── Security policies (openId whitelist, write approval)
    ▼
dsh headless (agent child process)
    │  ├── Tool calls (files, shell, MCP, etc.)
    │  └── LLM requests → 127.0.0.1:8002
    ▼
SSH Tunnel → GPU Server → vLLM (Qwen)
```

### qwen (Model Deployment Toolkit)

- `tunnel.ps1` — SSH tunnel with auto-reconnect (remote 8000 → local 8000, with compression)
- `setup-ssh.ps1` — One-shot SSH key setup
- `QwenControlPanel.ps1` — WinForms control panel (start/stop tunnel, check status)
- `start-tunnel.cmd` — Quick tunnel launcher
- `install-tunnel-autostart.ps1` — Register Windows autostart
- `dsh-config/` — DSH profile patch examples
- `docs/` — vLLM deployment guide, ops SOP (sanitized)

## Security Notes

- **QQ credentials (AppID/AppSecret)** are never committed — managed via `config/creds.json` (gitignored)
- **SSH keys** are not committed — generated on first deployment
- **openId whitelist** restricts who can control your PC
- **DSH permission mode** defaults to `workspace-write` (restricted); `danger-full-access` (full disk) must be explicitly enabled
- Use a **dedicated QQ account** for the bot — not your main account

## License

MIT (see LICENSE)
