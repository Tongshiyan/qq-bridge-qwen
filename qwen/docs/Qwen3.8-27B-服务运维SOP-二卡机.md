# Qwen3.8-27B 本地 Agent 服务 运维 SOP（二卡机 · 现役）

> **本文件是当前生效的运维文档。**
> 迁移来源：老四卡机 `ac-Super-Server`（your-old-server-ip）→ 二卡机 `ac-System-Product-Name`（your-server-ip）
> 迁移日期：2026-10-13 · 迁移过程见 [迁移记录-四卡机到二卡机.md](迁移记录-四卡机到二卡机.md)
> 老机文档（历史）见 [Qwen3.8-27B-服务运维SOP.md](Qwen3.8-27B-服务运维SOP.md)

---

## 0. 速查

```bash
ssh ac@your-server-ip

q38 start      # 启动（后台常驻 setsid，关终端不影响）
q38 stop       # 停止（pkill 杀掉 vllm + 置 STOPPED 标记）
q38 restart    # 重启
q38 status     # 进程 / STOPPED 标记 / 端口 / GPU / API 状态码
q38 logs       # tail -f 日志（Ctrl-C 只退出查看）
q38 test       # 文本 + 工具调用 + 视觉 三项冒烟测试
q38 fg         # 前台启动（调试）

q38mode status # 当前是 short(MTP=3) 还是 long(无 MTP)
q38mode short  # 切短上下文模式（≤30K 上下文更快）
q38mode long   # 切长上下文模式（>40K 上下文更稳更快）
```

**日常手动启停就用 Qwen 控制台**（`Qwen控制台.exe`，顶部下拉框可在两台机器间切换，见 3.1 节）；
只想开隧道也可以双击 `%QWEN_DIR%\start-tunnel.cmd`（已指向新机）。

---

## 1. 架构与关键参数

| 项目 | 值 |
|---|---|
| 主机 | `ac@your-server-ip`（hostname `ac-System-Product-Name`） |
| 系统 | Ubuntu 20.04.6 LTS，kernel 5.15.0-139，36 vCPU / 125 GB RAM |
| GPU | **2× RTX 3090 24GB**，驱动 **570.133.07**（CUDA 12.8），GPU0/GPU1 同属 **NUMA node 0** |
| 磁盘 | `/dev/nvme0n1p2` 916G，已用 43%，可用约 **497G** |
| 模型权重 | `/home/ac/qwen3.8-agent/models/Qwen3.8-27B-AWQ-INT4`（57 个文件，21,041,281,697 字节，5 分片 compressed-tensors AWQ-INT4） |
| Python 环境 | `/home/ac/envs/qwen38`（11G）→ 解释器 `/home/ac/.local/share/uv/python/cpython-3.12.15-linux-x86_64-gnu/bin/python3.12` |
| 关键版本 | torch 2.13.0+cu129 / vllm 0.31.0+cu129 / transformers 5.17.0 |
| 服务 | vLLM OpenAI 兼容 API，`http://127.0.0.1:8000/v1`，模型名 `qwen3.8-27b`，API key `local-any-string` |
| 并行 | `--tensor-parallel-size 2`（GPU0+GPU1；**不能用 TP=3**，KV 头只有 4 个） |
| 上下文 | `--max-model-len 262144`，实测 KV 池 **326,719 tokens**（并发 1.25x，≥262144 满足） |
| 显存 | 每卡约 **21.1 GiB**（21128 / 21219 MiB），`--gpu-memory-utilization 0.92` |
| 监督方式 | **完全手动**：`setsid` 常驻（无 systemd、无 sudo）；**crontab 已清空**，不开机自启、不看门狗 |
| 当前模式 | **long（无 MTP）** —— 与迁移源一致 |

### 1.1 实测基准（2026-10-13，迁入后）

| 项目 | 结果 |
|---|---|
| 启动到就绪 | **175 s**（`HTTP 200`） |
| 权重加载 | 3.88 s（NVMe） |
| 解码 @2K 上下文 | **58.1 tok/s**（cold）/ 57.4（warm）—— long 模式 |
| TTFT · 6K 上下文冷启动 | **5.01 s**（含上传 + prefill） |
| TTFT · 6K 上下文命中前缀缓存 | **0.93 s** |
| TTFT · 极短请求 | 1.29 s |
| 三项冒烟 | 文本 ✅ / 工具调用 ✅（`get_weather({"city":"北京"})`，finish_reason=`tool_calls`）/ 视觉 ✅（正确描述测试图） |
| 模型完整性 | 5 个权重分片 + index + config + tokenizer + chat template，**9/9 SHA256 与老机一致** |

