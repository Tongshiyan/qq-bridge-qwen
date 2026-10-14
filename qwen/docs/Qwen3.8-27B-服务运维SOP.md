# Qwen3.8-27B 本地 Agent 服务 运维 SOP（老四卡机 · 历史归档）

> ⚠️ **本文档已归档，不再是现役运维文档。**
> 2026-10-13 服务已迁移到二卡机 `ac@your-server-ip`。
> 现役文档 → **[Qwen3.8-27B-服务运维SOP-二卡机.md](Qwen3.8-27B-服务运维SOP-二卡机.md)**
> 迁移过程 → **[迁移记录-四卡机到二卡机.md](迁移记录-四卡机到二卡机.md)**
> 本文档保留用于：回滚参考、老机排查、性能调优历史记录（第 8 节仍有价值）。
>
> **老机现状（2026-10-13）**：`qwen38.service` 仍是 enabled，但 `bin/serve.sh` 已加 guard ——
> systemd 拉起会被拒绝（打印提示后 `exit 0`，不加载模型、不占 GPU）；`bin/q38` 已换成 setsid 版，
> 手动启停照旧可用。彻底 `systemctl disable` 需要 sudo 密码。详见 [迁移记录 5.1 节](迁移记录-四卡机到二卡机.md)。

> 部署位置：`ac@ac-Super-Server`（Ubuntu 20.04，2×RTX 3090，驱动 570.172.08）
> 服务：vLLM 0.31.0（cu129 构建）+ Qwen3.8-27B AWQ-INT4，TP=2，262K 上下文，OpenAI 兼容 API
> 监听：`http://127.0.0.1:8000/v1`（只绑回环，靠 SSH 隧道给本地 PC 用）

---

## 0. 速查（最常用）

```bash
q38 start      # 启动服务（后台常驻，关终端不影响）
q38 stop       # 停止服务
q38 restart    # 重启
q38 status     # 看进程 / 端口 / GPU 占用 / systemd 状态
q38 logs       # 实时看日志（Ctrl-C 只退出查看，不停服务）
q38 test       # 跑文本 + 工具调用 + 视觉 三项冒烟测试
q38 fg         # 前台启动（调试用，能直接看到它何时退出）
```

---

## 1. 架构与关键参数

| 项目 | 值 |
|---|---|
| 模型权重 | `/home/ac/qwen3.8-agent/models/Qwen3.8-27B-AWQ-INT4`（19.57 GiB，5 分片，compressed-tensors） |
| 量化 | AWQ-INT4（W4A16），线性注意力层与视觉塔保持 bf16 |
| 并行 | `--tensor-parallel-size 2`（GPU0+GPU1，同 NUMA node 0；**不能用 TP=3**，KV 头只有 4 个） |
| 显存 | 每卡约 21.1 GiB（权重 ~9.8 + KV ~10.25） |
| KV 池 | **285,072 tokens**（≥ 262,144，原生 262K 可用，并发 1.09x） |
| Python 环境 | `/home/ac/envs/qwen38`（3.12.15，uv 创建；torch 2.13.0+cu129 / vllm 0.31.0+cu129） |
| vLLM wheel 来源 | `https://wheels.vllm.ai/0.31.0/cu129`（CUDA 13 的轮子跑不了 570 驱动） |
| 网络 | 外网必须走 `http://127.0.0.1:7890` 代理；hf-mirror 直连不通；Xet 不走代理须禁用 |
| **性能** | **解码 89–131 tok/s**（MTP 投机解码，接受率 80%），TTFT 0.17–0.27s。关键：**不能加 `--enforce-eager`**，要用 CUDA 图 + MTP |
| 无 CUDA toolkit | 本机没有真正的 nvcc（pip 的 `cuda_nvcc` 只有 `ptxas`）。因此：① **不能用 `--enforce-eager`**，改用 `-cc.mode=none -cc.cudagraph_mode=full_and_piecewise`（CUDA 图不需要 nvcc，vLLM 会自动降级为 `FULL_DECODE_ONLY`）② 必须 `VLLM_USE_FLASHINFER_SAMPLER=0`（否则采样器 JIT 编译报 nvcc 错并让引擎崩溃） |
| 服务方式 | systemd 系统服务 `qwen38.service`（User=ac，开机自启、崩溃自动重启） |

