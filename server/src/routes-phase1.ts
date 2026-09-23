// Phase 1 routes: accounts, wallet, packs, collection.
// Mounted via app.use(mountPhase1()). Everything here requires DATABASE_URL;
// without it the router answers 503 for its own paths ONLY — the dex and the
// AI chat keep working, so a misconfigured DB can't take the whole app down.
//
// Identity rule (IDOR red line): userId comes EXCLUSIVELY from the session
// cookie resolved server-side. No route ever accepts a userId from the
// request body/query — that value is what AI tools are bound to as well.

import express from "express";
import { ensureSchema } from "./db.js";
import {
  AUTH_CONSTANTS,
  clearSessionCookie,
  createSession,
  destroySession,
  login,
  loginAllowed,
  parseSessionCookie,
  register,
  sessionCookie,
  userFromRequest,
} from "./auth.js";
import { GachaError, PACKS, dailyBonus, drawCard, myCollection, walletHistory } from "./gacha.js";

export function mountPhase1(): express.Router {
  const router = express.Router();

  let schemaError: Error | null = null;
  const ready = ensureSchema().catch((err: Error) => {
    schemaError = err;
    console.error("[phase1] schema init failed — phase1 routes will 503:", err.message);
  });

  const gate = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    ready.then(() => next());
  };
  router.use(["/api/auth", "/api/me", "/api/wallet", "/api/packs", "/api/collection"], gate);
  router.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (schemaError && req.path.startsWith("/api/")) {
      res.status(503).json({ error: "db_unavailable", message: "数据库未配置,Phase 1 功能暂不可用" });
      return;
    }
    next();
  });

  const secureCookie = process.env.NODE_ENV === "production" || process.env.HTTPS_ONLY === "1";

  // Every phase1 handler runs through this wrapper: unexpected errors become
  // a generic JSON 500 (never a stack trace or driver message) while the
  // details go to the server log (QA-009/010).
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => {
      fn(req, res).catch((err: unknown) => {
        console.error(`[phase1] ${req.method} ${req.path} failed:`, err);
        const status = (err as any)?.status ?? 500;
        const message =
          status >= 500 ? "服务暂时不可用,请稍后再试" : (err as Error)?.message ?? "请求失败";
        res.status(status).json({ error: "internal", message });
      });
    };

  router.post("/api/auth/register", wrap(async (req, res) => {
    try {
      const { username, password } = req.body ?? {};
      const user = await register(String(username ?? ""), String(password ?? ""));
      const s = await createSession(user.id);
      res.setHeader("Set-Cookie", sessionCookie(s.cookieValue, s.maxAgeSec, secureCookie));
      res.json({ user, signupBonus: AUTH_CONSTANTS.SIGNUP_BONUS });
    } catch (err: any) {
      if (err?.status) throw err; // validation / 409 carry their own message
      console.error("[auth] register failed:", err);
      throw Object.assign(new Error("注册失败,请稍后再试"), { status: 500 });
    }
  }));

  router.post("/api/auth/login", wrap(async (req, res) => {
    const ip = Array.isArray(req.ip) ? req.ip[0] : (req.ip ?? "unknown");
    if (!loginAllowed(ip)) {
      res.status(429).json({ error: "rate_limited", message: "尝试次数过多,请 15 分钟后再试" });
      return;
    }
    try {
      const { username, password } = req.body ?? {};
      const user = await login(String(username ?? ""), String(password ?? ""));
      const s = await createSession(user.id);
      res.setHeader("Set-Cookie", sessionCookie(s.cookieValue, s.maxAgeSec, secureCookie));
      res.json({ user });
    } catch (err: any) {
      if (err?.status) throw err; // 401 generic / 429 rate limit
      console.error("[auth] login failed:", err);
      throw err; // wrap turns unknown errors into a generic 500
    }
  }));

  router.post("/api/auth/logout", wrap(async (req, res) => {
    const sid = parseSessionCookie(req);
    if (sid) await destroySession(sid);
    res.setHeader("Set-Cookie", clearSessionCookie(secureCookie));
    res.json({ ok: true });
  }));

  router.get("/api/me", wrap(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.json({ user: null });
      return;
    }
    res.json({ user });
  }));

  router.post("/api/wallet/daily", wrap(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "请先登录" });
      return;
    }
    res.json(await dailyBonus(user.id));
  }));

  router.get("/api/wallet/tx", wrap(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "请先登录" });
      return;
    }
    res.json({ transactions: await walletHistory(user.id) });
  }));

  // 公示接口:卡包定义 + 概率 + 池子大小,店页据此渲染概率表
  router.get("/api/packs", wrap(async (_req, res) => {
    res.json({
      packs: PACKS.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        rates: p.weights,
      })),
      dailyBonus: AUTH_CONSTANTS.DAILY_BONUS,
      signupBonus: AUTH_CONSTANTS.SIGNUP_BONUS,
    });
  }));

  router.post("/api/packs/:id/draw", wrap(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "请先登录" });
      return;
    }
    try {
      const orderId = String(req.body?.orderId ?? "");
      res.json(await drawCard({ userId: user.id, packId: String(req.params.id), orderId }));
    } catch (err: any) {
      if (err instanceof GachaError) {
        res.status(err.status).json({ error: "gacha_failed", message: err.message });
        return;
      }
      console.error("[packs] draw failed:", err);
      res.status(500).json({ error: "internal", message: "抽卡出了点问题,请重试" });
    }
  }));

  router.get("/api/collection", wrap(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "请先登录" });
      return;
    }
    res.json({ cards: await myCollection(user.id) });
  }));

  return router;
}
