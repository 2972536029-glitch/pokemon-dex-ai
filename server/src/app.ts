// Express app factory, split from index.ts so different runtimes can mount it:
// - server/src/index.ts listens locally / in Docker
// - api/index.ts hands it to Vercel as a serverless handler
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { GLM_CONFIG, llmGate } from "./llm.js";
import { LlmError } from "./types.js";
import { loadEnvFile } from "./env.js";
import { mountPhase1 } from "./routes-phase1.js";
import { mountBattle } from "./routes-battle.js";
import { mountFriends } from "./routes-friends.js";
import { mountLore } from "./lore.js";
import { mountTelemetry, recordApiSample } from "./telemetry.js";
import { mountPoke } from "./routes-poke.js";
import { userFromRequest } from "./auth.js";
import { clientIp } from "./http.js";
import { allowRate } from "./ratelimit.js";
import { catalogNames, seedCatalog } from "./cards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CSP:静态托管 SPA 的正确形态(Auth0/Vite 社区共识)——script-src 'self'(hash
// 文件名解决的是缓存不是 CSP;nonce+strict-dynamic 需要逐请求注入,本架构做不到);
// style 'unsafe-inline' 是 React 内联 style 的务实取舍;us5.datadoghq.com 是
// RUM 上报口(未启用时无害)。PokeAPI 已收进服务端代理,不出现在 connect-src。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self' https://us5.datadoghq.com",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function createApp() {
  loadEnvFile(path.join(__dirname, "..", "..", ".env.local"));

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  // 安全响应头(v3.1 补齐 CSP + HSTS;静态资源由 vercel.json headers 兜底)
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });

  // request correlation id:透传客户端的 x-request-id 或生成短 id,echo 回响应头;
  // wrap() 的服务端日志带上它,一条失败请求的日志就能被串起来(v3.1 审计 P2-2)。
  app.use((req, res, next) => {
    const rid = (String(req.headers["x-request-id"] ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 32))
      || crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    res.setHeader("x-request-id", rid);
    (req as express.Request & { rid: string }).rid = rid;
    next();
  });

  // CSRF 纵深(SameSite=Lax 之外的第二道):写方法的 Origin/Referer 在场时必须
  // 与 Host 同源。浏览器一定会带(且跨站伪造请求的 Origin 是攻击者域)→ 拦截;
  // 非浏览器客户端(curl/测试)无 Origin → 放行,不破坏脚本与测试。
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.headers.origin ?? req.headers.referer;
    if (!origin) return next();
    try {
      if (new URL(String(origin)).host === req.headers.host) return next();
    } catch {
      /* 解析失败按跨站处理 */
    }
    res.status(403).json({ error: "cross_origin_blocked", message: "跨站请求被拒绝" });
  });

  // 冷启动门:所有 /api 先确保 schema。原来只有 phase1 的五类路径有门,
  // 好友/对战/lore 表在新 serverless 实例的第一次请求会裸 500。
  app.use("/api", async (req, res, next) => {
    try {
      const { ensureSchema } = await import("./db.js");
      await ensureSchema();
      next();
    } catch (err: any) {
      console.error(`[api]${(req as express.Request & { rid?: string }).rid ? ` ${(req as express.Request & { rid?: string }).rid}` : ""} schema unavailable:`, err?.message);
      res.status(503).json({ error: "db_unavailable", message: "数据库暂时不可用,请几秒后重试" });
    }
  });

  const isMock = process.env.MOCK_LLM === "1" || !GLM_CONFIG.apiKey;

  app.get("/api/health", async (_req, res) => {
    let db = "ok";
    try {
      const { ensureSchema } = await import("./db.js");
      await ensureSchema();
      await (await import("./db.js")).q(`SELECT 1`);
    } catch (err: any) {
      db = "error";
      // QA-030:错误细节只进日志,响应体不向未认证访客暴露内部信息
      console.error("[health] db check failed:", err?.message);
    }
    // DB 异常时返回 503:拨测/监控盯状态码才有意义(此前恒 200,等于失明——
    // v3.1 审计 P2-1;浅检查不重启进程,只报告)
    res.status(db === "ok" ? 200 : 503).json({
      ok: db === "ok",
      model: isMock ? "mock" : GLM_CONFIG.model,
      mock: isMock,
      db,
    });
  });

  // Ops: catalog seeding for fresh deployments. Key-protected (the model
  // key doubles as the ops key); idempotent — safe to call repeatedly.
  app.post("/api/admin/seed", async (req, res) => {
    const key = String(req.headers["x-seed-key"] ?? "");
    if (!GLM_CONFIG.apiKey || key !== GLM_CONFIG.apiKey) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const { ensureSchema } = await import("./db.js");
      await ensureSchema();
      const result = await seedCatalog();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[admin] seed failed:", err);
      res.status(500).json({ error: "seed_failed", message: "初始化失败,请查看服务端日志" });
    }
  });

  // v2.4:/api 请求计时(遥测旁路)。必须在业务路由挂载之前注册,请求才会
  // 先经过这里、finish 钩子才来得及挂;放 schema 门之后保证 telemetry 表已
  // 就绪。落表本身是尽力而为,不阻塞响应。
  app.use("/api", (req, res, next) => {
    recordApiSample(req, res);
    next();
  });

  // Phase 1: accounts / wallet / packs / collection. Mounted lazily so the
  // dex + AI chat keep working even when DATABASE_URL is absent (the router
  // returns 503 for its own routes instead of taking the app down).
  app.use(mountPhase1());
  app.use(mountBattle());
  app.use(mountFriends());
  app.use(mountLore());
  app.use(mountTelemetry());
  app.use(mountPoke());

  // ---- the chat endpoint ----------------------------------------------------
  app.post("/api/chat", async (req, res) => {
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

    // 成本保护:匿名即可用的 GLM 入口必须限流(DB 背书,跨实例共享)。
    if (!(await allowRate(`chat:${clientIp(req)}`, 20, 86_400))) {
      res.status(429).json({ error: "rate_limited", message: "今天的提问次数用完了,明天再来吧" });
      return;
    }

    // SSE headers. no-transform and X-Accel-Buffering stop intermediaries
    // (nginx, CDN, serverless platforms) from buffering the stream, which
    // would kill the typewriter effect and idle-timeout the connection
    // during long tool rounds.
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

    // Logged-in user → advisor tools + ownership guard. Both DB reads are
    // fault-tolerant on purpose: a missing/unreachable DATABASE_URL degrades
    // the chat to the plain dex assistant instead of breaking it.
    let userId: number | null = null;
    let names: string[] = [];
    try {
      const sessionUser = await userFromRequest(req);
      if (sessionUser) {
        userId = sessionUser.id;
        names = await catalogNames();
      }
    } catch (err) {
      console.warn("[chat] user context unavailable, continuing anonymous:", (err as Error).message);
    }

    // v3.2:LLM 预算闸(登录按用户桶,匿名按 IP 桶——gate 与记账同桶)。
    // 超限不是 429:降级进规则管线照常回答,notice 把原因如实告诉用户——
    // 成本护栏不能以可用性为代价;降级路径必须带 reason 行(v3.1 教训)。
    const meter = {
      feature: "chat" as const,
      ident: userId ? `u:${userId}` : `ip:${clientIp(req)}`,
      userId,
    };
    const gate = await llmGate(meter);
    const degrade = gate.ok
      ? undefined
      : gate.reason === "global_budget"
        ? { reason: "全网 AI 额度暂时用完,已切换到离线图鉴模式,回答由规则生成。" }
        : { reason: "你今天的 AI 额度已用完,已切换到离线图鉴模式,明天恢复。" };

    runAgent({
      history,
      contextName,
      userId,
      catalogNames: names,
      signal: controller.signal,
      emit,
      degrade,
      meter,
    })
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

  // ---- static hosting (production: one process serves API + SPA) -----------
  const distDir = path.join(__dirname, "..", "..", "dist");
  if (fs.existsSync(distDir)) {
    // hash 文件名配 immutable 长缓存;index.html 不缓存(新版本要立即生效)
    app.use(express.static(distDir, {
      setHeaders: (res, filePath) => {
        if (filePath.startsWith(path.join(distDir, "assets"))) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    // SPA fallback for client-side routes, WITHOUT '*' path patterns
    // (Express 5 changed wildcard syntax; middleware is version-proof).
    // /api 的未知路径不再吞成 200 HTML(排障困惑 + 假绿温床,v3.1 审计 P2-11)
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      if (req.method !== "GET" || !req.accepts("html")) return next();
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  return app;
}

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