---

## 2. 目录与文件清单

```
/home/ac/qwen3.8-agent/
├── env.sh                     # 环境变量（被 serve.sh 引用）
├── bin/
│   ├── serve.sh               # 真正的启动命令（所有 vLLM 参数都在这里）
│   ├── q38                    # 运维命令（start/stop/restart/status/logs/test/fg）
│   ├── smoke_api.py           # 三项冒烟测试
│   └── restart.sh             # 旧脚本（可忽略）
├── logs/serve.log             # 服务日志（systemd 直接追加到这里）
├── models/Qwen3.8-27B-AWQ-INT4/
└── cache/hf/                  # HF 缓存
/etc/systemd/system/qwen38.service
/etc/sudoers.d/qwen38          # 免密 start/stop/restart
```

---

## 3. 一次性安装（复制整块到服务器执行）

> 需要输入一次 sudo 密码。

```bash
set -e
P="$HOME/qwen3.8-agent"
mkdir -p "$P/bin" "$P/logs"

# ---------- env.sh ----------
cat > "$P/env.sh" <<'EOF'
export PROJECT="$HOME/qwen3.8-agent"
export VENV="$HOME/envs/qwen38"
export CUDA_VISIBLE_DEVICES=0,1          # 双卡 TP=2（GPU0+GPU1 同 NUMA 节点）
export NCCL_P2P_DISABLE=1                # 3090 无 NVLink、PCIe P2P 不可用
export HF_HOME="$PROJECT/cache/hf"
export HF_HUB_DISABLE_XET=1              # Xet 客户端不走代理
export HF_HUB_DOWNLOAD_TIMEOUT=60
export VLLM_USE_FLASHINFER_SAMPLER=0     # 本机无 nvcc，FlashInfer 采样器会在请求时 JIT 编译并 500
export PATH="$VENV/bin:$HOME/.local/bin:$PATH"
# 剔除 /usr/local/anaconda3/bin（root:anaconda 750，ac 不可遍历，
# 留着会让 nvcc 等查找报 "Permission denied" 而不是 "not found"）
export PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/usr/local/anaconda3' | awk '!seen[$0]++' | paste -sd:)"
# 外网必须走 shell 预设代理，不要 unset proxy 变量
EOF

# ---------- serve.sh ----------
cat > "$P/bin/serve.sh" <<'EOF'
#!/usr/bin/env bash
source "$HOME/qwen3.8-agent/env.sh"
DIR="$PROJECT/models/Qwen3.8-27B-AWQ-INT4"

exec "$VENV/bin/vllm" serve "$DIR" \
  --served-model-name qwen3.8-27b \
  --host 127.0.0.1 --port 8000 \
  --api-key local-any-string \
  --tensor-parallel-size 2 \
  --dtype bfloat16 \
  --max-model-len 262144 \
  --gpu-memory-utilization 0.92 \
  --max-num-seqs 4 \
  -cc.mode=none -cc.cudagraph_mode=full_and_piecewise \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}' \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --disable-custom-all-reduce \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3
EOF

# ---------- q38 运维命令 ----------
cat > "$P/bin/q38" <<'EOF'
#!/usr/bin/env bash
# 用法: q38 {start|stop|restart|status|logs|test|fg}
set -u
PROJECT="$HOME/qwen3.8-agent"
UNIT=qwen38
SC="sudo -n /usr/bin/systemctl"

have_unit() { systemctl list-unit-files 2>/dev/null | grep -q "^${UNIT}\.service"; }

case "${1:-status}" in
  start)
    if have_unit; then
      $SC start $UNIT && echo "✅ 已启动（systemd，后台常驻）" \
        || echo "❌ 需要密码，请手动执行: sudo systemctl start $UNIT"
    else
      source "$PROJECT/env.sh"; mkdir -p "$PROJECT/logs"
      pkill -f "vllm serve" 2>/dev/null; sleep 2
      setsid nohup "$PROJECT/bin/serve.sh" > "$PROJECT/logs/serve.log" 2>&1 < /dev/null &
      echo "✅ 已后台启动 pid=$!（无 systemd，用的 setsid）"
    fi ;;
  stop)
    if have_unit; then
      $SC stop $UNIT && echo "✅ 已停止" || echo "需要密码: sudo systemctl stop $UNIT"
    else
      pkill -f "vllm serve" && echo "✅ 已停止" || echo "(没有在跑)"
    fi ;;
  restart)
    "$0" stop; sleep 3; "$0" start ;;
  status)
    if have_unit; then systemctl status $UNIT --no-pager -l 2>/dev/null | head -18; else
      pgrep -af "vllm serve" || echo "(没有在跑)"
    fi
    echo "--- 端口 8000 ---"; ss -ltn 2>/dev/null | grep 8000 || echo "(未监听)"
    echo "--- GPU ---"; nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader
    echo "--- API ---"
    code=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/v1/models \
             -H "Authorization: Bearer local-any-string" 2>/dev/null || echo 000)
    echo "HTTP $code" ;;
  logs) tail -f "$PROJECT/logs/serve.log" ;;
  test) source "$PROJECT/env.sh"; python "$PROJECT/bin/smoke_api.py" ;;
  fg)   source "$PROJECT/env.sh"; exec "$PROJECT/bin/serve.sh" ;;
  *)    sed -n '2p' "$0" ;;
esac
EOF

chmod +x "$P/bin/serve.sh" "$P/bin/q38"

# ---------- 三项冒烟测试 ----------
cat > "$P/bin/smoke_api.py" <<'EOF'
import base64, json, os, sys, urllib.request
BASE, KEY, MODEL = "http://127.0.0.1:8000/v1", "local-any-string", "qwen3.8-27b"

def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.load(r)

def chat(**kw):
    kw.setdefault("chat_template_kwargs", {"enable_thinking": False})
    return post("/chat/completions", {"model": MODEL, **kw})

print("=== 1) 纯文本 ===")
r = chat(messages=[{"role":"user","content":"用一句话说明什么是张量并行。"}], max_tokens=128)
print("content:", (r["choices"][0]["message"].get("content") or "")[:300])

print("\n=== 2) 工具调用（agent 的命门）===")
r = chat(messages=[{"role":"user","content":"北京现在天气怎么样？"}],
    tools=[{"type":"function","function":{"name":"get_weather","description":"查询某城市当前天气",
      "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
    tool_choice="auto", max_tokens=256)
ch = r["choices"][0]
print("finish_reason:", ch.get("finish_reason"))
print("tool_calls:", json.dumps(ch["message"].get("tool_calls"), ensure_ascii=False)
      if ch["message"].get("tool_calls") else "❌ 无 tool_calls（parser 有问题）")

print("\n=== 3) 视觉 ===")
img = "/tmp/test_img.png"
if not os.path.exists(img):
    print("缺测试图，跳过。可先执行：curl -sSL -o /tmp/test_img.png "
          "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/coco_sample.png")
    sys.exit(0)
b64 = base64.b64encode(open(img,"rb").read()).decode()
r = chat(messages=[{"role":"user","content":[
    {"type":"image_url","image_url":{"url":f"data:image/png;base64,{b64}"}},
    {"type":"text","text":"这张图里有什么？用一句话回答。"}]}], max_tokens=200)
print("content:", (r["choices"][0]["message"].get("content") or "")[:300])
EOF

# ---------- 快捷别名 ----------
grep -q "alias q38=" "$HOME/.bashrc" || echo "alias q38='bash \$HOME/qwen3.8-agent/bin/q38'" >> "$HOME/.bashrc"

# ---------- systemd 单元 ----------
sudo tee /etc/systemd/system/qwen38.service > /dev/null <<'EOF'
[Unit]
Description=Qwen3.8-27B AWQ-INT4 vLLM server (TP=2, 2x RTX 3090)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ac
Group=ac
WorkingDirectory=/home/ac/qwen3.8-agent
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
KillSignal=SIGINT
StandardOutput=append:/home/ac/qwen3.8-agent/logs/serve.log
StandardError=append:/home/ac/qwen3.8-agent/logs/serve.log
ExecStart=/home/ac/qwen3.8-agent/bin/serve.sh

[Install]
WantedBy=multi-user.target
EOF

# ---------- 免密 start/stop/restart ----------
echo 'ac ALL=(root) NOPASSWD: /usr/bin/systemctl start qwen38, /usr/bin/systemctl stop qwen38, /usr/bin/systemctl restart qwen38' \
  | sudo tee /etc/sudoers.d/qwen38 > /dev/null
sudo chmod 440 /etc/sudoers.d/qwen38

sudo systemctl daemon-reload
sudo systemctl enable qwen38

echo
echo "==== 安装完成 ===="
echo "以后用:  source ~/.bashrc  &&  q38 start"
```

