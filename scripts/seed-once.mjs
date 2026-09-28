// Build-time guard: seed the card catalog into the production database if
// (and only if) it is empty. Idempotent — repeat builds skip immediately.
// Runs inside `vercel` builds where DATABASE_URL is available as an env var.
import { loadEnvFile } from "../server/dist/env.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
loadEnvFile(dirname(fileURLToPath(import.meta.url)) + "/../.env.production.local");
loadEnvFile(dirname(fileURLToPath(import.meta.url)) + "/../.env.local");
loadEnvFile(dirname(fileURLToPath(import.meta.url)) + "/../.env");

if (!process.env.DATABASE_URL) {
  console.log("[seed-once] no DATABASE_URL — skipping catalog seed");
  process.exit(0);
}

const { ensureSchema, q } = await import("../server/dist/db.js");
const { seedCatalog } = await import("../server/dist/cards.js");

await ensureSchema();
const { rows } = await q(`SELECT count(*)::int AS n FROM cards`);
if (rows[0].n > 0) {
  console.log(`[seed-once] catalog already has ${rows[0].n} cards — skip`);
  process.exit(0);
}
console.log("[seed-once] empty catalog — seeding gen-1 from PokeAPI...");
const result = await seedCatalog();
console.log(`[seed-once] done: ${result.seeded} cards —`, result.rarity.map((r) => `${r.rarity}=${r.n}`).join(" "));
