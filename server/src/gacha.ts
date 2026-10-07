// Wallet & gacha. The two properties interviewers always probe:
// - spending money is guarded by an OPTIMISTIC LOCK (UPDATE ... WHERE
//   balance >= price, checked via rowCount) — no read-modify-write race.
// - a draw is an ORDER (gacha_orders.id = client idempotency key): a retry
//   with the same key replays the SAME card instead of charging twice.
// - UR PITY (保底): a global counter ticks on every non-UR draw; at the
//   threshold the roll is forced to UR. Counter lives in gacha_pity and is
//   updated inside the draw transaction under a row lock.

import crypto from "node:crypto";
import { q, tx } from "./db.js";
import { AUTH_CONSTANTS } from "./auth.js";

export interface PackDef {
  id: string;
  name: string;
  price: number;
  pity: number;
  weights: { C: number; R: number; UR: number };
}

// Disclosed rates — these exact numbers are served to the client and shown
// on the shop page (概率公示). Rarity pools come from the seeded catalog.
// pity = 各包独立的 UR 硬保底阈值(按 UR 率分层:率越低保底越长)
export const PACKS: PackDef[] = [
  { id: "basic", name: "基础包", price: 50, pity: 60, weights: { C: 0.86, R: 0.12, UR: 0.02 } },
  { id: "advanced", name: "进阶包", price: 120, pity: 30, weights: { C: 0.6, R: 0.32, UR: 0.08 } },
  { id: "legend", name: "传说包", price: 250, pity: 10, weights: { C: 0, R: 0.7, UR: 0.3 } },
];

export function findPack(id: string): PackDef | undefined {
  return PACKS.find((p) => p.id === id);
}

export class GachaError extends Error {
  status: number;
  __dbg?: Record<string, unknown>;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function dailyBonus(userId: number): Promise<{ granted: boolean; balance: number }> {
  // ON CONFLICT DO NOTHING makes the daily grant atomic per (user, day):
  // two concurrent requests → exactly one inserts, one gets the bonus.
  const inserted = await tx(async (client) => {
    const r = await client.query(
      `INSERT INTO daily_bonus (user_id, day) VALUES ($1, CURRENT_DATE)
       ON CONFLICT (user_id, day) DO NOTHING`,
      [userId]
    );
    if (r.rowCount === 0) return false;
    const bonus = AUTH_CONSTANTS.DAILY_BONUS;
    const upd = await client.query<{ balance: number }>(
      `UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance`,
      [bonus, userId]
    );
    await client.query(
      `INSERT INTO wallet_tx (user_id, amount, kind, detail) VALUES ($1, $2, 'daily', '每日登录奖励')`,
      [userId, bonus]
    );
    return upd.rows[0].balance;
  });
  if (inserted === false) {
    const { rows } = await q<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [userId]);
    return { granted: false, balance: rows[0].balance };
  }
  return { granted: true, balance: inserted as number };
}