---

## 4. 日常操作

| 目的 | 命令 | 说明 |
|---|---|---|
| 启动 | `q38 start` | 后台常驻，**关终端/退出 SSH 都不影响**；开机自启 |
| 停止 | `q38 stop` | 优雅关闭（SIGINT），等待最多 120 秒 |
| 重启 | `q38 restart` | 改完 `serve.sh` 后用它 |
| 状态 | `q38 status` | systemd 状态 + 端口 + GPU 占用 + API 状态码 |
| 日志 | `q38 logs` | `tail -f`，Ctrl-C 只退出查看 |
| 测试 | `q38 test` | 文本 / 工具调用 / 视觉 三项 |
| 前台调试 | `q38 fg` | 直接看输出，能立刻发现"何时退出、为什么退出" |

**关键点**：服务由 systemd 托管，`Restart=on-failure` + `RestartSec=10` —— 进程意外退出会在 10 秒后自动重启；连续崩溃时用 `q38 logs` 看原因。

---

## 5. 健康检查与冒烟测试

```bash
# 1) 状态总览
q38 status

# 2) 就绪后（首次启动约 3–8 分钟）确认关键指标
grep -nE "GPU KV cache size|Available KV cache|Uvicorn running|Loading weights took|ERROR" \
  ~/qwen3.8-agent/logs/serve.log | tail -15

# 3) 三项功能测试
q38 test
```

