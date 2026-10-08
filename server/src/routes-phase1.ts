// Phase 1 routes: accounts, wallet, packs, collection.
// Mounted via app.use(mountPhase1()). Everything here requires DATABASE_URL;
// without it the router answers 503 for its own paths ONLY — the dex and the
// AI chat keep working, so a misconfigured DB can't take the whole app down.
//
// Identity rule (IDOR red line): userId comes EXCLUSIVELY from the session
// cookie resolved server-side. No route ever accepts a userId from the
// request body/query — that value is what AI tools are bound to as well.

import express from "express";
import { q } from "./db.js";
import { HttpError, clientIp, requireUser, wrap } from "./http.js";
import { allowRate } from "./ratelimit.js";
import {
  AUTH_CONSTANTS,
  clearSessionCookie,
  createSession,
  destroySession,
  login,
  parseSessionCookie,
  register,
  sessionCookie,
  userFromRequest,
} from "./auth.js";
import { PACKS, dailyBonus, drawCard, myCollection, pityStatus, tenpull, walletHistory } from "./gacha.js";

export function mountPhase1(): express.Router {
  const router = express.Router();

  // schema 门已上移到 app.ts 的全局 /api 中间件(v2.3)。

  const secureCookie = process.env.NODE_ENV === "production" || process.env.HTTPS_ONLY === "1";

  router.post("/api/auth/register", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    if (!(await allowRate(`register:${clientIp(req)}`, 10, 86_400))) {
      res.status(429).json({ error: "rate_limited", message: "注册太频繁,请明天再试" });
      return;
    }
    try {
      const { username, password } = req.body ?? {};
      const user = await register(String(username ?? ""), String(password ?? ""));
      const s = await createSession(user.id);
      res.setHeader("Set-Cookie", sessionCookie(s.cookieValue, s.maxAgeSec, secureCookie));
      res.json({ user, signupBonus: AUTH_CONSTANTS.SIGNUP_BONUS });
    } catch (err: any) {
      if (err instanceof HttpError) throw err; // validation / 409 carry their own message
      console.error("[auth] register failed:", err);
      throw new HttpError(500, "注册失败,请稍后再试");
    }
  }));

  router.post("/api/auth/login", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    if (!(await allowRate(`login:${clientIp(req)}`, 10, 900))) {
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
      if (err instanceof HttpError) throw err; // 401 generic / 429 rate limit
      console.error("[auth] login failed:", err);
      throw err; // wrap turns unknown errors into a generic 500
    }
  }));

  router.post("/api/auth/logout", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const sid = parseSessionCookie(req);
    if (sid) await destroySession(sid);
    res.setHeader("Set-Cookie", clearSessionCookie(secureCookie));
    res.json({ ok: true });
  }));

  router.get("/api/me", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      res.json({ user: null });
      return;
    }
    res.json({ user });
  }));

  router.post("/api/wallet/daily", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    res.json(await dailyBonus(user.id));
  }));

  router.get("/api/wallet/tx", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    res.json({ transactions: await walletHistory(user.id) });
  }));

  // 公示接口:卡包定义 + 概率 + 池子大小,店页据此渲染概率表
  router.get("/api/packs/pity", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    res.json(await pityStatus(user.id));
  }));

  router.get("/api/packs", wrap("phase1", "服务暂时不可用,请稍后再试", async (_req, res) => {
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

  router.post("/api/packs/:id/draw", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    try {
      const orderId = String(req.body?.orderId ?? "");
      res.json(await drawCard({ userId: user.id, username: user.username, packId: String(req.params.id), orderId }));
    } catch (err: any) {
      if (err instanceof HttpError) throw err;   // GachaError(4xx) keeps gacha_failed + message
      console.error("[packs] draw failed:", err);
      throw new HttpError(500, "抽卡出了点问题,请重试");
    }
  }));

  // ---- 十连:一次订单 = 10 张,子幂等键派生自订单号,复用单抽全链路 ----
  router.post("/api/packs/:id/tenpull", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    const pack = PACKS.find((p) => p.id === req.params.id);
    if (!pack) throw new HttpError(404, "卡包不存在", "not_found");
    const orderId = String(req.body?.orderId ?? "");
    if (!/^[a-zA-Z0-9-]{8,56}$/.test(orderId)) {
      throw new HttpError(400, "订单号格式不正确", "invalid_order_id");
    }
    const { cards, replayCount, shortfall, balance } = await tenpull({
      userId: user.id, username: user.username, packId: pack.id, orderId,
    });
    res.json({
      cards,
      balance,
      replay: replayCount === 10 && replayCount > 0,
      replayCount,
      shortfall,
    });
  }));

  router.get("/api/collection", wrap("phase1", "服务暂时不可用,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    res.json({ cards: await myCollection(user.id) });
  }));

  return router;
}
