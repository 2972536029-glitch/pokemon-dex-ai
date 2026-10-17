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
import { requireUser } from "./http.js";
import { HttpError, wrap } from "./http.js";
import { allowRate } from "./ratelimit.js";
import { addWalletTx } from "./wallet.js";
import { AUTH_CONSTANTS } from "./auth.js";
import {
  BattleState, Intent, battleMonFromCard, chooseAiAction, pickAiTeam,
  resolveTurn, resolveBattleTurn, generateAiIntent, intentToAction,
  intentStillValid, Action, V3Action, LogEntry, clampBattleState,
} from "./battle.js";
import { chooseAiIntentReasoned } from "./battle-ai.js";

const BATTLE_REWARD = 100;
const TEAM_SIZE = 3;
/** PvE 奖励的滚动 24h 结算上限(与 PvP 的 cap 同款思路)。没有它,脚本
 *  循环 start→win 每场 100 币无限刷——全站最大的经济水龙头(v3.1 审计 P0-2)。 */
const BATTLE_REWARD_DAILY_CAP = 10;

/** Signal that aborts when the CLIENT disconnects mid-turn (bounded by the
 *  12s model timeout anyway — this just stops paying for an unread answer). */
function clientSignal(req: express.Request): AbortSignal {
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  return ac.signal;
}

