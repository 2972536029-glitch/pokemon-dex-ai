// User-state tools: the agent's bridge into PRIVATE game data.
//
// Security shape (the IDOR red line from the roadmap): these tool factories
// take userId from the SERVER-RESOLVED session — never from the model. The
// model can ask "what are my cards"; it cannot ask "what are user 7's cards"
// because no tool accepts a user parameter at all.

import type { ToolDef, ToolResult, ToolArgs } from "./types.js";
import { q } from "./db.js";
import { PACKS } from "./gacha.js";
import { EN_TO_ZH } from "./guard.js";

function fail(message: string): ToolResult {
  return { ok: false, error: "query_failed", hint: message };
}

async function getMyCards(userId: number): Promise<ToolResult> {
  try {
    const { rows } = await q(
      `SELECT c.id, c.name, c.rarity, c.types, c.stats, uc.count
       FROM user_cards uc JOIN cards c ON c.id = uc.card_id
       WHERE uc.user_id = $1 ORDER BY c.bst DESC`,
      [userId]
    );
    // Attach the known zh alias when we have one — the model otherwise
    // invents dubious translations ("钓鱼王"). Missing alias → english only.
    const cards = rows.map((r: any) => ({
      ...r,
      zh_name: r.zh_name ?? EN_TO_ZH[r.name] ?? null,
    }));
    return { ok: true, data: { total: cards.length, cards } };
  } catch {
    return fail("collection lookup failed");
  }
}

async function getMyWallet(userId: number): Promise<ToolResult> {
  try {
    const { rows } = await q<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [userId]);
    if (!rows[0]) return fail("user not found");
    return { ok: true, data: { balance: rows[0].balance } };
  } catch {
    return fail("wallet lookup failed");
  }
}

async function listPacks(): Promise<ToolResult> {
  return {
    ok: true,
    data: {
      packs: PACKS.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        drop_rates: p.weights,
      })),
    },
  };
}

export function userTools(userId: number): ToolDef[] {
  return [
    {
      name: "get_my_cards",
      description:
        "List the CURRENT USER's owned cards (name, rarity, types, stats, count). " +
        "Team/collection questions MUST read this first — never assume cards the user does not own.",
      parameters: { type: "object", properties: {} },
      execute: async () => getMyCards(userId),
      summary: (_args, r) => `我的收藏 ${r.ok ? "✓" : "✗"}`,
    },
    {
      name: "get_my_wallet",
      description: "Get the CURRENT USER's coin balance.",
      parameters: { type: "object", properties: {} },
      execute: async () => getMyWallet(userId),
      summary: (_args, r) => `我的钱包 ${r.ok ? "✓" : "✗"}`,
    },
    {
      name: "list_packs",
      description:
        "List purchasable card packs with price and disclosed drop rates. " +
        "Pack purchase advice MUST cite these numbers.",
      parameters: { type: "object", properties: {} },
      execute: async () => listPacks(),
      summary: (_args, r) => `卡包列表 ${r.ok ? "✓" : "✗"}`,
    },
  ];
}
