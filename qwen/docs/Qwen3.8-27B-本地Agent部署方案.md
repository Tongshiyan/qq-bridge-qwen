# Qwen3.8-27B 私有 Agent 部署方案（3×RTX 3090 + 本地 DeepSeek Harness）

> 结论：**可行，而且是当前性价比很高的组合。**
> 计算（27B 推理）放服务器，工具执行/文件/沙箱留在本地 PC，DSH 通过"自定义模型 API"接远程 OpenAI 兼容端点。
> 唯一需要打破的直觉是：**3 张卡不等于 TP=3**——这个模型的 KV 头数是 4，张量并行只能取 1/2/4，所以正确姿势是 **TP=2 跑模型 + 第 3 张卡做别的**。

---

## 1. 可行性核对（两端都已确认）

### 服务端：能跑
- Qwen3.8-27B 是 27B **稠密**原生视觉语言模型，Apache-2.0，64 层，原生上下文 262,144，可 YaRN 扩到 1M。
- 关键结构：**48 层线性注意力 + 16 层全注意力**（每 4 层 1 层全注意力），只有那 16 层留 KV Cache。
  - 每 token KV ≈ **64 KB**（fp16），是传统 64 层稠密模型的 1/4 → 长上下文非常便宜（128K ≈ 8 GB）。
  - 这也是 27B 能吃下 agent 长会话的原因。
- 注意力形状：24 个 Q 头、**4 个 KV 头**、head_dim 256、词表 248,320。
- 社区已在**双 3090 无 NVLink** 环境跑通（SGLang 0.5.17 + AWQ-INT4），基础解码约 57–63 tok/s，推测解码下代码/JSON 场景可达 170–210 tok/s。

### 本地端：DSH 原生支持接自部署端点（已在本机安装包内验证）
在本机 `D:\softwares\dsh\resources\app.asar` 的 DSH 0.2.0-rc.2 里确认：
- 组件 `dsh-llm-pi-ai` 内置 `@earendil-works/pi-ai`，实现了 `openai-completions`、`openai-responses`、`anthropic-messages` 三种协议。
- 设置界面 `dsh-client-ui-settings-models` 有"**自定义模型 API**"卡片，官方文案：
  > "连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。"
- 写入的配置结构（settings 命名空间 `llm-pi-ai`）：

```yaml
llm-pi-ai:
  providers:
    qwen38-local:                 # 路由 id，必须匹配 ^[a-z][a-z0-9]*(-[a-z0-9]+)*$
      api: openai-completions
      baseURL: http://127.0.0.1:8000/v1
      models:
        - id: qwen3.8-27b         # 必须等于服务端 --served-model-name
      apiKeyEnv: QWEN38_LOCAL     # 可选：vLLM 不设 --api-key 时可不填
```

所以链路是：**DSH（本地 GUI/工具/文件/沙箱） → HTTP → SSH 隧道 → vLLM（服务器 3×3090）**。
文件读写、pwsh、沙箱、workspace 全部留在本地，只有 token 生成在服务器。

---

## 2. 量化版本怎么选（3090 = Ampere SM86）

| 方案 | 体积 | 3×3090 可行性 | 结论 |
|---|---|---|---|
| **AWQ-INT4**（W4A16, group 128, compressed-tensors） | ~19.6–21 GB | ✅ TP=2 轻松放下 | **首选**：Ampere 走 AWQ-Marlin 内核，带宽换速度最划算 |
| GPTQ-Int4 | ~20 GB | ✅ TP=2 | 次选，同样走 Marlin，质量与 AWQ 基本同级 |
| INT8 W8A8 | ~28 GB | ✅ TP=2（每卡 14 GB，KV 余量变小） | 质量优先档，速度比 INT4 慢约 30–40% |
| 官方 FP8（`Qwen/Qwen3.8-27B-FP8`） | 28.75 GB | ❌ 不推荐 | 3090 **没有 FP8 张量核**，拿不到加速，白占显存 |
| NVFP4 / MXFP4 | ~16 GB | ❌ | 需要 Ada/Blackwell（sm89+/sm100） |
| GGUF Q4_K_M / Q5_K_M | 17.1 / 19.8 GB | ✅ 但走 llama.cpp | 无张量并行、并发弱；视觉要额外 mmproj。**作为回退/单卡方案** |
| BF16 全量 | 51.75 GB | ❌ | TP=3 不被支持，TP=2 又放不下（2×24 GB < 52 GB + KV） |

