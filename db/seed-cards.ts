// One-time catalog seed: fetch gen-1 (151) from PokeAPI, store with rarity.
// Run: npm run seed   (idempotent — re-runs refresh the catalog)
import { loadEnvFile } from "../server/src/env.js";
import { fileURLToPath } from "node:url";
loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
import { ensureSchema, q } from "../server/src/db.js";
import { fetchCatalog, upsertCatalog, applyRarityRanks } from "../server/src/cards.js";

async function main() {
  await ensureSchema();
  const existing = await q<{ count: string }>(`SELECT count(*)::text AS count FROM cards`);
  console.log(`[seed] cards in catalog before: ${existing.rows[0]?.count ?? 0}`);

  console.log("[seed] fetching 151 pokemon from PokeAPI (~40s)...");
  const cards = await fetchCatalog();
  if (cards.length < 100) {
    console.error(`[seed] only ${cards.length} fetched — aborting (network?)`);
    process.exit(1);
  }
  await upsertCatalog(cards);
  await applyRarityRanks();

  const { rows } = await q<{ rarity: string; n: string }>(
    `SELECT rarity, count(*)::text AS n FROM cards GROUP BY rarity ORDER BY rarity`
  );
  console.log("[seed] done:", rows.map((r) => `${r.rarity}=${r.n}`).join(" "));
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