export async function walletHistory(userId: number) {
  const { rows } = await q(
    `SELECT amount, kind, detail, created_at FROM wallet_tx
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  return rows;
}

interface DrawInput {
  userId: number;
  username?: string;
  packId: string;
  orderId: string;
}

export interface DrawResult {
  card: { id: number; name: string; zh_name: string | null; rarity: string; types: string[]; sprite: string | null; stats: { hp: number } | null };
  balance: number;
  replay: boolean;
  __dbg?: Record<string, unknown>;
}

/** UR 保底:按卡包独立计数,各自阈值内必出 UR(阈值见 PACKS[].pity) */

async function readPity(userId: number, packId: string): Promise<number> {
  const { rows } = await q<{ since_ur: number }>(
    `SELECT since_ur FROM gacha_pity WHERE user_id = $1 AND pack_id = $2`,
    [userId, packId]
  );
  return rows[0]?.since_ur ?? 0;
}

/** 商店页保底进度:按卡包返回各自计数 */
export async function pityStatus(userId: number) {
  const { rows } = await q<{ pack_id: string; since_ur: number }>(
    `SELECT pack_id, since_ur FROM gacha_pity WHERE user_id = $1`,
    [userId]
  );
  const byPack: Record<string, { since_ur: number; remaining: number; limit: number }> = {};
  for (const pack of PACKS) {
    const sinceUr = rows.find((r) => r.pack_id === pack.id)?.since_ur ?? 0;
    byPack[pack.id] = { since_ur: sinceUr, remaining: Math.max(0, pack.pity - sinceUr), limit: pack.pity };
  }
  return byPack;
}

/** 事务内:锁保底行(无则建),返回当前计数 */
async function lockPity(client: any, userId: number, packId: string): Promise<number> {
  await client.query(
    `INSERT INTO gacha_pity (user_id, pack_id, since_ur) VALUES ($1, $2, 0)
     ON CONFLICT (user_id, pack_id) DO NOTHING`,
    [userId, packId]
  );
  const { rows } = await client.query(
    `SELECT since_ur FROM gacha_pity WHERE user_id = $1 AND pack_id = $2 FOR UPDATE`,
    [userId, packId]
  );
  return rows[0]?.since_ur ?? 0;
}

export async function drawCard(input: DrawInput): Promise<DrawResult> {
  const pack = findPack(input.packId);
  if (!pack) throw new GachaError(404, "卡包不存在");
  // Idempotency keys come from the client; a malformed one can't collide or inject.
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(input.orderId)) {
    throw new GachaError(400, "invalid order id");
  }

  // 1) Replay check outside the write path: same key → same card, no charge.
  //    Replays must NOT touch the pity counter (they aren't new draws).
  const existing = await q<{ card_id: number }>(
    `SELECT card_id FROM gacha_orders WHERE order_id = $1 AND user_id = $2`,
    [input.orderId, input.userId]
  );
  if (existing.rows[0]) {
    const card = await q<any>(`SELECT id, name, zh_name, rarity, types, stats, sprite FROM cards WHERE id = $1`, [
      existing.rows[0].card_id,
    ]);
    const bal = await q<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [input.userId]);
    return { card: card.rows[0], balance: bal.rows[0].balance, replay: true };
  }

  // 2) Pity: read THIS pack's counter; at its threshold force UR. Roll + pick
  //    BEFORE the transaction (pure RNG over static catalog data).
  const __dbg = {
    envSet: !!process.env.UNLIMITED_USER_IDS,
    envLen: (process.env.UNLIMITED_USER_IDS ?? "").length,
    username: input.username ?? null,
    unlimited: isUnlimited(input),
  };
  const sinceUr = await readPity(input.userId, pack.id);
  const forceRarity = sinceUr >= pack.pity - 1 ? ("UR" as const) : undefined;
  const rolled = await rollCard(pack, forceRarity);

  // 3) The order: pity update (row-locked) → charge (optimistic lock) →
  //    record order → grant card → log. TRUE concurrent duplicate of the
  //    same orderId: the second tx hits the orders PK and rolls back (no
  //    double charge, pity update also rolls back) — we then serve the
  //    winner's card as a replay instead of a raw 500 (QA-004).
  try {
    return await drawOnce(input, pack, rolled);
  } catch (err: any) {
    if (err?.code === "23505") {
      const winner = await q<{ card_id: number }>(
        `SELECT card_id FROM gacha_orders WHERE order_id = $1 AND user_id = $2`,
        [input.orderId, input.userId]
      );
      if (winner.rows[0]) {
        const card = await q<any>(`SELECT id, name, zh_name, rarity, types, stats, sprite FROM cards WHERE id = $1`, [
          winner.rows[0].card_id,
        ]);
        const bal = await q<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [input.userId]);
        return { card: card.rows[0], balance: bal.rows[0].balance, replay: true };
      }
    }
    throw err;
  }
}

/**
 * 无限金币测试号:UNLIMITED_USER_IDS(环境变量,逗号分隔 user id/用户名)里的
 * 用户抽卡不扣币、余额不足也能抽。值通过环境变量配置而非硬编码用户名——
 * 仓库是公开的,硬编码用户名等于任何人抢注后白嫖。
 */
function isUnlimited(input: { userId: number; username?: string }): boolean {
  const raw = process.env.UNLIMITED_USER_IDS ?? "";
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return list.includes(String(input.userId)) || (!!input.username && list.includes(input.username));
}

async function drawOnce(
  input: DrawInput,
  pack: PackDef,
  rolled: { id: number; rarity: "C" | "R" | "UR" }
): Promise<DrawResult> {
  if (isUnlimited(input)) return drawOnceFree(input, pack, rolled);
  return drawOnceCharged(input, pack, rolled);
}

/** UR 出现时清零该包计数,否则 +1(两通道共用,事务内执行) */
async function bumpPity(client: any, userId: number, packId: string, rarity: "C" | "R" | "UR") {
  await client.query(
    `UPDATE gacha_pity SET since_ur = CASE WHEN $3 = 'UR' THEN 0 ELSE since_ur + 1 END
     WHERE user_id = $1 AND pack_id = $2`,
    [userId, packId, rarity]
  );
}

/** 测试号通道:不扣币、不记扣费流水,其余(保底/订单幂等/发卡)与正常通道一致。 */
async function drawOnceFree(
  input: DrawInput,
  pack: PackDef,
  rolled: { id: number; rarity: "C" | "R" | "UR" }
): Promise<DrawResult> {
  const cardId = rolled.id;
  const balance = await tx(async (client) => {
    await lockPity(client, input.userId, pack.id);
    await bumpPity(client, input.userId, pack.id, rolled.rarity);
    const cur = await client.query<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [input.userId]);
    await client.query(
      `INSERT INTO gacha_orders (order_id, user_id, pack_id, card_id) VALUES ($1, $2, $3, $4)`,
      [input.orderId, input.userId, pack.id, cardId]
    );
    await client.query(
      `INSERT INTO user_cards (user_id, card_id, count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, card_id) DO UPDATE SET count = user_cards.count + 1`,
      [input.userId, cardId]
    );
    return cur.rows[0]?.balance ?? 0;
  });
  const card = await q<any>(`SELECT id, name, zh_name, rarity, types, stats, sprite FROM cards WHERE id = $1`, [cardId]);
  return { card: card.rows[0], balance, replay: false };
}

async function drawOnceCharged(
  input: DrawInput,
  pack: PackDef,
  rolled: { id: number; rarity: "C" | "R" | "UR" }
): Promise<DrawResult> {
  const cardId = rolled.id;
  const __dbg = {
    envSet: !!process.env.UNLIMITED_USER_IDS,
    envLen: (process.env.UNLIMITED_USER_IDS ?? "").length,
    username: input.username ?? null,
    unlimited: isUnlimited(input),
  };
  const result = await tx(async (client) => {
    // 保底行先锁:同用户同包并发抽卡在此串行化,计数不漂移
    await lockPity(client, input.userId, pack.id);
    const upd = await client.query<{ balance: number }>(
      `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
      [pack.price, input.userId]
    );
    if (upd.rowCount === 0) {
      const e = new GachaError(402, "货币不足,先去赚点货币吧(每日登录 +50)");
      e.__dbg = __dbg;
      throw e;
    }
    await bumpPity(client, input.userId, pack.id, rolled.rarity);
    await client.query(
      `INSERT INTO gacha_orders (order_id, user_id, pack_id, card_id) VALUES ($1, $2, $3, $4)`,
      [input.orderId, input.userId, pack.id, cardId]
    );
    await client.query(
      `INSERT INTO user_cards (user_id, card_id, count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, card_id) DO UPDATE SET count = user_cards.count + 1`,
      [input.userId, cardId]
    );
    await client.query(
      `INSERT INTO wallet_tx (user_id, amount, kind, detail) VALUES ($1, $2, 'gacha', $3)`,
      [input.userId, -pack.price, `抽卡:${pack.name}`]
    );
    return upd.rows[0].balance;
  });

  const card = await q<any>(`SELECT id, name, zh_name, rarity, types, stats, sprite FROM cards WHERE id = $1`, [cardId]);
  return { card: card.rows[0], balance: result, replay: false, __dbg };
}

