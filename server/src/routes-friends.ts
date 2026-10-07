// Friends system (v2.2, plan: docs/updates/v2.2-friends.md).
//
// Three capabilities over one mutual-consent relation:
//   1. friend requests — both sides must agree; a reverse pending request
//      auto-accepts (WeChat-style "mutual add passes instantly")
//   2. card trades — gift ("我送你") and ask ("我向你要"); the transfer only
//      happens when the receiving side accepts, inside a transaction that
//      re-validates friendship AND ownership at accept time
//   3. friend battles — async PvP: challenger snapshots a team, target accepts
//      with their own team, server simulates the whole fight once with the
//      existing engine + a seed derived from the battle id; both players read
//      the same immutable report. (No WebSocket: Vercel serverless has no
//      persistent connections.)
//
// Authority rules (same as routes-battle):
//   - userId comes from the session only; no route accepts a uid from the wire
//   - SMALLINT status columns + app-layer constants (extendable without DDL)
//   - no physical FKs: integrity is enforced here, in transactions

import express from "express";
import { q, tx } from "./db.js";
import { userFromRequest } from "./auth.js";
import {
  BattleState, battleMonFromCard, resolveTurn, seededRng,
  effectiveness, Action, Move, PType,
} from "./battle.js";

const FRIEND_CAP = 50;
const PENDING_TRADES_CAP = 10;
const PENDING_CHALLENGES_CAP = 10;
/** PvP rewards settle for at most this many finished battles per day (anti-farm). */
const PVP_REWARD_DAILY_CAP = 10;
const TEAM_SIZE = 3;
const REWARD_WIN = 100;
const REWARD_LOSE = 20;
const REWARD_DRAW = 50;
const TURN_CAP = 120;

