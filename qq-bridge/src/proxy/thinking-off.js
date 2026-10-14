/**
 * 关思考代理（tiny OpenAI-compatible proxy）
 *
 * 背景：机器人用的本地 Qwen3.8 在 **带 tools 的请求**里会先产出大段
 * reasoning_content（实测同一 prompt：开着思考 12.2s、700 token 全花在
 * reasoning_content 上且正文 0 字；关掉后 9.5s、正文完整 1022 字）。
 * 在 agent 循环里这意味着每一步都更慢，还可能出现"某一步只思考不产出"。
 *
 * 为什么不在 DSH 的 provider 配置里关：`dsh-llm-pi-ai` 的 compat 里有
 * `chatTemplateKwargs`，但这个模型没有声明 reasoning 支持，于是插件把
 * 思考相关的 kwargs 整个丢弃（实测：代理截包确认请求体里既没有
 * chat_template_kwargs 也没有 reasoning_effort，即使配置里写了）。
 *
 * 也不去动那台共享的 vLLM：服务端加 `--default-chat-template-kwargs`
 * 会对所有客户端生效（包括桌面版），而且那台机器在 2026-10-12 刚迁过机。
 *
 * 所以：本机起一个小代理，只给**机器人**这条链路注入
 *   chat_template_kwargs.enable_thinking = false
 * 桌面版仍然直连 8000，思考照旧。
 *
 * 用法：
 *   node src/proxy/thinking-off.js --listen 8002 --upstream http://127.0.0.1:8000
 */

import http from 'node:http';
import { realpathSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

/**
 * 给一个 chat/completions 请求体注入"关思考"参数（纯函数，便于测试）。
 *
 * - 只动 `chat_template_kwargs.enable_thinking`，其它字段原样保留；
 * - 已有的 chat_template_kwargs 不会被覆盖（只补 enable_thinking）；
 * - 非法 JSON 原样返回（交给上游报错，不在这里瞎猜）。
 *
 * @param {string} bodyText 原始请求体
 * @param {{kwargName?: string, value?: unknown}} [opts]
 * @returns {string} 处理后的请求体
 */
export function withThinkingOff(bodyText, { kwargName = 'enable_thinking', value = false } = {}) {
  let obj;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bodyText;

  const existing = (obj.chat_template_kwargs && typeof obj.chat_template_kwargs === 'object'
    && !Array.isArray(obj.chat_template_kwargs))
    ? obj.chat_template_kwargs
    : {};

  obj.chat_template_kwargs = { ...existing, [kwargName]: value };
  return JSON.stringify(obj);
}

/** 是否是需要改写正文的请求（只处理 chat/completions）。 */
export function shouldRewrite(method, url) {
  if (String(method).toUpperCase() !== 'POST') return false;
  return /\/chat\/completions(\?|$)/.test(String(url ?? ''));
}

/**
 * 启动代理。
 *
 * @param {object} opts
 * @param {number} opts.listenPort 本地监听端口
 * @param {string} opts.upstreamBase 上游（如 http://127.0.0.1:8000）
 * @param {(msg: string) => void} [opts.log]
 * @returns {import('node:http').Server}
 */
export function createThinkingOffProxy({ listenPort, upstreamBase, log = () => {} }) {
  const upstream = new URL(upstreamBase);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (shouldRewrite(req.method, req.url) && body.length) {
        body = Buffer.from(withThinkingOff(body.toString('utf8')), 'utf8');
      }

      const headers = { ...req.headers, host: `${upstream.hostname}:${upstream.port}` };
      headers['content-length'] = String(body.length);

      const up = http.request({
        host: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers,
      }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => log(`${req.method} ${req.url} -> ${upRes.statusCode}`));
      });

      up.on('error', (e) => {
        log(`上游错误: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`proxy upstream error: ${e.message}`);
      });

      up.end(body);
    });
    req.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  });

  server.listen(listenPort, '127.0.0.1', () => log(`listening 127.0.0.1:${listenPort} -> ${upstreamBase}`));
  return server;
}

// ── CLI 入口（被 start-all.ps1 以隐藏方式拉起）
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  const listenPort = Number(arg('listen', '8002'));
  const upstreamBase = arg('upstream', 'http://127.0.0.1:8000');
  const quiet = process.argv.includes('--quiet');

  createThinkingOffProxy({
    listenPort,
    upstreamBase,
    log: (m) => { if (!quiet) console.log(`[thinking-off] ${new Date().toISOString()} ${m}`); },
  });
}