**一句话：服务器端就用 AWQ-INT4（或 GPTQ-Int4），不要 FP8。**

带宽 sanity check：3090 单卡 936 GB/s，TP=2 理论 1872 GB/s ÷ 20 GB 权重 ≈ 93 tok/s 上限，社区实测 57–63 tok/s（有效利用率 ~65%），数字自洽。

---

## 3. 三卡怎么排（重点）

`--tensor-parallel-size 3` **会失败**：Q 头 24÷3=8 可以整除，但 **KV 头 4÷3 不整除**。社区里 3090/4090 的实测清一色是 TP=2 或 TP=4，没有 TP=3，原因就在这里。

推荐布局：

```
GPU0 + GPU1  ──(有 NVLink 桥就桥接这对)──  一个 vLLM 实例，TP=2，AWQ-INT4
                                             128K 上下文，prefix caching 常开
GPU2         ──  三选一：
                ① 27B 的第二副本（TP=1，32K 上下文）→ 给 DSH 子代理/并行会话用
                ② 一个轻量模型（8B/14B AWQ）→ 子代理、会话标题、压缩摘要，省下 27B 的算力
                ③ embedding / rerank（bge-m3、Qwen3-Embedding）+ 视觉编码器
```

- DSH 的子代理**可以单独指定模型**（设置里有 Subagent 模型项），所以布局 ② 很实用：主 Agent 用 27B，杂活丢给 GPU2 上的小模型。
- 3090 支持 NVLink 桥但只能两两配对，所以 3 张卡最多桥住一对。
- 功耗提醒：3×3090 ≈ 1050 W TDP，不含 CPU/盘。需要 1600 W 级电源 + 机箱风道（服务器上用涡轮卡最省事）。

---

## 4. 服务端部署（vLLM 基线命令）

先跑**32K 上下文基线**，稳住之后再往上加（不要一上来就 262K）。

```bash
# 无 NVLink / 走 PCIe 时先禁 P2P，避免 NCCL 卡住
export NCCL_P2P_DISABLE=1

vllm serve /models/Qwen3.8-27B-AWQ-INT4 \
  --served-model-name qwen3.8-27b \
  --host 0.0.0.0 --port 8000 \
  --api-key local-any-string \
  --tensor-parallel-size 2 \
  --dtype bfloat16 \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.92 \
  --max-num-seqs 4 \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3
```

要点说明：

1. **`--tool-call-parser qwen3_coder` 是 agent 场景的关键一参数。**
   vLLM 里 Qwen3 系有两个 parser，标签一样但实现不同：`qwen3_xml` 用真 XML 解析器校验，参数值里出现未转义的 `<`、`&`、引号（shell 命令、JSON 的日常）就报 `not well-formed`，整条工具调用作废、模型重试，体感又慢又不稳；`qwen3_coder` 走正则，宽松收下。社区实测：同一套环境只换 parser，94 次解析错误 → 0 次。
   注意官方 recipe 还在 `qwen3_xml` / `qwen3_coder` 之间摇摆，所以**以你日志为准**。
