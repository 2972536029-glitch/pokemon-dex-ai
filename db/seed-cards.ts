// One-time catalog seed: fetch gen-1 (151) from PokeAPI, store with rarity.
// Run: npm run seed   (idempotent — re-runs refresh the catalog)
import { loadEnvFile } from "../server/src/env.js";
import { fileURLToPath } from "node:url";
loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
import { ensureSchema } from "../server/src/db.js";
import { seedCatalog } from "../server/src/cards.js";

async function main() {
  await ensureSchema();
  console.log("[seed] fetching gen-1 catalog from PokeAPI (~1 min)...");
  const result = await seedCatalog();
  console.log(`[seed] done: ${result.seeded} cards —`, result.rarity.map((r) => `${r.rarity}=${r.n}`).join(" "));
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
