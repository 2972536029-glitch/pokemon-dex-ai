// Wallet & gacha. The two properties interviewers always probe:
// - spending money is guarded by an OPTIMISTIC LOCK (UPDATE ... WHERE
//   balance >= price, checked via rowCount) — no read-modify-write race.
// - a draw is an ORDER (gacha_orders.id = client idempotency key): a retry
//   with the same key replays the SAME card instead of charging twice.

import crypto from "node:crypto";
import { q, tx } from "./db.js";
import { AUTH_CONSTANTS } from "./auth.js";

export interface PackDef {
  id: string;
  name: string;
  price: number;
  weights: { C: number; R: number; UR: number };
}

// Disclosed rates — these exact numbers are served to the client and shown
// on the shop page (概率公示). Rarity pools come from the seeded catalog.
export const PACKS: PackDef[] = [
  { id: "basic", name: "基础包", price: 50, weights: { C: 0.86, R: 0.12, UR: 0.02 } },
  { id: "advanced", name: "进阶包", price: 120, weights: { C: 0.6, R: 0.32, UR: 0.08 } },
  { id: "legend", name: "传说包", price: 250, weights: { C: 0, R: 0.7, UR: 0.3 } },
];

export function findPack(id: string): PackDef | undefined {
  return PACKS.find((p) => p.id === id);
}

export class GachaError extends Error {
  status: number;
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
  packId: string;
  orderId: string;
}

export interface DrawResult {
  card: { id: number; name: string; rarity: string; types: string[]; sprite: string | null };
  balance: number;
  replay: boolean;
}

export async function drawCard(input: DrawInput): Promise<DrawResult> {
  const pack = findPack(input.packId);
  if (!pack) throw new GachaError(404, "卡包不存在");
  // Idempotency keys come from the client; a malformed one can't collide or inject.
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(input.orderId)) {
    throw new GachaError(400, "invalid order id");
  }

  // 1) Replay check outside the write path: same key → same card, no charge.
  const existing = await q<{ card_id: number }>(
    `SELECT card_id FROM gacha_orders WHERE order_id = $1 AND user_id = $2`,
    [input.orderId, input.userId]
  );
  if (existing.rows[0]) {
    const card = await q<any>(`SELECT id, name, rarity, types, sprite FROM cards WHERE id = $1`, [
      existing.rows[0].card_id,
    ]);
    const bal = await q<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [input.userId]);
    return { card: card.rows[0], balance: bal.rows[0].balance, replay: true };
  }

  // 2) Roll the rarity + pick the card BEFORE the transaction (pure RNG over
  //    static catalog data — nothing in the tx depends on it).
  const cardId = await rollCard(pack);

  // 3) The order: charge (optimistic lock) → record order → grant card → log.
  // TRUE concurrent duplicate of the same orderId: the second tx hits the
  // orders PK and rolls back (no double charge) — we then serve the winner's
  // card as a replay instead of a raw 500 (QA-004).
  try {
    return await drawOnce(input, pack, cardId);
  } catch (err: any) {
    if (err?.code === "23505") {
      const winner = await q<{ card_id: number }>(
        `SELECT card_id FROM gacha_orders WHERE order_id = $1 AND user_id = $2`,
        [input.orderId, input.userId]
      );
      if (winner.rows[0]) {
        const card = await q<any>(`SELECT id, name, rarity, types, sprite FROM cards WHERE id = $1`, [
          winner.rows[0].card_id,
        ]);
        const bal = await q<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [input.userId]);
        return { card: card.rows[0], balance: bal.rows[0].balance, replay: true };
      }
    }
    throw err;
  }
}

async function drawOnce(input: DrawInput, pack: PackDef, cardId: number): Promise<DrawResult> {
  const result = await tx(async (client) => {
    const upd = await client.query<{ balance: number }>(
      `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
      [pack.price, input.userId]
    );
    if (upd.rowCount === 0) {
      throw new GachaError(402, "货币不足,先去赚点货币吧(每日登录 +50)");
    }
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

  const card = await q<any>(`SELECT id, name, rarity, types, sprite FROM cards WHERE id = $1`, [cardId]);
  return { card: card.rows[0], balance: result, replay: false };
}

/** Rarity by disclosed weights, then uniform pick within that rarity pool. */
async function rollCard(pack: PackDef): Promise<number> {
  const roll = Math.random();
  let acc = 0;
  let rarity: "C" | "R" | "UR" = "C";
  for (const r of ["UR", "R", "C"] as const) {
    acc += pack.weights[r];
    if (roll < acc) {
      rarity = r;
      break;
    }
  }
  const { rows } = await q<{ id: number }>(
    `SELECT id FROM cards WHERE rarity = $1 ORDER BY random() LIMIT 1`,
    [rarity]
  );
  if (!rows[0]) throw new GachaError(500, `卡池异常:稀有度 ${rarity} 无卡`);
  return rows[0].id;
}

export async function myCollection(userId: number) {
  const { rows } = await q(
    `SELECT c.id, c.name, c.rarity, c.types, c.sprite, c.bst, uc.count
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
