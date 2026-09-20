// HTTP entry: POST /api/chat (SSE) + static hosting of the built SPA.
//
// Why a server at all (vs. calling the LLM from the browser):
// 1. The API key must never reach the browser — anything shipped to a
//    client is public, so model credentials live here and only here.
// 2. Tool calling is a multi-round loop; doing it client-side would leak
//    PokeAPI orchestration and make the SSE payload format mandatory to
//    keep stable. The server owns the loop, the browser just renders.
// 3. SSE needs explicit proxy-unfriendly headers + heartbeats; that
//    plumbing belongs to infrastructure, not UI code.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { GLM_CONFIG } from "./llm.js";
import { LlmError } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5178);

// Zero-dependency .env loader: reads .env.local once at boot. Existing
// process env always wins, so real deployments can inject via Docker/K8s.
function loadEnvFile(file: string) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local — fine, env vars or mock mode */
  }
}
loadEnvFile(path.join(__dirname, "..", "..", ".env.local"));

const app = express();
app.use(express.json({ limit: "64kb" }));

const isMock = process.env.MOCK_LLM === "1" || !GLM_CONFIG.apiKey;

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: isMock ? "mock" : GLM_CONFIG.model, mock: isMock });
});

// ---- the chat endpoint ----------------------------------------------------
app.post("/api/chat", (req, res) => {
  const { messages, context } = req.body ?? {};

  // Input validation before touching the LLM: role whitelist, length caps.
  // A malformed body should be a 400, never an LLM round-trip.
  const valid =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= 30 &&
    messages.every(
      (m: any) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length <= 4_000
    );
  if (!valid) {
    res.status(400).json({ error: "invalid_request", message: "messages must be 1-30 user/assistant turns (<=4000 chars each)" });
    return;
  }

  // SSE headers. no-transform and X-Accel-Buffering stop intermediaries
  // (nginx, CDN) from buffering the stream, which would kill the typewriter
  // effect and idle-timeout the connection during long tool rounds.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Heartbeat: an SSE comment line every 15s keeps proxies from closing an
  // "idle" connection while PokeAPI + the model are still thinking.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  const controller = new AbortController();
  // Client went away (tab closed / stop pressed) → cancel the LLM stream
  // and in-flight PokeAPI fetches so we stop paying for an unread answer.
  //
  // GOTCHA (burned once in testing): the REQUEST's "close" event fires as
  // soon as the request body is consumed — not on client disconnect — which
  // would abort every request right after it starts. The RESPONSE's "close"
  // is the disconnect signal; writableEnded distinguishes a normal finish.
  res.on("close", () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) controller.abort();
  });

  const emit = (event: { event: string; data: unknown }) => {
    if (res.writableEnded) return;
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };

  const history = messages.map((m: any) => ({ role: m.role, content: m.content }));
  const contextName = typeof context?.name === "string" ? context.name : null;

  runAgent({ history, contextName, signal: controller.signal, emit })
    .catch((err: unknown) => {
      if (controller.signal.aborted) return; // client went away — nothing to report
      // The user gets a friendly line; the LOG gets the truth. Without the
      // stack here, every unexpected failure is undebuggable after the fact.
      console.error("[chat] agent failed:", err);
      emit({
        event: "error",
        data: { message: friendlyError(err) },
      });
    })
    .finally(() => {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    });
});

function friendlyError(err: unknown): string {
  if (err instanceof LlmError) {
    if (err.status === 401 || err.status === 403) return "模型凭证无效,请检查服务端 GLM_API_KEY 配置。";
    if (err.status === 429) return "模型限流了,请稍等几秒再试。";
    if (err.status === 404) return "模型名不存在,请检查 GLM_MODEL 配置。";
    if (err.status >= 500) return "模型服务暂时不可用,请稍后再试。";
  }
  if (err instanceof Error && err.name === "TimeoutError") return "请求超时,请重试。";
  return "AI 服务出了点问题,请稍后再试。";
}

// ---- static hosting (production: one process serves API + SPA) -----------
const distDir = path.join(__dirname, "..", "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback for client-side routes, WITHOUT '*' path patterns
  // (Express 5 changed wildcard syntax; middleware is version-proof).
  app.use((req, res, next) => {
    if (req.method !== "GET" || !req.accepts("html")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`[ai-chat] listening on http://localhost:${PORT} (model: ${isMock ? "mock" : GLM_CONFIG.model})`);
});