> **想要短上下文更快（~95 tok/s @1.8K）**：`q38mode short`（开 MTP=3）。代价是 >40K 上下文时明显变慢（69K 时约 20 tok/s）。
> 切模式含重启，约 3 分钟。

---

## 2. 目录与文件清单

```
/home/ac/qwen3.8-agent/
├── env.sh                 # 环境变量（本机版：已去掉 CUDA_HOME shim）
├── env.sh.old4            # 老机版 env.sh 备份
├── STOPPED                # 存在 = 曾手动停止（仅作记录，当前没有看门狗读它）
├── bin/
│   ├── serve.sh           # 当前生效的启动命令（= serve.long.sh）
│   ├── serve.short.sh     # 短上下文模板（MTP=3）
│   ├── serve.long.sh      # 长上下文模板（无 MTP）
│   ├── q38                # 运维命令（setsid 版，无 systemd）
│   ├── q38mode            # short / long / status 切换
│   ├── watchdog.sh        # 可选看门狗（当前未挂 cron，开启方法见 3.1）
│   ├── smoke_api.py       # 三项冒烟测试
│   └── ...（老机带过来的诊断/基准脚本）
├── models/Qwen3.8-27B-AWQ-INT4/
├── cache/hf/
└── logs/serve.log         # 服务日志（q38 start 会截断重写）
    logs/watchdog.log      # 看门狗日志（仅在可选开启看门狗后才有内容）
    logs/autostart.log     # 开机自启日志（当前不会产生：crontab 已清空）

/home/ac/envs/qwen38/                              # venv（11G）
/home/ac/.local/share/uv/python/cpython-3.12.15-...  # venv 指向的解释器
```

**crontab：空的（按需求改为完全手动）**

```console
$ crontab -l
no crontab for ac
```