2. **`--enable-prefix-caching` 对 agent 是刚需。** 系统提示词 + 工具 schema 每轮都一样，缓存命中后只预填充新增的增量，首 token 延迟能差一个量级。
3. **`--reasoning-parser qwen3`** 让思考内容进 `reasoning_content` 而不是正文（模型默认开思考，支持 `reasoning_effort` 与 `preserve_thinking`）。
4. `--quantization compressed-tensors`：如果用 compressed-tensors 打包的 AWQ 仓库需要显式指定，经典 AWQ 仓库通常自动识别；报错再加。
5. 量化仓库候选（用前核对模型卡是否标注兼容 Qwen3.8 + 当前引擎版本）：
   - `cyankiwi/Qwen3.8-27B-AWQ-INT4`、`barrydeen/Qwen3.8-27B-AWQ-4bit`
   - `igor255/Qwen3.8-27B-AWQ-INT4-H8-MTP4`（带 MTP 草稿头，见下）
   - `soyrsoyr/Qwen3.8-27B-W4A16-AWQ-GPTQ`（有 4×3090 / TP4 / 256K 的实测记录）

### 长上下文（确实需要再开）

```bash
export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1
# --max-model-len 131072 起，配合 YaRN hf-overrides：
#   rope_scaling: { rope_type: yarn, factor: 4.0,
#                   original_max_position_embeddings: 262144 }
```
静态 YaRN 会损伤短文本表现——只有业务真的超原生上下文才开。

### 加速（基线稳定后再做）
Qwen3.8 带 **MTP（多 token 预测）头**，可用投机解码换 2–3× 解码速度，社区在代码/JSON 场景报 170–210 tok/s。vLLM 的投机解码配置项随版本变化（`--speculative-config` / method 名），**用你的 vLLM 版本手册核对后再开**，并且先留一份无投机的对照基线。

### 等价替代
SGLang 也有双 3090 的成熟配方（`--tp-size 2 --quantization compressed-tensors --mem-fraction-static 0.8 --disable-custom-all-reduce --mm-feature-transport cpu`，WSL2 下还要靠 `--mm-feature-transport cpu` 绕过 CUDA IPC 的 `pidfd_getfd` 故障）。要跑视觉输入时 SGLang 的多模态参数更成熟。

---

## 5. 本地侧接线

### 5.1 SSH 隧道（Windows 自带 OpenSSH）

```powershell
ssh -N -L 8000:127.0.0.1:8000 `
    -o ServerAliveInterval=30 `
    -o ServerAliveCountMax=3 `
    -o ExitOnForwardFailure=yes `
    user@your-server
```

- 端口只映射到本地回环，服务器 vLLM 可以只监听 `127.0.0.1`，比暴露公网安全得多。
- 想要断线自愈 / 免隧道，用 Tailscale 或 WireGuard 直接私网访问也是好选择。
- 长会话注意：agent 一轮里会有多次请求，隧道心跳别省。

### 5.2 DSH 配置

GUI 路径：**设置 → 模型 → 添加模型提供商 → 添加方式选「自定义模型 API」**

填写：
- **API 地址**：`http://127.0.0.1:8000/v1`（占位符就是 `https://gateway.example/v1`，**要带 `/v1`**）
- **协议**：`OpenAI Chat Completions`（即 `openai-completions`）
- **模型**：`qwen3.8-27b`（必须与服务端 `--served-model-name` 完全一致）
- **路由 id**：如 `qwen38-local`（小写字母开头，可用连字符）
- **API 密钥**：填服务端 `--api-key` 的值（vLLM 未设 key 时可不填）

保存后去会话模型选择器里选 `qwen3.8-27b` 即可。

### 5.3 冒烟验证（先不经过 DSH）

```bash
# 1) 服务器本地
curl http://127.0.0.1:8000/v1/models -H "Authorization: Bearer local-any-string"

# 2) 本地 PC（隧道另开一个窗口）
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-any-string" \
  -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"用 Python 写一个归并排序"}],"stream":false}'
```

**必须单独测一次工具调用**（agent 的命门）：给一句会触发函数调用的请求，确认响应里 `tool_calls` 非空、且 `finish_reason=tool_calls`。如果这里解析不出来，问题在服务端 parser，不在 DSH。