**通过标准**

| 项 | 期望 | 已实测结果（2026-10-11） |
|---|---|---|
| 端口 | `LISTEN 127.0.0.1:8000` | ✅ |
| API | `HTTP 200` | ✅ |
| KV | `GPU KV cache size: 333,637 tokens`（≥ 262144） | ✅ |
| 文本 | 打印出中文回答 | ✅ "张量并行是指将神经网络中单个大矩阵（权重）沿特定维度切分到多个计算设备…" |
| **工具调用** | `finish_reason: tool_calls`，`tool_calls` 内含 `get_weather` 和 `"city": "北京"` | ✅ `get_weather({"city": "北京"})` |
| 视觉 | 能描述图片内容 | ✅ "图中有两只正在粉色沙发上睡觉的猫和两个遥控器。" |

---

## 6. 本地 PC 接入 DeepSeek Harness

### 6.1 建 SSH 隧道（在 Windows 本地开一个窗口，保持不关）

```powershell
ssh -N -L 8000:127.0.0.1:8000 `
    -o ServerAliveInterval=30 `
    -o ServerAliveCountMax=3 `
    -o ExitOnForwardFailure=yes `
    ac@<服务器地址>
```

### 6.2 DSH 里配置自定义 provider

**设置 → 模型 → 添加模型提供商 → 添加方式选「自定义模型 API」**

| 字段 | 值 |
|---|---|
| API 地址 | `http://127.0.0.1:8000/v1` |
| 协议 | `OpenAI Chat Completions` |
| 模型 | `qwen3.8-27b` |
| 路由 id | `qwen38-local` |
| API 密钥 | `local-any-string` |

保存后在会话模型选择器里选 `qwen3.8-27b`。

### 6.3 本地验证隧道

```powershell
curl.exe http://127.0.0.1:8000/v1/models -H "Authorization: Bearer local-any-string"
```

### 6.4 隧道必须加 `-C`（实测：这是客户端侧 TTFT 的最大瓶颈）

