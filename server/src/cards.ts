// Card catalog: gen-1 (151) pokemon with computed rarity, stored once in DB.
// Rarity is computed at seed time from base-stat-total rank and STORED —
// pack drop rates are disclosed against stored rarity, so it must never
// shift silently after the fact.

import { q } from "./db.js";

export const POKEAPI = "https://pokeapi.co/api/v2";
export const CATALOG_SIZE = 151;

export function shapeStats(raw: any): Record<string, number> {
  const s: Record<string, number> = {};
  for (const st of raw.stats ?? []) s[st.stat.name] = st.base_stat;
  return {
    hp: s.hp, attack: s.attack, defense: s.defense,
    "special-attack": s["special-attack"], "special-defense": s["special-defense"],
    speed: s.speed,
  };
}

export const bstOf = (stats: Record<string, number>) =>
  Object.values(stats).reduce((a, b) => a + b, 0);

export interface CatalogCard {
  id: number;
  name: string;
  types: string[];
  stats: Record<string, number>;
  bst: number;
  rarity: "C" | "R" | "UR";
  sprite: string | null;
  zh_name: string | null;
}

export async function fetchCatalog(): Promise<CatalogCard[]> {
  const results: CatalogCard[] = [];
  const queue = Array.from({ length: CATALOG_SIZE }, (_, i) => i + 1);
  // small worker pool: PokeAPI TTFB is the bottleneck; 8 workers ≈ 40s total
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        const res = await fetch(`${POKEAPI}/pokemon/${id}`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        const stats = shapeStats(raw);
        // official zh-Hans name lives on the species endpoint; a miss (or a
        // failed species fetch) just means the card shows its english name
        let zhName: string | null = null;
        try {
          const sp = await fetch(`${POKEAPI}/pokemon-species/${id}`, {
            signal: AbortSignal.timeout(20_000),
          });
          if (sp.ok) {
            const spJson = await sp.json();
            zhName =
              (spJson.names ?? []).find(
                (n: any) => String(n.language?.name).toLowerCase() === "zh-hans"
              )?.name ?? null;
          }
        } catch {
          /* zh name is decorative — never fail the seed over it */
        }
        results.push({
          id: raw.id,
          name: raw.name,
          types: (raw.types ?? []).map((t: any) => t.type.name),
          stats,
          bst: bstOf(stats),
          rarity: "C", // assigned after all BSTs are known
          sprite: raw.sprites?.front_default ?? null,
          zh_name: zhName,
        });
      } catch (err) {
        console.error(`[seed] card ${id} failed:`, (err as Error).message);
      }

    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.id - b.id);
}

export async function upsertCatalog(cards: CatalogCard[]): Promise<void> {
  for (const c of cards) {
    await q(
      `INSERT INTO cards (id, name, types, stats, bst, rarity, sprite, zh_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, types=EXCLUDED.types, stats=EXCLUDED.stats,
         bst=EXCLUDED.bst, rarity=EXCLUDED.rarity, sprite=EXCLUDED.sprite,
         zh_name=COALESCE(EXCLUDED.zh_name, cards.zh_name)`,
      [c.id, c.name, c.types, JSON.stringify(c.stats), c.bst, c.rarity, c.sprite, c.zh_name]
    );
  }
}

export async function applyRarityRanks(): Promise<void> {
  const { rows } = await q<{ id: number }>(
    `SELECT id, bst FROM cards ORDER BY bst DESC`
  );
  const urCount = Math.max(1, Math.round(rows.length * 0.08));
  const rCount = Math.max(1, Math.round(rows.length * 0.27));
  await q(`UPDATE cards SET rarity='C'`);
  await q(`UPDATE cards SET rarity='UR' WHERE id IN (
    SELECT id FROM cards ORDER BY bst DESC LIMIT ${urCount})`);
  await q(`UPDATE cards SET rarity='R' WHERE id IN (
    SELECT id FROM cards ORDER BY bst DESC LIMIT ${urCount + rCount})
    AND rarity='C'`);
}

export async function catalogNames(): Promise<string[]> {
  const { rows } = await q<{ name: string }>(`SELECT name FROM cards`);
  return rows.map((r) => r.name);
}