export function mountBattle(): express.Router {
  const router = express.Router();

  // ---- save battle team (must be 3 DISTINCT owned cards) --------------------
  router.post("/api/battle/team", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
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

  router.get("/api/battle/team", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    const { rows } = await q<{ card_ids: number[] }>(`SELECT card_ids FROM user_teams WHERE user_id = $1`, [user.id]);
    res.json({ cardIds: rows[0]?.card_ids ?? [] });
  }));

  // ---- start: build state from the saved team + a random AI team ------------
  // ---- history:已结束对战的摘要 + 总胜负(战绩页/大厅用) ----
  router.get("/api/battle/history", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    const { rows } = await q(
      `SELECT status, state->>'mode' AS mode, state->>'turn' AS turns,
              finished_at
       FROM battles WHERE user_id = $1 AND status <> 'active'
       ORDER BY finished_at DESC NULLS LAST LIMIT 20`,
      [user.id]
    );
    const wins = rows.filter((r) => r.status === "won").length;
    res.json({
      wins,
      losses: rows.length - wins,
      battles: rows.map((r) => ({
        status: r.status,
        mode: r.mode,
        turns: Number(r.turns) || 0,
        finished_at: r.finished_at,
      })),
    });
  }));

  router.post("/api/battle/start", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    // v3.1:成本护栏——开战也走 DB 限流(用户维度),挡住脚本循环开局的滥用面
    if (!(await allowRate(`bstart:${user.id}`, 30, 600))) {
      res.status(429).json({ error: "rate_limited", message: "开战太频繁了,休息一下再战" });
      return;
    }
    const mode = req.body?.mode === "reasoned" ? "reasoned" : "rule";
    // one active battle per user: reuse instead of stacking
    const existing = await q<{ id: string; state: BattleState }>(
      `SELECT id, state FROM battles WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (existing.rows[0]) {
      res.json({ battleId: existing.rows[0].id, state: clampBattleState(existing.rows[0].state), resumed: true });
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
      `SELECT id, name, zh_name, rarity, types, stats, sprite FROM cards ORDER BY random() LIMIT ${TEAM_SIZE}`
    )).rows;

    // v3 引擎:四档招式 + 能量 + 意图。开局即掷定 AI 首个意图(规则脑,
    // reasoned 模式从第二回合起才由模型接手——开战响应不为此多等一次模型)。
    const state: BattleState = {
      userTeam: userCards.map((c: any) => battleMonFromCard(c, { v3: true })),
      aiTeam: aiPool.map((c: any) => battleMonFromCard(c, { v3: true })),
      activeUser: 0,
      activeAi: 0,
      turn: 1,
      status: "active",
      mode,
      version: 3,
      aiIntent: null,
    };
    const intentRng = { next: () => crypto.randomBytes(4).readUInt32BE(0) / 0x1_0000_0000 };
    if (mode === "reasoned") {
      // reasoned 模式开局意图也问模型(理由随意图存储、执行时入日志,保证
      // "第一回合就有理由且与行动同回合"——开战多等一次模型,换来日志真实性)
      try {
        const chosen = await chooseAiIntentReasoned(state, AbortSignal.timeout(12_000));
        chosen.intent.reason = chosen.reason;
        state.aiIntent = chosen.intent;
      } catch (err: any) {
        console.warn("[battle] opening reasoned intent fell back to rules:", err?.message);
        state.aiIntent = generateAiIntent(state, intentRng);
      }
    } else {
      state.aiIntent = generateAiIntent(state, intentRng);
    }
    const id = crypto.randomUUID();
    try {
      await q(
        `INSERT INTO battles (id, user_id, state, status) VALUES ($1, $2, $3, 'active')`,
        [id, user.id, JSON.stringify(state)]
      );
    } catch (err: any) {
      // 并发 start 撞 uq_battles_active_user(一人一场 active):回落到复用分支,
      // 而不是 500(v3.1 审计 P1-4,索引见 schema.ts)
      if (err?.code !== "23505") throw err;
      const existing = await q<{ id: string; state: BattleState }>(
        `SELECT id, state FROM battles WHERE user_id = $1 AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      if (existing.rows[0]) {
        res.json({ battleId: existing.rows[0].id, state: clampBattleState(existing.rows[0].state), resumed: true });
        return;
      }
      throw err;
    }
    res.json({ battleId: id, state });
  }));

  // ---- helpers ---------------------------------------------------------------
  async function loadOwnedBattle(req: express.Request, userId: number) {
    const id = String(req.params.id ?? "");
    if (!/^[a-f0-9-]{10,64}$/i.test(id)) {
      throw new HttpError(404, "战斗不存在", "not_found");
    }
    const { rows } = await q<{ id: string; state: BattleState; status: string }>(
      `SELECT id, state, status FROM battles WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!rows[0]) throw new HttpError(404, "战斗不存在", "not_found");
    return rows[0];
  }

  // ---- state -----------------------------------------------------------------
  router.get("/api/battle/active", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    const { rows } = await q<{ id: string; state: BattleState }>(
      `SELECT id, state FROM battles WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    res.json(rows[0] ? { battleId: rows[0].id, state: clampBattleState(rows[0].state) } : { battleId: null });
  }));

  router.get("/api/battle/:id/state", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    const row = await loadOwnedBattle(req, user.id);
    res.json({ battleId: row.id, state: clampBattleState(row.state), status: row.status });
  }));

  // ---- turn ------------------------------------------------------------------
  router.post("/api/battle/:id/turn", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    const row = await loadOwnedBattle(req, user.id);
    if (row.status !== "active") {
      res.status(409).json({ error: "finished", message: "这场战斗已经结束了" });
      return;
    }
    const isV3 = row.state.version === 3;
    const action = req.body?.action ?? {};
    const valid =
      (action.kind === "move" && typeof action.moveId === "string") ||
      (action.kind === "switch" && Number.isInteger(action.index)) ||
      (isV3 && action.kind === "guard"); // guard only exists in the v3 engine
    if (!valid) {
      res.status(400).json({ error: "invalid_action", message: "无效的行动" });
      return;
    }
    // v3.1:回合限流(用户维度)。reasoned 模式每回合一次 LLM 调用,且并发重试
    // 会在乐观锁 409 之前先付模型费——限流把这层成本放大按住(审计 P1-2)。
    if (!(await allowRate(`bturn:${user.id}`, 60, 600))) {
      res.status(429).json({ error: "rate_limited", message: "操作太频繁,请稍候" });
      return;
    }

    const turnNo = row.state.turn; // log entries belong to THIS turn
    const rng = { next: () => crypto.randomBytes(4).readUInt32BE(0) / 0x1_0000_0000 };
    let events;
    let state: BattleState;
    let aiReason: string | null = null;
    let committedReason: string | null = null; // v3:committed 意图自带的理由,执行时入日志

    if (isV3) {
      // v3: AI executes its COMMITTED intent (telegraphed to the player).
      // If it no longer fits the board (mon changed / unaffordable), roll a
      // fresh mixed-strategy pick — never stall.
      const validIntent = intentStillValid(row.state, row.state.aiIntent) ? row.state.aiIntent : null;
      const committed = validIntent ?? generateAiIntent(row.state, rng);
      committedReason = committed.reason ?? null; // 执行时入日志(真配对)
      const aiAction: V3Action = intentToAction(committed) ?? { kind: "guard" };
      ({ state, events } = resolveBattleTurn(row.state, action as V3Action, aiAction, rng));
    } else {
      // legacy path (pre-v3 active battles + unchanged semantics).
      // Reasoned flavor is v3-only here: legacy reasoned battles fall to the
      // rule brain (they are transient — every battle ends and disappears).
      let aiAction: Action | null = null;
      if (row.state.mode === "reasoned") {
        aiReason = "旧版战斗结算中,本轮使用规则策略";
      }
      if (!aiAction) aiAction = chooseAiAction(row.state);
      ({ state, events } = resolveTurn(row.state, action as Action, aiAction, rng));
    }

    // Persist the turn narrative inside the state snapshot so a page reload
    // can still show the full battle log (state is the single source).
    const logEntries: LogEntry[] = [
      ...((row.state.log ?? []) as LogEntry[]),
      ...events.map((e) => ({ turn: turnNo, kind: e.kind, actor: e.actor, text: e.text })),
    ];
    // v3: committed 意图的 reason 在执行时入日志——与真实行动同回合配对
    if (isV3 && committedReason) {
      logEntries.push({ turn: turnNo, kind: "reason", actor: "ai", text: committedReason });
    }

    // v3: after resolution, roll the NEXT telegraphed intent (reasoned mode
    // asks the model with the post-turn board; falls back to mixed strategy).
    if (isV3 && state.status === "active") {
      if (state.mode === "reasoned") {
        try {
          const chosen = await chooseAiIntentReasoned(state, clientSignal(req));
          state.aiIntent = chosen.intent;
          state.aiIntent.reason = chosen.reason;
        } catch (err: any) {
          console.warn("[battle] reasoned intent fell back to mixed strategy:", err?.message);
          state.aiIntent = generateAiIntent(state, rng);
        }
      } else {
        state.aiIntent = generateAiIntent(state, rng);
      }
    } else if (isV3) {
      state.aiIntent = null;
    }
    if (aiReason) {
      logEntries.push({ turn: turnNo, kind: "reason", actor: "ai", text: aiReason });
    }
    state.log = logEntries;

    let reward = 0;
    const finished = state.status !== "active";
    if (finished && state.status === "won") {
      // 滚动 24h 奖励 cap:钱包账本本身就是结算依据(wallet_tx kind='battle'),
      // 不需要新表——对账口径与 PvP 的 rewardable() 一致(QA-037 时区纪律:滚动窗)
      const { rows: paid } = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM wallet_tx
         WHERE user_id = $1 AND kind = 'battle' AND amount > 0
           AND created_at > now() - interval '24 hours'`,
        [user.id]
      );
      if (Number(paid[0]?.n ?? 0) < BATTLE_REWARD_DAILY_CAP) {
        reward = BATTLE_REWARD;
      } else {
        (state.log ??= []).push({
          turn: turnNo, kind: "info", actor: "system",
          text: `今日对战奖励已达上限(${BATTLE_REWARD_DAILY_CAP} 场),本场的胜利不再发放图鉴币`,
        });
      }
    }

    // Optimistic lock on battle status (QA-017): two concurrent/retried turns
    // read the same snapshot — only the FIRST write (status still 'active')
    // lands; the loser gets 409 and re-reads the authoritative state. Without
    // this, near-victory double requests would double the reward and revive
    // forfeited fights.
    const updated = await tx(async (client) => {
      const upd = await client.query<{ id: string }>(
        `UPDATE battles SET state = $1, status = $2, finished_at =
           CASE WHEN $2 <> 'active' THEN now() ELSE finished_at END
         WHERE id = $3 AND status = 'active'
         RETURNING id`,
        [JSON.stringify(state), state.status, row.id]
      );
      if (upd.rowCount === 0) return null;
      if (reward > 0) {
        await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [reward, user.id]);
        await client.query(
          `INSERT INTO wallet_tx (user_id, amount, kind, detail) VALUES ($1, $2, 'battle', '对战胜利奖励')`,
          [user.id, reward]
        );
      }
      return upd.rows[0];
    });

    if (!updated) {
      res.status(409).json({ error: "state_changed", message: "战斗状态已变化,请刷新查看最新战况" });
      return;
    }

    res.json({ state, events, reward });
  }));

  router.post("/api/battle/:id/forfeit", wrap("battle", "战斗服务出了点问题,请稍后再试", async (req, res) => {
    const user = await requireUser(req);
    const row = await loadOwnedBattle(req, user.id);
    // Patch BOTH the column and the state snapshot's own status — the state
    // JSONB is what GET /state returns, so updating only the column would
    // leave a "lost" battle that still claims to be active in its snapshot.
    const upd = await q(
      `UPDATE battles SET status = 'lost', finished_at = now(),
         state = jsonb_set(state, '{status}', '"lost"')
       WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [row.id, user.id]
    );
    res.json({ ok: true, alreadyFinished: upd.rowCount === 0 });
  }));

  return router;
}

export { BATTLE_REWARD };