**关键实测（2026-10-12）**：这台 PC 经 aTrust VPN 到服务器的**上行只有 3–15 KB/s**，而 DSH 每一步都会把**整个会话上下文重新上传**（10 万 token ≈ 400–500 KB JSON）。所以客户端感受到的"TTFT 很高"，**大部分是上传耗时，不是服务端 prefill**：

| 场景 | 未加 -C | 加 -C |
|---|---|---|
| 同一请求端到端 | **81.5 s** | **3.5 s** |
| 256 KB 文本上传 | 4.5 KB/s | 38.7 KB/s |

> 这也解释了为什么服务端回环上测出的 TTFT（0.6–2 s）和实际体感对不上——服务端测试完全覆盖不到这段慢速上行。`tunnel.ps1` 已内置 `-C`。

### 6.5 隧道开机自启（Windows，本机已配置）

任务名 **`qwen-stack-autostart`**：登录后 20 秒启动，之后**每 10 分钟自愈重跑一次**（谁掉线补谁）。执行的是
`Desktop\dsh-stock\qq-bridge\scripts\start-all.ps1`（幂等：先等网络就绪 → 起隧道守护 → 起 QQ 桥接）。

```powershell
# 查看状态（任务状态 + 隧道进程 + 守护进程 + 8000 端口）
powershell -ExecutionPolicy Bypass -File %QWEN_DIR%\install-tunnel-autostart.ps1 -Action status

# 卸载自启（不影响正在运行的隧道）
powershell -ExecutionPolicy Bypass -File %QWEN_DIR%\install-tunnel-autostart.ps1 -Action uninstall
```

要点：注册在**当前用户**下、交互式、免管理员（`RunLevel=Limited`）；`MultipleInstances=IgnoreNew` 防重复；
`ExecutionTimeLimit=PT0S` 不限时。`start-all.ps1` 与 `tunnel.ps1` **必须保持纯 ASCII**——PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 读，中文会把脚本解析搞崩。

---

## 7. 故障排查

### 7.1 服务起不来 / 起完就退出

```bash
q38 logs                      # 看最后几十行
grep -nE "ERROR|Traceback|raise |OutOfMemory" ~/qwen3.8-agent/logs/serve.log | tail -30
```

| 日志特征 | 原因 | 处理 |
|---|---|---|
| `InductorError ... Permission denied: 'nvcc'` | torch.compile 需要 nvcc，本机没有真正的 nvcc | **不要用 `--enforce-eager` 去躲**（会掉 6 倍速度）；用 `-cc.mode=none -cc.cudagraph_mode=full_and_piecewise`，只开 CUDA 图、不开 torch.compile |
| `torch.OutOfMemoryError`（CUDA graph 阶段） | 图捕获超显存 | 降 `--gpu-memory-utilization`（0.92 → 0.90）或降 `--max-model-len`；**不要**加 `--enforce-eager` |
| `max seq len ... larger than ... KV cache` | KV 池装不下 | 把 `--max-model-len 262144` 改成 `131072` |
| `libnvrtc.so.13` / `libcudart.so.13` | 又混进一个 CUDA 13 的依赖包 | `uv pip freeze \| grep -i cu13` 找出来，卸载或换 cu129 版（参考 torchcodec 的处理） |
| `Address already in use` | 旧进程还占着 8000 | `q38 status` → `q38 stop` → 再 `q38 start` |
| 显存被占满但没有进程 | 僵死的 worker | `pkill -f "vllm serve"`，等 5 秒，`nvidia-smi` 确认释放 |

### 7.2 请求返回 HTTP 500（服务活着但请求失败）

```bash
tail -80 ~/qwen3.8-agent/logs/serve.log          # 真正的 traceback 在这里
python -c "import transformers; print(transformers.__version__)"   # recipe 要求 >= 5.8.0
```

常见原因与处理：

1. **【本机已踩过】`Could not find nvcc and default cuda_home='/usr/local/cuda' doesn't exist`**
   出现在 `flashinfer/jit/cpp_ext.py` → FlashInfer 的 top-k/top-p **采样器**要在请求时 JIT 编译 CUDA kernel，而本机没有 CUDA toolkit（`--enforce-eager` 管不到它）。
   处理：`env.sh` 里设 `export VLLM_USE_FLASHINFER_SAMPLER=0`，退回 PyTorch 原生采样器，然后 `q38 restart`。
   注意：该错误会让 **EngineCore 致命崩溃**（HTTP 500 + 服务自动重启），所以务必配上 systemd 的 `Restart=on-failure`。

