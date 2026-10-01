// Battle routes: team selection, start, state, turns, forfeit.
//
// Authority rules (the two that matter):
// 1. userId comes from the session only — a battle belongs to its owner and
//    no route accepts a user id from the wire.
// 2. The game math lives in battle.ts; routes only marshal state in/out and
//    persist. The model (in reasoned mode) can never touch these numbers.

import crypto from "node:crypto";
import express from "express";
import { q, tx } from "./db.js";
import { userFromRequest } from "./auth.js";
import { AUTH_CONSTANTS } from "./auth.js";
import {
  BattleState, BattleMon, battleMonFromCard, chooseAiAction, pickAiTeam,
  resolveTurn, Action, LogEntry,
} from "./battle.js";
import { chooseAiActionReasoned } from "./battle-ai.js";

const BATTLE_REWARD = 100;
const TEAM_SIZE = 3;

function req_abort(_req: express.Request): AbortSignal {
  return new AbortController().signal;
}

export function mountBattle(): express.Router {
  const router = express.Router();

  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => {
      fn(req, res).catch((err: unknown) => {
        console.error(`[battle] ${req.method} ${req.path} failed:`, err);
        const status = (err as any)?.status ?? 500;
        const message = status >= 500 ? "战斗服务出了点问题,请稍后再试" : (err as Error)?.message ?? "请求失败";
        res.status(status).json({ error: "battle_error", message });
      });
    };

  const requireUser = async (req: express.Request) => {
    const user = await userFromRequest(req);
    if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
    return user;
  };

  // ---- save battle team (must be 3 DISTINCT owned cards) --------------------
  router.post("/api/battle/team", wrap(async (req, res) => {
    const user = await requireUser(req);
    const ids = (req.body?.cardIds ?? []).map(Number);
    const okShape =
      Array.isArray(ids) && ids.length === TEAM_SIZE &&
      ids.every((n: number) => Number.isInteger(n) && n > 0) &&
      new Set(ids).size === TEAM_SIZE;
    if (!okShape) {
      res.status(400).json({ error: "invalid_team", message: `需要 ${TEAM_SIZE} 只不同的宝可梦` });
      return;
    }
    const owned = await q<{ id: number }>(
      `SELECT c.id FROM user_cards uc JOIN cards c ON c.id = uc.card_id
       WHERE uc.user_id = $1 AND c.id = ANY($2)`,
      [user.id, ids]
    );
    if (owned.rows.length !== TEAM_SIZE) {
      res.status(403).json({ error: "not_owned", message: "只能编入你收藏中拥有的宝可梦" });
      return;
    }
    await q(
      `INSERT INTO user_teams (user_id, card_ids) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET card_ids = $2, updated_at = now()`,
      [user.id, ids]
    );
    res.json({ ok: true, team: ids });
  }));

  router.get("/api/battle/team", wrap(async (req, res) => {
    const user = await requireUser(req);
    const { rows } = await q<{ card_ids: number[] }>(`SELECT card_ids FROM user_teams WHERE user_id = $1`, [user.id]);
    res.json({ cardIds: rows[0]?.card_ids ?? [] });
  }));

  // ---- start: build state from the saved team + a random AI team ------------
  router.post("/api/battle/start", wrap(async (req, res) => {
    const user = await requireUser(req);
    const mode = req.body?.mode === "reasoned" ? "reasoned" : "rule";
    // one active battle per user: reuse instead of stacking
    const existing = await q<{ id: string; state: BattleState }>(
      `SELECT id, state FROM battles WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (existing.rows[0]) {
      res.json({ battleId: existing.rows[0].id, state: existing.rows[0].state, resumed: true });
      return;
    }

    const teamRow = await q<{ card_ids: number[] }>(`SELECT card_ids FROM user_teams WHERE user_id = $1`, [user.id]);
    const cardIds = teamRow.rows[0]?.card_ids;
    if (!cardIds || cardIds.length !== TEAM_SIZE) {
      res.status(400).json({ error: "no_team", message: "请先在收藏页编入 3 只宝可梦" });
      return;
    }
    const { rows: userCards } = await q<any>(
      `SELECT c.id, c.name, c.zh_name, c.rarity, c.types, c.stats, c.sprite
       FROM user_cards uc JOIN cards c ON c.id = uc.card_id
       WHERE uc.user_id = $1 AND c.id = ANY($2)`,
      [user.id, cardIds]
    );
    if (userCards.length !== TEAM_SIZE) {
      res.status(409).json({ error: "team_stale", message: "编队数据已过期,请重新编队" });
      return;
    }
    // preserve the user's chosen slot order
    userCards.sort((a: any, b: any) => cardIds.indexOf(a.id) - cardIds.indexOf(b.id));

    const aiPool = (await q<any>(
      `SELECT id, name, zh_name, rarity, types, stats FROM cards ORDER BY random() LIMIT ${TEAM_SIZE}`
    )).rows;

    const state: BattleState = {
      userTeam: userCards.map(battleMonFromCard),
      aiTeam: aiPool.map(battleMonFromCard),
      activeUser: 0,
      activeAi: 0,
      turn: 1,
      status: "active",
      mode,
    };
    const id = crypto.randomUUID();
    await q(
      `INSERT INTO battles (id, user_id, state, status) VALUES ($1, $2, $3, 'active')`,
      [id, user.id, JSON.stringify(state)]
    );
    res.json({ battleId: id, state });
  }));

  // ---- helpers ---------------------------------------------------------------
  async function loadOwnedBattle(req: express.Request, userId: number) {
    const id = String(req.params.id ?? "");
    if (!/^[a-f0-9-]{10,64}$/i.test(id)) {
      throw Object.assign(new Error("战斗不存在"), { status: 404 });
    }
    const { rows } = await q<{ id: string; state: BattleState; status: string }>(
      `SELECT id, state, status FROM battles WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!rows[0]) throw Object.assign(new Error("战斗不存在"), { status: 404 });
    return rows[0];
  }

  // ---- state -----------------------------------------------------------------
  router.get("/api/battle/active", wrap(async (req, res) => {
    const user = await requireUser(req);
    const { rows } = await q<{ id: string; state: BattleState }>(
      `SELECT id, state FROM battles WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    res.json(rows[0] ? { battleId: rows[0].id, state: rows[0].state } : { battleId: null });
  }));

  router.get("/api/battle/:id/state", wrap(async (req, res) => {
    const user = await requireUser(req);
    const row = await loadOwnedBattle(req, user.id);
    res.json({ battleId: row.id, state: row.state, status: row.status });
  }));

  // ---- turn ------------------------------------------------------------------
  router.post("/api/battle/:id/turn", wrap(async (req, res) => {
    const user = await requireUser(req);
    const row = await loadOwnedBattle(req, user.id);
    if (row.status !== "active") {
      res.status(409).json({ error: "finished", message: "这场战斗已经结束了" });
      return;
    }
    const action = req.body?.action ?? {};
    const valid =
      (action.kind === "move" && typeof action.moveId === "string") ||
      (action.kind === "switch" && Number.isInteger(action.index));
    if (!valid) {
      res.status(400).json({ error: "invalid_action", message: "无效的行动" });
      return;
    }

    // AI action: reasoned mode asks the model (bounded by a 12s timeout) and
    // falls back to the rule strategy on ANY failure — the battle can never
    // stall because the advisor is down.
    let aiAction: Action | null = null;
    let aiReason: string | null = null;
    if (row.state.mode === "reasoned") {
      try {
        const chosen = await chooseAiActionReasoned(row.state, req_abort(req));
        aiAction = chosen.action;
        aiReason = chosen.reason;
      } catch (err: any) {
        console.warn("[battle] reasoned choice fell back to rules:", err?.message);
        aiReason = "模型暂时不可用,本轮使用规则策略";
      }
    }
    if (!aiAction) aiAction = chooseAiAction(row.state);

    const rng = { next: () => crypto.randomBytes(4).readUInt32BE(0) / 0x1_0000_0000 };
    const { state, events } = resolveTurn(
      row.state,
      action as Action,
      aiAction,
      rng
    );
    // Persist the turn narrative inside the state snapshot so a page reload
    // can still show the full battle log (state is the single source).
    const logEntries: LogEntry[] = [
      ...((row.state.log ?? []) as LogEntry[]),
      ...events.map((e) => ({ turn: row.state.turn, kind: e.kind, actor: e.actor, text: e.text })),
    ];
    if (aiReason) {
      logEntries.push({ turn: row.state.turn, kind: "reason", actor: "ai", text: aiReason });
    }
    state.log = logEntries;

    let reward = 0;
    const finished = state.status !== "active";
    if (finished && state.status === "won") reward = BATTLE_REWARD;

    await tx(async (client) => {
      await client.query(
        `UPDATE battles SET state = $1, status = $2, finished_at =
           CASE WHEN $2 <> 'active' THEN now() ELSE finished_at END
         WHERE id = $3`,
        [JSON.stringify(state), state.status, row.id]
      );
      if (reward > 0) {
        await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [reward, user.id]);
        await client.query(
          `INSERT INTO wallet_tx (user_id, amount, kind, detail) VALUES ($1, $2, 'battle', '对战胜利奖励')`,
          [user.id, reward]
        );
      }
    });

    res.json({ state, events, reward });
  }));

  router.post("/api/battle/:id/forfeit", wrap(async (req, res) => {
    const user = await requireUser(req);
    const row = await loadOwnedBattle(req, user.id);
    if (row.status === "active") {
      row.state.status = "lost";
      await q(
        `UPDATE battles SET state = $1, status = 'lost', finished_at = now() WHERE id = $2`,
        [JSON.stringify(row.state), row.id]
      );
    }
    res.json({ ok: true });
  }));

  return router;
}

export { BATTLE_REWARD };
