// DB-backed rolling-window rate limiter (v2.3).
//
// Why the database: on Vercel serverless every instance keeps its own memory,
// so in-process counters (the old login limiter) silently under-count — each
// cold instance resets the budget. rate_events is the only shared store this
// stack has (no Redis), and the write volume is tiny (one row per attempt on
// protected routes).
//
// Fail-open on DB errors: the limiter protects cost/abuse, it is not core —
// if the DB is down the protected routes fail anyway.

import { q } from "./db.js";

/** Tests set RATE_LIMIT_SCALE (e.g. 1000) to widen every budget; prod leaves
 *  it unset → scale 1. Read LAZILY: .env.local is loaded inside createApp(),
 *  AFTER module imports — a top-level const would see an un-injected env
 *  (classic dotenv ordering bug, caught by the suites 429ing locally). */
function scale(): number {
  return Math.max(1, Math.floor(Number(process.env.RATE_LIMIT_SCALE ?? "1")) || 1);
}

/**
 * Record one attempt for `ident` and decide. Rolling window: allows up to
 * `limit` attempts per `windowSec` (scaled by RATE_LIMIT_SCALE).
 */
export async function allowRate(ident: string, limit: number, windowSec: number): Promise<boolean> {
  const cap = Math.max(1, Math.ceil(limit * scale()));
  try {
    // One round trip: sampled prune of ancient rows (5%), record this
    // attempt, then count PRIOR attempts in the window (the CTE's own insert
    // is invisible to the outer snapshot — count < cap is the allow rule).
    const { rows } = await q<{ n: number }>(
      `WITH del AS (
         DELETE FROM rate_events WHERE at < now() - interval '25 hours' AND random() < 0.05
       ), ins AS (
         INSERT INTO rate_events (ident) VALUES ($1)
       )
       SELECT count(*)::int AS n FROM rate_events
       WHERE ident = $1 AND at > now() - ($2::int * interval '1 second')`,
      [ident, windowSec],
    );
    return Number(rows[0]?.n ?? 0) < cap;
  } catch (err: any) {
    console.warn("[ratelimit] db unavailable, failing open:", err?.message);
    return true;
  }
}
