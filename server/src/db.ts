// Single Postgres connection point. DATABASE_URL decides the target:
// local Docker (docker compose up -d) or Neon in production.
// Every DB access in the app goes through here — swapping providers never
// touches business code (the 仓储层 discipline from the roadmap).
import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    pool = new pg.Pool({
      connectionString: url,
      max: 3, // serverless: keep per-instance connections tiny
      idleTimeoutMillis: 15_000,
    });
  }
  return pool;
}

export function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/** Run fn inside a transaction; rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Apply db/schema.sql once per process (idempotent DDL). */
let migrated = false;
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db.ts → ../../db/schema.sql (server/src → project root/db)
  const schemaPath = path.join(here, "..", "..", "db", "schema.sql");
  const ddl = await readFile(schemaPath, "utf8");
  await getPool().query(ddl);
  migrated = true;
}