---

## 6. 已知坑清单

| 坑 | 现象 | 处理 |
|---|---|---|
| TP=3 | 启动报错/头数不整除 | 用 TP=2（KV 头只有 4） |
| 官方 FP8 | 3090 上不加速还占 28.75 GB | 换 AWQ-INT4 |
| `qwen3_xml` parser | agent 工具调用反复作废、日志 `not well-formed` | 换 `--tool-call-parser qwen3_coder` |
| 无 NVLink | NCCL/P2P 卡住或带宽低 | `NCCL_P2P_DISABLE=1`；SGLang 加 `--disable-custom-all-reduce` |
| 无 prefix caching | 每轮都在重算长系统提示词，首 token 很慢 | 开 `--enable-prefix-caching` |
| 上下文一上来开满 | 加载慢、OOM、图捕获失败 | 32K 基线 → 64K → 128K 逐级加 |
| 模板缺失 | 模型不停、或多轮后历史错乱 | 用带正确 `chat_template.jinja` 的仓库；llama.cpp 路线必须 `--jinja` |
| 视觉 | 说看不见图片 | 需要 mmproj / 多模态引擎参数（SGLang 的 `--mm-feature-transport cpu`） |
| DSH 内置 `web_search` | 换成自定义模型后联网搜索不可用 | 其内置搜索是 DeepSeek 官方后端（`dsh-web-search-deepseek`），需要 DeepSeek 凭据；`web_fetch` 是普通 HTTP，照常可用 |
| 功耗散热 | 长跑降频，速度掉 20–30% | 1600 W 级电源 + 风道；监控 `nvidia-smi` 显存分布是否均衡 |

---

## 7. 回退方案

- **单卡/极简**：一个 3090 上 AWQ-INT4 ≈ 20 GB，剩约 3 GB 给 KV（≈ 48K token @64 KB/token）——够 agent 用，另外两张卡干别的。
- **零折腾**：`llama-server` + GGUF Q4_K_M/Q5_K_M（`--jinja -ngl 99`，视觉再加 `--mmproj`）。缺点是并发和吞吐弱、没有真正的张量并行，适合先验证链路。
- **先不买硬件**：先用托管 OpenAI 兼容 API 把 DSH 这条链路（自定义 provider + 工具调用 + 子代理）跑通，再上本地 3×3090——迁移成本只是一个 baseURL。

---

## 8. 参考

- [Qwen3.8-27B 官方模型卡](https://huggingface.co/Qwen/Qwen3.8-27B) ｜ [QwenLM/Qwen3.8](https://github.com/QwenLM/Qwen3.8)
- [Run Qwen 3.8 27B Locally：真实 GGUF 体积 / KV Cache / 模板坑](https://dev.to/purpledoubled/run-qwen-38-27b-locally-real-gguf-sizes-the-kv-cache-trick-and-the-template-trap-114j)
- [Qwen3.8 27b 工具调用出错？一个参数解决（qwen3_coder vs qwen3_xml）](https://lcz.me/topic/1429)
- [Qwen3.8-27B 本地部署指南：双 RTX 3090、WSL2 与推理优化](https://news.qiniu.com/archives/1787048758096)
- [从 0 部署 Qwen3.8-27B：量化档位怎么选](https://jishuzhan.net/article/2107376800641081345)
- [club-3090：Qwen3.8-27B AWQ W4A16 双卡 TP=2 配方](https://github.com/noonghunna/club-3090/pull/997/files)
- [4×RTX 3090 vLLM/Marlin 实测（TP4, 256K）](https://huggingface.co/soyrsoyr/Qwen3.8-27B-W4A16-AWQ-GPTQ/discussions/1)

> 注：体积/速度为社区实测或按带宽推算，硬件与框架版本差异大，最终以你本机日志与基准为准。