> 这台机器 `ac` 没有免密 sudo，所以**不用 systemd**；服务由 `q38`（setsid）手动启停。
> 曾经装过 `@reboot` 开机自启 + 每 5 分钟看门狗，已按「以后手动启停」的要求移除。
> 看门狗脚本仍在 `bin/watchdog.sh`，想恢复崩溃自愈见 [3.1 节](#31-qwen-控制台两台机器共用一个界面)。

---

## 3. 日常操作

| 目的 | 命令 | 说明 |
|---|---|---|
| 启动 | `q38 start` | 后台常驻（setsid），日志 `logs/serve.log`；就绪约 3 分钟 |
| 停止 | `q38 stop` | `pkill` 杀掉 vllm + 置 `STOPPED` 标记 |
| 重启 | `q38 restart` | 改完 `serve.sh` 用它 |
| 状态 | `q38 status` | 进程 / STOPPED / 端口 / GPU / API 状态码 |
| 日志 | `q38 logs` | `tail -f` |
| 测试 | `q38 test` | 文本 / 工具调用 / 视觉 |
| 模式 | `q38mode short\|long\|status` | 切 MTP 双模式 |
| 崩溃自愈（可选） | `bin/watchdog.sh` | **当前未挂 cron**；要开启见 3.1 节 |

### 3.1 Qwen 控制台（两台机器共用一个界面）

`%QWEN_DIR%\Qwen控制台.exe`（实际执行 `QwenControlPanel.ps1`）。

- 顶部新增 **「服务器：」下拉框**，可在 `your-server-ip · 二卡机（现役）` 与 `your-old-server-ip · 四卡机（备用）` 之间切换；
- 切换时若隧道正在运行，会**自动把隧道重建**到新目标，并刷新服务状态；
- 【启动 / 停止 / 重启 / 刷新】按钮 = 在所选机器上执行 `q38 start|stop|restart|status`；
- 界面自检（不开窗口、直接打印状态）：
  ```powershell
  powershell -ExecutionPolicy Bypass -File %QWEN_DIR%\QwenControlPanel.ps1 -SelfTest
  ```

> 2026-10-13 顺手修掉控制台的两个既有 bug（否则「手动启停」会失效）：
> ① `Get-Keeper()` 认不出控制台自己用 `-EncodedCommand` 启动的隧道守护进程 → 【停止】杀不掉守护，隧道 5 秒后被重新拉起；
> ② 服务状态靠匹配 systemd 的 `active (running)`，而二卡机是无 systemd 版 `q38` → 运行中的服务会被误报成「未运行」。

**可选：恢复崩溃自愈**（当前 crontab 为空，纯手动）

```bash
( crontab -l 2>/dev/null; \
  echo '*/5 * * * * /bin/bash /home/ac/qwen3.8-agent/bin/watchdog.sh >> /home/ac/qwen3.8-agent/logs/watchdog.log 2>&1' ) | crontab -
```

看门狗只在「vllm 进程不存在」时才重启（不是看端口，所以加载权重那 3 分钟不会误判）；
`q38 stop` 会置 `STOPPED` 标记，看门狗不会把它拉起来。

> ⚠️ 改 `QwenControlPanel.ps1` 时必须**保持 UTF-8 带 BOM**：本机 shell 是 Windows PowerShell 5.1 + ANSI 代码页 936，
> 无 BOM 的 UTF-8 会被当 GBK 读，中文全部乱码并导致解析失败（本次打补丁时又踩了一次）。

---

## 4. 健康检查

```bash
q38 status

grep -nE "GPU KV cache size|Available KV cache|Starting vLLM server|Loading weights took|ERROR" \
  ~/qwen3.8-agent/logs/serve.log | tail -15

q38 test
```

**通过标准**

| 项 | 期望 |
|---|---|
| 端口 | `LISTEN 127.0.0.1:8000` |
| API | `HTTP 200` |
| KV | `GPU KV cache size` ≥ 262144 |
| 文本 / 工具调用 / 视觉 | 三项都有正确输出（`finish_reason: tool_calls`） |

---

## 5. 本机特有陷阱（**迁移时踩过，务必保留规避手段**）

| 陷阱 | 事实 | 规避 |
|---|---|---|
| **nvcc 是 CUDA 10.1** | `/usr/bin/nvcc` 报 `release 10.1, V10.1.243`；`/usr/local/cuda` → `cuda-11.6` | **绝不能触发 JIT 编译**：保留 `-cc.mode=none -cc.cudagraph_mode=full_and_piecewise` 和 `VLLM_USE_FLASHINFER_SAMPLER=0`；**不要**再加 `CUDA_HOME=$HOME/cuda_home` |
| `--enforce-eager` | 会关掉 CUDA 图，速度 58 → 9 tok/s | 永远不要加 |
| `/usr/local/anaconda3` | `root:anaconda 750`，`ac` 不可遍历 | `env.sh` 里的 PATH 过滤必须保留 |
| 多人共用 | `AllowUsers ac chenyao huangmin zhouziai heying leixinyue`，其他人可能占 GPU | 见第 7 节 |
| 老机 `bin/serve.sh` 是 long 模式 | 迁移源本身没开 MTP | 想提速执行 `q38mode short` |

---

## 6. 本地 PC 接入 DeepSeek Harness

隧道脚本已指向新机（`tunnel.ps1` / `start-tunnel.cmd` / `QwenControlPanel.ps1` / `qq-bridge\scripts\start-all.ps1` 全部已改）。

```powershell
# 手动开隧道（保持窗口不关）
%QWEN_DIR%\start-tunnel.cmd

# 验证
curl.exe http://127.0.0.1:8000/v1/models -H "Authorization: Bearer local-any-string"
```

DSH 的自定义 provider 配置**不用改**（仍然是 `http://127.0.0.1:8000/v1`、`qwen3.8-27b`、`local-any-string`），因为隧道把本地 8000 映射到新机 8000。

**Windows 侧实测（新链路）**

| 项目 | 结果 |
|---|---|
| 上行带宽（scp，2MB 随机数据） | **约 110–116 KB/s**（老机 116 KB/s，基本一致；`-C` 对不可压缩数据无差别） |
| 经隧道 6K 上下文冷启动 TTFT | 5.0 s |
| 经隧道命中前缀缓存 TTFT | 0.93 s |

> 老文档里「上行只有 3–15 KB/s」的结论在新链路上没有复现；但 DSH 每步都重传整个上下文，
> 上下文越长上传越久，所以 **`-C` 仍然保留**，并建议把上下文控制在 10–30K。

**开机自启（Windows）**：任务 `qwen-stack-autostart` 目前是 **Disabled**（此前手动关过）。
想恢复自启：
```powershell
powershell -ExecutionPolicy Bypass -File %QWEN_DIR%\disable-autostart.ps1 -Restore
```

---

## 7. 故障排查

### 7.1 服务起不来 / 起完就退出

```bash
q38 logs
grep -nE "ERROR|Traceback|OutOfMemory|CUDA out of memory" ~/qwen3.8-agent/logs/serve.log | tail -30
```

| 日志特征 | 原因 | 处理 |
|---|---|---|
| `torch.OutOfMemoryError` / `No available memory` | **别的用户占了卡**（这台是多人共用机） | `nvidia-smi` 看谁在用；等它释放后手动 `q38 start`（当前不自动重试，除非开启 3.1 的看门狗） |
| `max seq len ... larger than ... KV cache` | KV 池装不下 | 把 `--max-model-len` 降到 131072 |
| `InductorError ... nvcc` | 触发了 torch.compile | 确认 `serve.sh` 里是 `-cc.mode=none` |
| `Could not find nvcc ... flashinfer` | FlashInfer 采样器 JIT | 确认 `env.sh` 有 `VLLM_USE_FLASHINFER_SAMPLER=0` |
| `Address already in use` | 旧进程还占 8000 | `q38 stop` → 等 5 秒 → `q38 start` |
| 显存占满但没进程 | 僵死 worker | `pkill -f "vllm serve"`，等 5 秒，`nvidia-smi` 确认释放 |

### 7.2 服务活着但请求 500

先看 `~/qwen3.8-agent/logs/serve.log` 里的真 traceback。常见就是 7.1 的前两条。

### 7.3 自动拉起没生效

```bash
crontab -l                 # 两条任务在不在
systemctl is-active cron   # cron 是否在跑（本机 active）
q38 status                 # STOPPED 标记是否残留
cat ~/qwen3.8-agent/logs/watchdog.log
```

---

## 8. 多人共用机的防争抢建议

这台机器是学院共用的（还有其他 5 个账号）。老机上的服务正是被同机用户占用 GPU1 后挂掉的。建议：

1. **启动前先看一眼**：`nvidia-smi` 确认 GPU0/GPU1 空闲再 `q38 start`。
2. **看门狗默认关闭**：被抢卡导致启动失败后不会自动重试，需要手动 `q38 start`；
   想恢复每 5 分钟自愈，按 3.1 节把看门狗挂回 cron。
3. **实在抢不到**：把 `serve.sh` 里的 `--gpu-memory-utilization 0.92` 降到 **0.90**（KV 池仍 ≥262144 的底线；再低就装不下 262144 上下文了）。
4. 有条件的话和实验室其他成员约定：GPU0/GPU1 归本服务使用。

---

## 9. 回滚

老机 `your-old-server-ip` 上的文件与模型**都还在**（未删除）：

```bash
ssh ac@your-old-server-ip
bash ~/qwen3.8-agent/bin/q38 start     # 老机服务仍可手工拉起
```

要把 Windows 隧道切回老机：
```powershell
powershell -ExecutionPolicy Bypass -File %QWEN_DIR%\migrate\cutover-windows.ps1 -Server ac@your-old-server-ip
```

**老机的开机自启已在「没有 sudo 密码」的前提下被中和**（2026-10-13）：

| 项 | 状态 |
|---|---|
| `qwen38.service` | 仍是 **enabled**（没有 sudo 密码，`disable` 做不了），但**开机拉起会被拒绝** |
| 拒绝机制 | `bin/serve.sh` 顶部有 guard：进程 cgroup 属于 `qwen38.service`（或带 `INVOCATION_ID`）时打印提示并 `exit 0` —— 不加载模型、不占 GPU |
| 手动启停 | **照旧可用**：老机的 `q38` 已换成 setsid 版，`q38 start/stop/restart/status` 都不再经过 systemd |
| 实测证据 | 模拟 systemd 拉起（`INVOCATION_ID=dummy bash serve.sh`）→ 打印「拒绝启动」、退出码 0、**无任何 vllm 进程** |
| 备份 | `bin/serve.sh.orig-systemd`、`bin/q38.orig-systemd`、`bin/q38mode.orig-systemd` |

恢复成「systemd 也能启动」：

```bash
ssh ac@your-old-server-ip 'cd ~/qwen3.8-agent/bin && cp -a serve.sh.orig-systemd serve.sh \
  && cp -a q38.orig-systemd q38 && cp -a q38mode.orig-systemd q38mode'
```

彻底摘掉单元（**需要 sudo 密码**，这一步还没做）：

```bash
ssh ac@your-old-server-ip "sudo systemctl disable --now qwen38"
ssh ac@your-old-server-ip "sudo bash /tmp/decommission-old.sh"            # 停用+禁用，保留数据
ssh ac@your-old-server-ip "sudo bash /tmp/decommission-old.sh --purge"    # 另删除模型+venv，释放约 31G
```

---

## 10. 附：不依赖脚本的原始命令

```bash
source ~/qwen3.8-agent/env.sh
~/qwen3.8-agent/bin/serve.sh            # 前台启动（调试）

curl -sS http://127.0.0.1:8000/v1/models -H "Authorization: Bearer local-any-string"
tail -f ~/qwen3.8-agent/logs/serve.log
pkill -f "vllm serve"
```
