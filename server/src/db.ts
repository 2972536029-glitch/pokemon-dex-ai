// Single Postgres connection point. DATABASE_URL decides the target:
// local Docker (docker compose up -d) or Neon in production.
// Every DB access in the app goes through here — swapping providers never
// touches business code (the 仓储层 discipline from the roadmap).
import pg from "pg";
import { SCHEMA_DDL } from "./schema.js";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    pool = new pg.Pool({
      connectionString: url,
      max: 3, // serverless: keep per-instance connections tiny
      idleTimeoutMillis: 15_000,
      // Neon and every managed Postgres require TLS; local Docker does not.
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

const CONNECTION_ERRORS = [
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND",
  "Connection terminated", "connection timeout", "57P01", "08006",
];

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return CONNECTION_ERRORS.some(
    (sig) => e?.code === sig || (e?.message ?? "").includes(sig)
  );
}

/**
 * Query with ONE automatic retry on connection-level failure. Neon (free
 * tier) drops idle serverless connections after ~5 min; a pooled stale
 * client fails its first query — pg evicts it and the retry lands on a
 * fresh connection. Application-level errors (SQL, constraints) are NEVER
 * retried.
 */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  try {
    return await getPool().query<T>(text, params as unknown[]);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    console.warn("[db] connection-level failure, retrying once:", (err as Error).message);
    return await getPool().query<T>(text, params as unknown[]);
  }
}

/** Run fn inside a transaction; rolls back on throw.
 * ONE retry on connection-level failure: a stale pooled client usually dies
 * on BEGIN or the first query, before anything is written, so replaying fn on
 * a fresh client is safe. Application errors are never retried. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await txOnce(fn);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    console.warn("[db] tx connection-level failure, retrying once:", (err as Error).message);
    return await txOnce(fn);
  }
}

async function txOnce<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

/**
 * Apply the embedded idempotent DDL once per process.
 * A cold start can race Neon's compute resume — the first DDL attempt may
 * fail transiently. Retry up to 3 times; only SUCCESS is memoized (a failed
 * attempt must never poison later requests).
 */
let migrated = false;
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await getPool().query(SCHEMA_DDL);
      migrated = true;
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[db] schema attempt ${attempt}/3 failed:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, attempt * 700));
    }
  }
  throw lastErr;
}