export const FRIEND_REQ_STATUS = { PENDING: 1, ACCEPTED: 2, DECLINED: 3 } as const;
export const TRADE_STATUS = { PENDING: 1, DONE: 2, DECLINED: 3, CANCELED: 4 } as const;
export const TRADE_KIND = { GIFT: 1, ASK: 2 } as const;
export const FBATTLE_STATUS = { PENDING: 1, FINISHED: 2, DECLINED: 3, CANCELED: 4 } as const;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function mountFriends(): express.Router {
  const router = express.Router();

  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => {
      fn(req, res).catch((err: unknown) => {
        console.error(`[friends] ${req.method} ${req.path} failed:`, err);
        const status = (err as any)?.status ?? 500;
        const message = status >= 500 ? "好友服务出了点问题,请稍后再试" : (err as Error)?.message ?? "请求失败";
        res.status(status).json({ error: "friends_error", message });
      });
    };

  const requireUser = async (req: express.Request) => {
    const user = await userFromRequest(req);
    if (!user) throw new HttpError(401, "请先登录");
    // users.id is BIGSERIAL → pg hands it over as a string; every JS-side
    // comparison here (to_uid !== me.id and friends) needs a real number.
    return { id: Number(user.id), username: String(user.username) };
  };

  const bad = (message: string): never => { throw new HttpError(400, message); };

  const pair = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;

  async function areFriends(a: number, b: number): Promise<boolean> {
    const [x, y] = pair(a, b);
    const { rowCount } = await q(`SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
    return (rowCount ?? 0) > 0;
  }

  async function friendCount(uid: number): Promise<number> {
    const { rows } = await q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM friendships WHERE user_a = $1 OR user_b = $1`, [uid]);
    return Number(rows[0].n);
  }

  async function usernameOf(uid: number): Promise<string> {
    const { rows } = await q<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [uid]);
    return rows[0]?.username ?? `#${uid}`;
  }

  /** Validate "3 distinct positive ints" and return them. */
  function parseTeam(raw: unknown): number[] {
    if (!Array.isArray(raw) || raw.length !== TEAM_SIZE) bad(`需要 ${TEAM_SIZE} 只不同的宝可梦`);
    const ids = (raw as unknown[]).map(Number);
    const ok = ids.every((n) => Number.isInteger(n) && n > 0) && new Set(ids).size === TEAM_SIZE;
    if (!ok) bad(`需要 ${TEAM_SIZE} 只不同的宝可梦`);
    return ids;
  }

  /** Every card in ids must exist in the catalog and be owned by uid. */
  async function assertOwnedCards(uid: number, ids: number[]): Promise<void> {
    const { rowCount } = await q(
      `SELECT 1 FROM user_cards uc JOIN cards c ON c.id = uc.card_id
       WHERE uc.user_id = $1 AND uc.count >= 1 AND c.id = ANY($2)`,
      [uid, ids]);
    if ((rowCount ?? 0) !== ids.length) throw new HttpError(403, "只能使用收藏中拥有的宝可梦");
  }

  /** True if uid's saved battle team contains cardId (card_ids is integer[]). */
  async function inBattleTeam(uid: number, cardId: number): Promise<boolean> {
    const { rowCount } = await q(
      `SELECT 1 FROM user_teams WHERE user_id = $1 AND $2 = ANY(card_ids)`,
      [uid, cardId]);
    return (rowCount ?? 0) > 0;
  }

  // ---- friendships ---------------------------------------------------------

  router.post("/api/friends/request", wrap(async (req, res) => {
    const me = await requireUser(req);
    const username = String(req.body?.username ?? "").trim();
    if (!username) bad("请填写对方用户名");
    const { rows: targetRows } = await q<{ id: number; username: string }>(
      `SELECT id::int AS id, username FROM users WHERE username = $1`, [username]);
    const target = targetRows[0];
    if (!target) throw new HttpError(404, "用户不存在");
    if (target.id === me.id) bad("不能添加自己为好友");
    if (await areFriends(me.id, target.id)) throw new HttpError(409, "你们已经是好友了");

    // Reverse pending request → mutual consent, befriend immediately.
    const { rows: reverse } = await q<{ id: number }>(
      `SELECT id FROM friend_requests WHERE from_uid = $1 AND to_uid = $2 AND status = 1`,
      [target.id, me.id]);
    if (reverse[0]) {
      const [a, b] = pair(me.id, target.id);
      await tx(async (client) => {
        await client.query(
          `INSERT INTO friendships (user_a, user_b) VALUES ($1, $2)
           ON CONFLICT (user_a, user_b) DO NOTHING`, [a, b]);
        await client.query(
          `UPDATE friend_requests SET status = $3, handled_at = now()
           WHERE status = 1 AND ((from_uid = $1 AND to_uid = $2) OR (from_uid = $2 AND to_uid = $1))`,
          [me.id, target.id, FRIEND_REQ_STATUS.ACCEPTED]);
      });
      res.json({ ok: true, friends: true, message: `你们互发了申请,已自动成为好友` });
      return;
    }

    try {
      await q(
        `INSERT INTO friend_requests (from_uid, to_uid) VALUES ($1, $2)`,
        [me.id, target.id]);
    } catch (err: any) {
      if (err?.code === "23505") throw new HttpError(409, "已发送过申请,等对方处理吧");
      throw err;
    }
    res.json({ ok: true, friends: false, message: `已向 ${target.username} 发出好友申请` });
  }));

  router.get("/api/friends", wrap(async (req, res) => {
    const me = await requireUser(req);
    // BIGSERIAL ids arrive as strings — hand the client numbers
    const friends = (await q<{ id: number; username: string; since: string }>(
      `SELECT u.id, u.username, f.created_at AS since
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
       WHERE f.user_a = $1 OR f.user_b = $1
       ORDER BY f.created_at DESC`, [me.id])).rows
      .map((f) => ({ ...f, id: Number(f.id) }));
    const incoming = (await q<{ id: number; from_uid: number; username: string; created_at: string }>(
      `SELECT r.id, r.from_uid, u.username, r.created_at
       FROM friend_requests r JOIN users u ON u.id = r.from_uid
       WHERE r.to_uid = $1 AND r.status = $2 ORDER BY r.created_at DESC`,
      [me.id, FRIEND_REQ_STATUS.PENDING])).rows
      .map((r) => ({ ...r, id: Number(r.id), from_uid: Number(r.from_uid) }));
    const outgoing = (await q<{ id: number; to_uid: number; username: string; created_at: string }>(
      `SELECT r.id, r.to_uid, u.username, r.created_at
       FROM friend_requests r JOIN users u ON u.id = r.to_uid
       WHERE r.from_uid = $1 AND r.status = $2 ORDER BY r.created_at DESC`,
      [me.id, FRIEND_REQ_STATUS.PENDING])).rows
      .map((r) => ({ ...r, id: Number(r.id), to_uid: Number(r.to_uid) }));
    res.json({ friends, incoming, outgoing });
  }));

  router.post("/api/friends/requests/:id/accept", wrap(async (req, res) => {
    const me = await requireUser(req);
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId)) bad("无效的申请");
    const [a, b] = await tx(async (client) => {
      const { rows } = await client.query<{ from_uid: number; to_uid: number }>(
        `SELECT from_uid, to_uid FROM friend_requests WHERE id = $1 FOR UPDATE`, [requestId]);
      const reqRow = rows[0];
      // to_uid is checked here (not just in SQL) so a foreign id reads as "not found"
      if (!reqRow || reqRow.to_uid !== me.id) throw new HttpError(404, "申请不存在");
      if ((await friendCount(me.id)) >= FRIEND_CAP) throw new HttpError(409, `好友最多 ${FRIEND_CAP} 人`);
      if ((await friendCount(reqRow.from_uid)) >= FRIEND_CAP) throw new HttpError(409, "对方好友已达上限");
      const [x, y] = pair(reqRow.from_uid, reqRow.to_uid);
      await client.query(
        `INSERT INTO friendships (user_a, user_b) VALUES ($1, $2)
         ON CONFLICT (user_a, user_b) DO NOTHING`, [x, y]);
      await client.query(
        `UPDATE friend_requests SET status = $2, handled_at = now()
         WHERE id = $1 AND status = $3`, [requestId, FRIEND_REQ_STATUS.ACCEPTED, FRIEND_REQ_STATUS.PENDING]);
      return [reqRow.from_uid, reqRow.to_uid] as const;
    });
    res.json({ ok: true, friend: { uid: a === me.id ? b : a, username: await usernameOf(a === me.id ? b : a) } });
  }));

  router.post("/api/friends/requests/:id/decline", wrap(async (req, res) => {
    const me = await requireUser(req);
    const requestId = Number(req.params.id);
    const { rowCount } = await q(
      `UPDATE friend_requests SET status = $3, handled_at = now()
       WHERE id = $1 AND to_uid = $2 AND status = $4`,
      [requestId, me.id, FRIEND_REQ_STATUS.DECLINED, FRIEND_REQ_STATUS.PENDING]);
    if ((rowCount ?? 0) === 0) throw new HttpError(404, "申请不存在或已处理");
    res.json({ ok: true });
  }));

  router.delete("/api/friends/:uid", wrap(async (req, res) => {
    const me = await requireUser(req);
    const other = Number(req.params.uid);
    if (!Number.isInteger(other)) bad("无效的用户");
    const [x, y] = pair(me.id, other);
    await tx(async (client) => {
      await client.query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
      // pending proposals between the pair die with the friendship
      await client.query(
        `UPDATE card_trades SET status = $3, handled_at = now()
         WHERE status = $4 AND ((from_uid = $1 AND to_uid = $2) OR (from_uid = $2 AND to_uid = $1))`,
        [x, y, TRADE_STATUS.DECLINED, TRADE_STATUS.PENDING]);
      await client.query(
        `UPDATE friend_battles SET status = $3, finished_at = now()
         WHERE status = $4 AND ((challenger_uid = $1 AND target_uid = $2) OR (challenger_uid = $2 AND target_uid = $1))`,
        [x, y, FBATTLE_STATUS.DECLINED, FBATTLE_STATUS.PENDING]);
    });
    res.json({ ok: true });
  }));

  /** Friend's collection (name/rarity/count only) — powers the "ask" picker. */
  router.get("/api/friends/:uid/cards", wrap(async (req, res) => {
    const me = await requireUser(req);
    const other = Number(req.params.uid);
    if (!Number.isInteger(other)) bad("无效的用户");
    if (other === me.id || !(await areFriends(me.id, other))) {
      throw new HttpError(403, "只能查看好友的卡池");
    }
    const { rows } = await q(
      `SELECT c.id, c.name, c.zh_name, c.rarity, c.sprite, uc.count
       FROM user_cards uc JOIN cards c ON c.id = uc.card_id
       WHERE uc.user_id = $1 AND uc.count >= 1
       ORDER BY c.id`, [other]);
    res.json({ cards: rows });
  }));

  // ---- card trades (gift / ask) --------------------------------------------

  router.post("/api/friends/:uid/trades", wrap(async (req, res) => {
    const me = await requireUser(req);
    const other = Number(req.params.uid);
    const kind = req.body?.kind === "gift" ? TRADE_KIND.GIFT : req.body?.kind === "ask" ? TRADE_KIND.ASK : 0;
    const cardId = Number(req.body?.cardId);
    if (!Number.isInteger(other) || !kind) bad("参数不正确");
    if (!Number.isInteger(cardId) || cardId <= 0) bad("无效的卡片");
    if (other === me.id) bad("不能对自己发起赠送/索要");
    if (!(await areFriends(me.id, other))) throw new HttpError(403, "只能与好友交易");
    const { rows: card } = await q(`SELECT id FROM cards WHERE id = $1`, [cardId]);
    if (!card[0]) throw new HttpError(404, "没有这张卡");

    const { rows: pend } = await q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM card_trades WHERE from_uid = $1 AND status = $2`,
      [me.id, TRADE_STATUS.PENDING]);
    if (Number(pend[0].n) >= PENDING_TRADES_CAP) throw new HttpError(429, `挂起的赠送/索要最多 ${PENDING_TRADES_CAP} 个,先处理一下`);

    if (kind === TRADE_KIND.GIFT) {
      // I give away: I must hold it; the last copy must not be on my battle team.
      const { rows: hold } = await q<{ count: number }>(
        `SELECT count FROM user_cards WHERE user_id = $1 AND card_id = $2`, [me.id, cardId]);
      if ((hold[0]?.count ?? 0) < 1) throw new HttpError(403, "你还没有这张卡");
      if (hold[0].count === 1 && (await inBattleTeam(me.id, cardId))) {
        throw new HttpError(409, "这是你唯一的一张且正在出战编队里,先换下编队再送");
      }
    } else {
      // I ask: the target must hold it now (hard-checked again at accept).
      const { rowCount } = await q(
        `SELECT 1 FROM user_cards WHERE user_id = $1 AND card_id = $2 AND count >= 1`, [other, cardId]);
      if ((rowCount ?? 0) === 0) throw new HttpError(403, "对方还没有这张卡");
    }
    await q(
      `INSERT INTO card_trades (kind, from_uid, to_uid, card_id) VALUES ($1, $2, $3, $4)`,
      [kind, me.id, other, cardId]);
    res.json({ ok: true });
  }));

  router.get("/api/friends/trades", wrap(async (req, res) => {
    const me = await requireUser(req);
    const { rows } = await q<any>(
      `SELECT t.id, t.kind, t.from_uid, t.to_uid, t.created_at,
              cu.username AS from_name, tu.username AS to_name,
              c.id AS card_id, c.name, c.zh_name, c.rarity,
              (SELECT uc.count FROM user_cards uc
               WHERE uc.user_id = (CASE WHEN t.kind = 1 THEN t.from_uid ELSE t.to_uid END)
                 AND uc.card_id = t.card_id) AS holder_count
       FROM card_trades t
       JOIN users cu ON cu.id = t.from_uid
       JOIN users tu ON tu.id = t.to_uid
       JOIN cards c ON c.id = t.card_id
       WHERE t.status = $2 AND (t.to_uid = $1 OR t.from_uid = $1)
       ORDER BY t.created_at DESC`,
      [me.id, TRADE_STATUS.PENDING]);
    // BIGSERIAL ids arrive as strings — hand the client numbers
    for (const r of rows) { r.id = Number(r.id); }
    const incoming = rows.filter((r) => r.to_uid === me.id);
    const outgoing = rows.filter((r) => r.from_uid === me.id);
    res.json({ incoming, outgoing });
  }));

  router.post("/api/trades/:id/accept", wrap(async (req, res) => {
    const me = await requireUser(req);
    const tradeId = Number(req.params.id);
    if (!Number.isInteger(tradeId)) bad("无效的请求");
    const result = await tx(async (client) => {
      const { rows } = await client.query<{ kind: number; from_uid: number; to_uid: number; card_id: number; status: number }>(
        `SELECT kind, from_uid, to_uid, card_id, status FROM card_trades WHERE id = $1 FOR UPDATE`, [tradeId]);
      const trade = rows[0];
      if (!trade) throw new HttpError(404, "该请求不存在");
      if (trade.to_uid !== me.id) throw new HttpError(403, "只能处理发给你的请求");
      if (trade.status !== TRADE_STATUS.PENDING) throw new HttpError(409, "该请求已被处理");

      // kind=1 gift: from → to.  kind=2 ask: to → from (target gives on accept).
      const giver = trade.kind === TRADE_KIND.GIFT ? trade.from_uid : trade.to_uid;
      const receiver = trade.kind === TRADE_KIND.GIFT ? trade.to_uid : trade.from_uid;
      if (!(await areFriends(giver, receiver))) throw new HttpError(403, "你们已不是好友,交易取消");

      const { rows: hold } = await client.query<{ count: number }>(
        `SELECT count FROM user_cards WHERE user_id = $1 AND card_id = $2 FOR UPDATE`,
        [giver, trade.card_id]);
      if (!hold[0] || hold[0].count < 1) throw new HttpError(409, "发起方已经没有这张卡了,交易失效");
      if (hold[0].count === 1 && (await inBattleTeam(giver, trade.card_id))) {
        throw new HttpError(409, "这张卡是持有方唯一一张且在出战编队里,无法交割");
      }
      const newCount = hold[0].count - 1;
      if (newCount === 0) {
        await client.query(`DELETE FROM user_cards WHERE user_id = $1 AND card_id = $2`, [giver, trade.card_id]);
      } else {
        await client.query(`UPDATE user_cards SET count = $3 WHERE user_id = $1 AND card_id = $2`,
          [giver, trade.card_id, newCount]);
      }
      await client.query(
        `INSERT INTO user_cards (user_id, card_id, count) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, card_id) DO UPDATE SET count = user_cards.count + 1`,
        [receiver, trade.card_id]);
      await client.query(`UPDATE card_trades SET status = $2, handled_at = now() WHERE id = $1`,
        [tradeId, TRADE_STATUS.DONE]);
      return { giver, receiver, cardId: trade.card_id, kind: trade.kind };
    });
    const giverName = await usernameOf(result.giver);
    const receiverName = await usernameOf(result.receiver);
    res.json({
      ok: true,
      message: result.kind === TRADE_KIND.GIFT
        ? `已收下 ${giverName} 赠送的宝可梦`
        : `${receiverName} 已收到你的宝可梦`,
    });
  }));

  const closeTrade = (newStatus: number, who: "from" | "to") =>
    wrap(async (req, res) => {
      const me = await requireUser(req);
      const tradeId = Number(req.params.id);
      const col = who === "from" ? "from_uid" : "to_uid";
      const { rowCount } = await q(
        `UPDATE card_trades SET status = $3, handled_at = now()
         WHERE id = $1 AND ${col} = $2 AND status = $4`,
        [tradeId, me.id, newStatus, TRADE_STATUS.PENDING]);
      if ((rowCount ?? 0) === 0) throw new HttpError(404, "请求不存在或已处理");
      res.json({ ok: true });
    });

  router.post("/api/trades/:id/decline", closeTrade(TRADE_STATUS.DECLINED, "to"));
  router.post("/api/trades/:id/cancel", closeTrade(TRADE_STATUS.CANCELED, "from"));

  // ---- friend battles (async PvP) -------------------------------------------

  router.post("/api/friends/:uid/challenge", wrap(async (req, res) => {
    const me = await requireUser(req);
    const other = Number(req.params.uid);
    const ids = parseTeam(req.body?.cardIds);
    if (!Number.isInteger(other)) bad("无效的用户");
    if (other === me.id) bad("不能挑战自己");
    if (!(await areFriends(me.id, other))) throw new HttpError(403, "只能挑战好友");
    await assertOwnedCards(me.id, ids);
    const { rows: pend } = await q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM friend_battles WHERE challenger_uid = $1 AND status = $2`,
      [me.id, FBATTLE_STATUS.PENDING]);
    if (Number(pend[0].n) >= PENDING_CHALLENGES_CAP) throw new HttpError(429, "你发出的战书太多了,先等等对方应战");
    const { rows } = await q<{ id: number }>(
      `INSERT INTO friend_battles (challenger_uid, target_uid, challenger_team)
       VALUES ($1, $2, $3) RETURNING id`, [me.id, other, JSON.stringify(ids)]);
    res.json({ ok: true, battleId: Number(rows[0].id) });
  }));

  router.get("/api/friends/battles", wrap(async (req, res) => {
    const me = await requireUser(req);
    const rows = (await q<any>(
      `SELECT b.id, b.challenger_uid, b.target_uid, b.challenger_team, b.status,
              b.winner_uid, b.created_at, b.finished_at,
              cu.username AS challenger_name, tu.username AS target_name
       FROM friend_battles b
       JOIN users cu ON cu.id = b.challenger_uid
       JOIN users tu ON tu.id = b.target_uid
       WHERE b.status IN ($2, $3) AND (b.challenger_uid = $1 OR b.target_uid = $1)
       ORDER BY b.created_at DESC LIMIT 50`,
      [me.id, FBATTLE_STATUS.PENDING, FBATTLE_STATUS.FINISHED])).rows
      .map((r) => ({ ...r, id: Number(r.id) }));
    res.json({
      incoming: rows.filter((r) => r.target_uid === me.id && r.status === FBATTLE_STATUS.PENDING),
      outgoing: rows.filter((r) => r.challenger_uid === me.id && r.status === FBATTLE_STATUS.PENDING),
      finished: rows.filter((r) => r.status === FBATTLE_STATUS.FINISHED),
    });
  }));

  /**
   * Symmetric move/switch brain — the engine's own rule logic expressed for
   * either side (chooseAiAction is hardcoded to act for aiTeam, so calling it
   * for both sides would make BOTH actions control the defender).
   */
  function actionFor(state: BattleState, side: "user" | "ai"): Action {
    const mine = side === "user" ? state.userTeam : state.aiTeam;
    const idx = side === "user" ? state.activeUser : state.activeAi;
    const opp = side === "user"
      ? state.aiTeam[state.activeAi]
      : state.userTeam[state.activeUser];
    const mon = mine[idx];
    const score = (m: Move) =>
      m.power * effectiveness(m.type as PType, opp.types) * (mon.types.includes(m.type) ? 1.5 : 1);
    if (mon.hp < mon.maxHp * 0.3) {
      let bestIdx = -1;
      let bestScore = Math.max(...mon.moves.map(score)) * 1.5; // switching must dominate
      mine.forEach((m, i) => {
        if (i !== idx && m.hp > 0) {
          const s = Math.max(...m.moves.map(score));
          if (s > bestScore) { bestScore = s; bestIdx = i; }
        }
      });
      if (bestIdx >= 0) return { kind: "switch", index: bestIdx };
    }
    const move = mon.moves.reduce((a, b) => (score(b) > score(a) ? b : a), mon.moves[0]);
    return { kind: "move", moveId: move.id };
  }

  /**
   * Simulate a full battle with the shared engine. Both sides are driven by the
   * symmetric rule brain — deterministic given the battle id seed, so the stored
   * report is the single source of truth for both players.
   */
  async function simulate(battleId: number, challengerCards: any[], targetCards: any[]) {
    const state: BattleState = {
      userTeam: challengerCards.map(battleMonFromCard),
      aiTeam: targetCards.map(battleMonFromCard),
      activeUser: 0,
      activeAi: 0,
      turn: 1,
      status: "active",
      mode: "rule",
      log: [],
    };
    const rng = seededRng(battleId % 2147483647);
    let guard = 0;
    while (state.status === "active" && guard++ < TURN_CAP) {
      const { events } = resolveTurn(state, actionFor(state, "user"), actionFor(state, "ai"), rng);
      for (const e of events) state.log?.push({ turn: state.turn, kind: e.kind, actor: e.actor, text: e.text });
    }
    let winner: "challenger" | "target" | null;
    if (state.status === "won") winner = "challenger";
    else if (state.status === "lost") winner = "target";
    else {
      const hp = (t: any[]) => t.reduce((s, m) => s + m.hp / m.maxHp, 0);
      const c = hp(state.userTeam), t = hp(state.aiTeam);
      winner = c > t ? "challenger" : t > c ? "target" : null;
    }
    return { state, winner };
  }

  router.post("/api/friend-battles/:id/accept", wrap(async (req, res) => {
    const me = await requireUser(req);
    const battleId = Number(req.params.id);
    if (!Number.isInteger(battleId)) bad("无效的战书");
    const ids = parseTeam(req.body?.cardIds);
    await assertOwnedCards(me.id, ids);

    const outcome = await tx(async (client) => {
      const { rows } = await client.query<{ challenger_uid: number; target_uid: number; challenger_team: number[]; status: number }>(
        `SELECT challenger_uid, target_uid, challenger_team, status FROM friend_battles WHERE id = $1 FOR UPDATE`,
        [battleId]);
      const battle = rows[0];
      if (!battle || battle.target_uid !== me.id) throw new HttpError(404, "战书不存在");
      if (battle.status !== FBATTLE_STATUS.PENDING) throw new HttpError(409, "这封战书已被处理");
      if (!(await areFriends(battle.challenger_uid, me.id))) throw new HttpError(403, "你们已不是好友");
      // Challenger's cards may have been gifted away since the challenge — re-verify.
      await assertOwnedCards(battle.challenger_uid, battle.challenger_team);

      const loadCards = async (cardIds: number[]) => {
        const r = await client.query<any>(
          `SELECT id, name, zh_name, rarity, types, stats, sprite FROM cards WHERE id = ANY($1)`, [cardIds]);
        const sorted = [...r.rows].sort((a: any, b: any) => cardIds.indexOf(a.id) - cardIds.indexOf(b.id));
        return sorted;
      };
      const challengerCards = await loadCards(battle.challenger_team);
      const targetCards = await loadCards(ids);
      if (challengerCards.length !== TEAM_SIZE || targetCards.length !== TEAM_SIZE) {
        throw new HttpError(409, "卡片数据缺失,无法开战");
      }
      const { state, winner } = await simulate(battleId, challengerCards, targetCards);

      // Rewards: settle in this transaction; daily cap per account (anti-farm).
      // Cap check tolerates a rare double-settle race — worst case one extra
      // small reward, never a wrong balance.
      const rewardable = async (uid: number) => {
        const r = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM friend_battles
           WHERE status = $2 AND id <> $3 AND finished_at >= date_trunc('day', now())
             AND (challenger_uid = $1 OR target_uid = $1)`,
          [uid, FBATTLE_STATUS.FINISHED, battleId]);
        return Number(r.rows[0].n) < PVP_REWARD_DAILY_CAP;
      };
      const pay = async (uid: number, amount: number, detail: string) => {
        await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [amount, uid]);
        await client.query(`INSERT INTO wallet_tx (user_id, amount, kind, detail) VALUES ($1, $2, 'battle', $3)`,
          [uid, amount, detail]);
      };
      const winnerUid = winner === "challenger" ? battle.challenger_uid : winner === "target" ? battle.target_uid : null;
      const loserUid = winner === "challenger" ? battle.target_uid : winner === "target" ? battle.challenger_uid : null;
      if (winnerUid && (await rewardable(winnerUid))) {
        await pay(winnerUid, REWARD_WIN, `好友对战:胜 ${(await usernameOf(loserUid!))}`);
      }
      if (loserUid && (await rewardable(loserUid))) {
        await pay(loserUid, REWARD_LOSE, `好友对战:负 ${(await usernameOf(winnerUid!))}`);
      }
      if (!winnerUid) {
        for (const uid of [battle.challenger_uid, battle.target_uid]) {
          if (await rewardable(uid)) await pay(uid, REWARD_DRAW, `好友对战:平`);
        }
      }
      await client.query(
        `UPDATE friend_battles
         SET status = $2, target_team = $3, winner_uid = $4, battle_log = $5, finished_at = now()
         WHERE id = $1`,
        [battleId, FBATTLE_STATUS.FINISHED, JSON.stringify(ids), winnerUid, JSON.stringify(state.log ?? [])]);
      return { winner, winnerUid, log: state.log ?? [] };
    });

    res.json({
      ok: true,
      winner: outcome.winner, // from the challenger's perspective
      winnerUid: outcome.winnerUid,
      isWinner: outcome.winnerUid === me.id,
      draw: outcome.winner === null,
      log: outcome.log,
    });
  }));

  const closeBattle = (newStatus: number, who: "challenger" | "target") =>
    wrap(async (req, res) => {
      const me = await requireUser(req);
      const battleId = Number(req.params.id);
      const col = who === "challenger" ? "challenger_uid" : "target_uid";
      const { rowCount } = await q(
        `UPDATE friend_battles SET status = $3, finished_at = now()
         WHERE id = $1 AND ${col} = $2 AND status = $4`,
        [battleId, me.id, newStatus, FBATTLE_STATUS.PENDING]);
      if ((rowCount ?? 0) === 0) throw new HttpError(404, "战书不存在或已处理");
      res.json({ ok: true });
    });

  router.post("/api/friend-battles/:id/decline", closeBattle(FBATTLE_STATUS.DECLINED, "target"));
  router.post("/api/friend-battles/:id/cancel", closeBattle(FBATTLE_STATUS.CANCELED, "challenger"));

  router.get("/api/friend-battles/:id", wrap(async (req, res) => {
    const me = await requireUser(req);
    const battleId = Number(req.params.id);
    if (!Number.isInteger(battleId)) bad("无效的战书");
    const { rows } = await q<any>(
      `SELECT b.*, cu.username AS challenger_name, tu.username AS target_name
       FROM friend_battles b
       JOIN users cu ON cu.id = b.challenger_uid
       JOIN users tu ON tu.id = b.target_uid
       WHERE b.id = $1`, [battleId]);
    const battle = rows[0];
    if (!battle) throw new HttpError(404, "战书不存在");
    if (battle.challenger_uid !== me.id && battle.target_uid !== me.id) {
      throw new HttpError(403, "只能查看自己的对战");
    }
    battle.id = Number(battle.id);
    res.json({ battle });
  }));

  return router;
}