2. **`transformers` 版本 < 5.8.0**（官方 recipe 的硬前提；本机已是 5.17.0，无需处理）→ 升级后重启：
   ```bash
   uv pip install --python "$VENV/bin/python" \
     --index-url https://pypi.tuna.tsinghua.edu.cn/simple "transformers>=5.8.0"
   q38 restart
   ```
3. **请求里的 `chat_template_kwargs` / tools 参数** 触发模板渲染问题 → 先用最小请求验证：
   ```bash
   curl -sS -m 120 http://127.0.0.1:8000/v1/chat/completions \
     -H "Content-Type: application/json" -H "Authorization: Bearer local-any-string" \
     -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
   ```
4. **`--reasoning-parser qwen3` 解析出错** → 临时从 `serve.sh` 去掉该参数重启（思考内容会进正文）。

### 7.3 下载模型（如需换仓库）

```bash
source ~/qwen3.8-agent/env.sh
hf download <repo> --local-dir "$PROJECT/models/<名字>" --max-workers 8
```

- 必须走代理（直连不通）；已设 `HF_HUB_DISABLE_XET=1`
- 断点续传：重跑同一条命令即可
- 网络抖动严重时，用逐文件 curl 方式（`-C -` 续传）

---

## 8. 性能记录与可选优化

### 8.1 性能优化记录（2026-10-11，已达预期）

| 配置 | 解码速度 | 说明 |
|---|---|---|
| `--enforce-eager`（最初的错误配置） | **9.2 tok/s** | 关掉了 CUDA 图，每 token 上千次 kernel 启动开销全暴露 |
| `-cc.mode=none -cc.cudagraph_mode=full_and_piecewise` | **58.6–60 tok/s** | **6.4× 提速**，与社区同配置实测 57–63 tok/s 一致 |
| **上面 + `--speculative-config '{"method":"mtp","num_speculative_tokens":3}'`（当前）** | **88.9（短）/ 131.5（长）tok/s** | 再 **2.24×**（长输出）。草稿接受率 80.1%，平均接受长度 3.40 |

MTP 实测数据（`grep SpecDecoding logs/serve.log`）：
```
Mean acceptance length: 3.40, Per-position acceptance rate: 0.896, 0.798, 0.710,
Avg Draft acceptance rate: 80.1%
```
代价：KV 池 329,025 → 285,072 tokens（仍远超 262,144）；显存每卡 21,136 → 21,148 MiB；启动约 130 秒。

诊断要点（下次遇到类似问题可直接套用）：
1. `bench.py` 测出 9 tok/s 后，采样 `nvidia-smi` 发现 GPU 功耗仅 130–177 W / 350 W、利用率在两卡间来回跳 → **不是在算，是在等**（启动开销/同步）。
2. 硬件天花板核算：权重流量 9.8 GB/卡/token → 上限约 95 tok/s；GDN 循环状态流量仅 144 MB/token（可忽略）→ 说明差距全是开销，不是算力。
3. 根因：`--enforce-eager` 同时关掉了 torch.compile **和 CUDA 图**。GDN（48 层线性注意力）在 eager 下退化为 Python 逐算子派发。
4. 把 `--enforce-eager` 换成 `-cc.mode=none -cc.cudagraph_mode=full_and_piecewise`：既避开需要 nvcc 的 torch.compile，又拿回 CUDA 图。vLLM 自动把模式降级为 `FULL_DECODE_ONLY`（最稳）。

### 8.2 上下文窗口与 TTFT 实测（2026-10-11）

**上下文窗口 = 262,144 tokens，实测无误**（模型自称"约 128K"是幻觉，不要信）：

| 验证项 | 结果 |
|---|---|
| vLLM 上报 | `max_model_len = 262144` |
| DSH 侧认定 | `contextPressure.contextWindow = 262144` |
| **实测最长请求** | **240,012 tokens 被完整接受并正确回答**（TTFT 55s） |
| KV 池 | 279,722 tokens（≥ 262,144） |