/** Rarity by disclosed weights (or forced by pity), then uniform pick within that rarity pool. */
async function rollCard(
  pack: PackDef,
  forceRarity?: "C" | "R" | "UR"
): Promise<{ id: number; rarity: "C" | "R" | "UR" }> {
  let rarity: "C" | "R" | "UR";
  if (forceRarity) {
    rarity = forceRarity;
  } else {
    const roll = Math.random();
    let acc = 0;
    rarity = "C";
    for (const r of ["UR", "R", "C"] as const) {
      acc += pack.weights[r];
      if (roll < acc) {
        rarity = r;
        break;
      }
    }
  }
  const { rows } = await q<{ id: number }>(
    `SELECT id FROM cards WHERE rarity = $1 ORDER BY random() LIMIT 1`,
    [rarity]
  );
  if (!rows[0]) throw new GachaError(500, `卡池异常:稀有度 ${rarity} 无卡`);
  return { id: rows[0].id, rarity };
}

export async function myCollection(userId: number) {
  const { rows } = await q(
    `SELECT c.id, c.name, c.rarity, c.types, c.stats, c.zh_name, c.sprite, c.bst, uc.count
     FROM user_cards uc JOIN cards c ON c.id = uc.card_id
     WHERE uc.user_id = $1
     ORDER BY c.bst DESC`,
    [userId]
  );
  return rows;
}

export async function collectionSize(userId: number): Promise<number> {
  const { rows } = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM user_cards WHERE user_id = $1`,
    [userId]
  );
  return Number(rows[0]?.n ?? 0);
}
