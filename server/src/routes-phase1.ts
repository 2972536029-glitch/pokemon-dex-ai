// Phase 1 routes: accounts, wallet, packs, collection.
// Mounted via app.use(mountPhase1()). Everything here requires DATABASE_URL;
// without it the router answers 503 for its own paths ONLY — the dex and the
// AI chat keep working, so a misconfigured DB can't take the whole app down.
//
// Identity rule (IDOR red line): userId comes EXCLUSIVELY from the session
// cookie resolved server-side. No route ever accepts a userId from the
// request body/query — that value is what AI tools are bound to as well.

import express from "express";
import { ensureSchema, q } from "./db.js";
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
import { GachaError, PACKS, dailyBonus, drawCard, myCollection, pityStatus, walletHistory } from "./gacha.js";

export function mountPhase1(): express.Router {
  const router = express.Router();

  // Schema gate: retries until the DB is reachable. A transient failure
  // (Neon cold start) must NEVER permanently poison the router — the old
  // cached-failure design turned one cold-start blip into endless 503s even
  // after the database recovered.
  router.use(["/api/auth", "/api/me", "/api/wallet", "/api/packs", "/api/collection"], async (req, res, next) => {
    try {
      await ensureSchema();
      next();
    } catch (err: any) {
      console.error("[phase1] schema unavailable:", err?.message);
      res.status(503).json({ error: "db_unavailable", message: "数据库暂时不可用,请几秒后重试" });
    }
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
  router.get("/api/packs/pity", wrap(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "请先登录" });
      return;
    }
    res.json(await pityStatus(user.id));
  }));

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
      res.json(await drawCard({ userId: user.id, username: user.username, packId: String(req.params.id), orderId }));
    } catch (err: any) {
      if (err instanceof GachaError) {
        res.status(err.status).json({ error: "gacha_failed", message: err.message });
        return;
      }
      console.error("[packs] draw failed:", err);
      res.status(500).json({ error: "internal", message: "抽卡出了点问题,请重试" });
    }
  }));

  // ---- 十连:一次订单 = 10 张,子幂等键派生自订单号,复用单抽全链路 ----
  router.post("/api/packs/:id/tenpull", wrap(async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "请先登录" });
      return;
    }
    const pack = PACKS.find((p) => p.id === req.params.id);
    if (!pack) {
      res.status(404).json({ error: "not_found", message: "卡包不存在" });
      return;
    }
    const orderId = String(req.body?.orderId ?? "");
    if (!/^[a-zA-Z0-9-]{8,56}$/.test(orderId)) {
      res.status(400).json({ error: "invalid order id", message: "invalid order id" });
      return;
    }
    const TEN = 10;
    const cards = [];
    let replayCount = 0;
    let shortfall = 0;
    for (let i = 0; i < TEN; i++) {
      const subKey = `${orderId}-s${i}`;
      try {
        const r = await drawCard({ userId: user.id, username: user.username, packId: pack.id, orderId: subKey });
        cards.push(r.card);
        if (r.replay) replayCount++;
      } catch (err: any) {
        if (err instanceof GachaError && err.status === 402) {
          // 每张子抽独立扣费,未抽的本就没扣——如实报告 shortfall
          shortfall = TEN - i;
          console.log("[tenpull] 402 dbg:", JSON.stringify(err.__dbg ?? null));
          break;
        }
        throw err;
      }
    }
    const bal = await q<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [user.id]);
    res.json({
      cards,
      balance: bal.rows[0]?.balance ?? 0,
      replay: replayCount === TEN && replayCount > 0,
      replayCount,
      shortfall,
    });
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