**TTFT 实测（当前配置：CUDA 图 + MTP）**：

| 场景 | TTFT |
|---|---|
| 20K 上下文，全新前缀（冷） | **8.2 s** |
| 20K 上下文，命中 prefix cache（热） | **0.70 s**（**11.7×**） |
| 多轮 agent 对话（前缀稳定，第 3–6 轮） | **1.8 – 2.1 s** |
| 一旦改动 system prompt（前缀失效） | 6.5 s |
| 240K 上下文 | 55 s |

**关键结论：TTFT 主要取决于「前缀是否稳定」，而不是服务端参数。**

预填充吞吐约 2,600 tok/s（冷），因此 TTFT ≈ 上下文长度 / 2600 + 0.2s。
`--max-num-batched-tokens` 从 2048（MTP 默认压制）提到 8192 实测**几乎无差别**，但可消除启动警告，保留即可。

**解码速度随上下文衰减**（实测，温度 0，thinking off，每次唯一前缀）：

| 上下文长度 | 冷 TTFT | 解码速度 |
|---|---|---|
| 1,845 | 1.20 s | **92.7 tok/s** |
| 7,388 | 4.57 s | 65.9 tok/s |
| 14,779 | 9.34 s | 50.4 tok/s |
| 29,540 | 19.55 s | 60.8 tok/s |
| 59,083 | 42.41 s | 38.6 tok/s |
| 73,846 | 55.19 s | **32.7 tok/s** |

原因：每生成一个 token 都要把全部 KV 读一遍（64 KB/token × 上下文长度），74K 上下文时每卡需读约 2.4 GB，再叠加 16 层全注意力的计算量。48 层线性注意力是常数成本，所以衰减是平缓的而非断崖。
**实践建议：把上下文控制在 10–20K（此时解码 50–66 tok/s、热 TTFT <1s）；长文档任务单独开会话。**

**缓存命中查看方式（2026-10-12 新增）**：
vLLM 默认 **不返回**缓存 token 数，客户端因此显示 0。启动参数加上 `--enable-prompt-tokens-details` 后，响应会带：

```json
"prompt_tokens_details": {"cached_tokens": 6400, "created_cache_tokens": 0}
```

实测同一 7,219-token 请求：冷 4.61 s（cached 0 / created 6400）→ 热 **0.64 s**（cached 6400 / created 0），**7.2×**。
服务端引擎日志里一直有真实命中率，可直接查：

```bash
grep -o "Prefix cache hit rate: [0-9.]*%" ~/qwen3.8-agent/logs/serve.log | tail -3
# 实测稳定在 73% 以上；带图请求另有 MM cache hit rate
```


**可用的改进手段（按收益排序）**：

1. **保持前缀稳定**（收益最大，11.7×）：不要在 system prompt 开头放时间戳、随机 ID、动态文件列表等每次变化的内容。DSH 的 system prompt = persona + agent-instructions + 工作目录；`AGENTS.md` 内容不变就不影响。
2. **控制上下文增长**：TTFT 与长度线性相关（20K→8s、40K→16s）。用 DSH 的压缩/新开会话控制；长文档任务单独开新会话。
3. **思考模式**：**本实验室保留开启**（质量优先）。代价是输出 token 增加约 30–100%（实测 43 → 85 token），影响的是总时长而非 TTFT。
   如需在某次请求中临时关闭，客户端传 `"chat_template_kwargs": {"enable_thinking": false}` 即可。
   vLLM 0.31 不支持 `--default-chat-template-kwargs`，因此服务端无法全局设置。
4. **精简工具集**：DSH `standard` preset 的工具 schema 占 **6,415 token**（system prompt 只有 1,982）。它是稳定前缀，只在首次请求付费；切换到 `minimal` preset 可降到约 1.5K，缩短新会话首轮 TTFT。
5. **（可选，投入产出比一般）** 装真 nvcc + 打开 torch.compile，可能再提 prefill 20–30%。

---

### 8.4 MTP 投机解码 vs 上下文长度：双模式方案（2026-10-12 实测）

**结论：MTP 只在短中上下文划算，长上下文会严重拖慢解码。**

三配置在同一台机器、同样上下文长度下实测（温度 0、thinking off、每次唯一前缀）：

| 配置 | 1.8K 上下文 | 27.7K | **69.2K** |
|---|---|---|---|
| **MTP 关闭** | 59.7 tok/s | **58.8** | **56.5** |
| MTP=1 | 66.8 | 34.9 | 18.0 |
| **MTP=3** | **95.4** | 62.4 | 20.4 |

- 关掉 MTP 后解码速度**几乎不随上下文衰减**（59.7 → 56.5）
- 开 MTP=3 时从 95 掉到 20（69K 时**慢 2.8 倍**）
- 交叉点在 **35–45K** 之间；MTP=1 在各长度都不占优，已排除

**原因**：投机解码每个 step 要验证 K+1 个位置，注意力计算量按 (K+1) 增长；上下文越长，注意力在总开销中占比越高，验证成本最终超过投机收益。

**因此采用双模式**（两条命令切换，切换含重启，约 2 分钟）：

```bash
bash ~/qwen3.8-agent/bin/q38mode short    # 短上下文模式：MTP=3（1.8K:95 / 27K:62 tok/s）
bash ~/qwen3.8-agent/bin/q38mode long     # 长上下文模式：关 MTP（全程 56-59 tok/s）
bash ~/qwen3.8-agent/bin/q38mode status   # 查看当前模式
```

两套启动脚本：`~/qwen3.8-agent/bin/serve.short.sh` 与 `serve.long.sh`（由 `install_modes.sh` 生成，勿手改）。

**怎么选**：
| 使用场景 | 用哪个 |
|---|---|
| 日常问答、代码、多轮 agent（上下文 ≤30K） | `short`（MTP=3） |
| 整篇文档/大仓库分析（上下文 50K+） | `long`（关 MTP） |
| 不确定 | 用 `short`，配合 DSH 压缩把上下文压在 30K 内 |

---

### 8.5 后续可选优化

| 目标 | 做法 | 预期收益 | 风险 |
|---|---|---|---|
| 提高 spec tokens 数 | `num_speculative_tokens` 3 → 4（逐位置接受率 0.896/0.798/0.710，第 4 位估计 ~0.6） | 短上下文长输出可能再快约 15% | 长上下文会更慢，需实测 |
| 提高 prefill 批大小 | **已完成**（`--max-num-batched-tokens 8192`） | 消除启动 WARNING | — |
| 尝试 torch.compile | 装真 nvcc，把 `-cc.mode=none` 改成 `-cc.mode=piecewise` | prefill 可能再快 20–30% | 首次启动编译 10–30 分钟；有 nvcc 相关报错风险 |
| 精简工具集 | DSH 会话切换到 `minimal` agent preset | 工具 schema 6.4K → ~1.5K token，新会话首轮更快 | 失去专用文件工具（仍可用 shell） |
| 关闭思考模式 | 客户端传 `"chat_template_kwargs": {"enable_thinking": false}` | 输出 token 省约 30% | **本实验室已决定保留思考模式，不采用此项**（质量优先；且思考只增加总时长，不影响 TTFT —— 实测开启时首字节 0.82s 与关闭时 0.20s 同级） |
| 精确控制 KV 显存 | 用 `--kv-cache-memory <bytes>` 替代 `--gpu-memory-utilization`（仅 CLI 支持） | 启动日志会直接给出建议值 | 低 |
| 多一个模型实例 | GPU2 目前空闲，可再起一个服务跑 embedding/rerank 或小模型 | 子代理/杂活不占主模型 | 需重新规划显存 |
| 开机免登录 | `sudo systemctl enable qwen38`（安装时已做） | 服务器重启后自动可用 | 无 |

---

## 9. 附：不依赖脚本的原始命令

```bash
# 启动（前台，调试用）
source ~/qwen3.8-agent/env.sh
~/qwen3.8-agent/bin/serve.sh

# 停止
pkill -f "vllm serve"

# 看日志
tail -f ~/qwen3.8-agent/logs/serve.log

# 单独测 API
curl -sS http://127.0.0.1:8000/v1/models -H "Authorization: Bearer local-any-string"
```
