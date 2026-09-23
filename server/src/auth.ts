// Account auth: register / login / logout / session resolution.
//
// Decisions worth defending:
// - scrypt from node:crypto (memory-hard, zero native deps) instead of
//   bcrypt/argon2 native addons; parameters r=8,p=1,N=2^14 per OWASP.
// - httpOnly + SameSite=Lax cookie holding a random 32-byte session id;
//   sessions live in DB with expiry — revocable, unlike stateless JWTs.
// - Login failures return a GENERIC message (防用户枚举). Register does reveal
//   "username taken" — a deliberate UX tradeoff for a game (documented).
// - Login rate limit: in-memory per-IP counter. HONEST LIMITATION: on
//   serverless each instance counts independently; the industrial answer is
//   a shared store (Redis). Acceptable for this scale, documented here.

import crypto from "node:crypto";
import { q, tx } from "./db.js";

const SESSION_COOKIE = "dex_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SIGNUP_BONUS = 300;
const DAILY_BONUS = 50;

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// ---- password hashing ------------------------------------------------------
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 1 << 14, r: 8, p: 1 });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64, {
    N: 1 << 14, r: 8, p: 1,
  });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

// ---- login rate limiting (per instance; see module note) -------------------
const attempts = new Map<string, { count: number; resetAt: number }>();
const LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;

export function loginAllowed(key: string): boolean {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= LIMIT;
}

// ---- session helpers -------------------------------------------------------
export function sessionCookie(value: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

export interface SessionUser {
  id: number;
  username: string;
  balance: number;
}

export function parseSessionCookie(req: { headers: { cookie?: string } }): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

export async function userFromRequest(
  req: { headers: { cookie?: string } }
): Promise<SessionUser | null> {
  const sid = parseSessionCookie(req);
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const { rows } = await q<SessionUser>(
    `SELECT u.id, u.username, u.balance
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sid]
  );
  return rows[0] ?? null;
}

export async function createSession(userId: number): Promise<{ cookieValue: string; maxAgeSec: number }> {
  const sid = crypto.randomBytes(32).toString("hex");
  await q(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')`,
    [sid, userId]
  );
  return { cookieValue: sid, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

// ---- register / login ------------------------------------------------------
export async function register(username: string, password: string): Promise<SessionUser> {
  if (!USERNAME_RE.test(username)) {
    throw Object.assign(new Error("用户名需为 3-20 位字母、数字或下划线"), { status: 400 });
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 100) {
    throw Object.assign(new Error("密码需为 6-100 位"), { status: 400 });
  }
  const hash = hashPassword(password);
  try {
    const rows = await tx(async (client) => {
      const ins = await client.query<{ id: number; username: string; balance: number }>(
        `INSERT INTO users (username, pass_hash, balance) VALUES ($1, $2, $3)
         RETURNING id, username, balance`,
        [username, hash, SIGNUP_BONUS]
      );
      await client.query(
        `INSERT INTO wallet_tx (user_id, amount, kind, detail) VALUES ($1, $2, 'signup', '注册奖励')`,
        [ins.rows[0].id, SIGNUP_BONUS]
      );
      return ins.rows;
    });
    return rows[0];
  } catch (err: any) {
    if (err?.code === "23505") {
      // Tradeoff: register reveals username existence — standard game UX.
      throw Object.assign(new Error("该用户名已被使用"), { status: 409 });
    }
    throw err;
  }
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const { rows } = await q<{ id: number; username: string; balance: number; pass_hash: string }>(
    `SELECT id, username, balance, pass_hash FROM users WHERE username = $1`,
    [username]
  );
  const user = rows[0];
  // Same generic message for both branches — no user enumeration.
  const generic = Object.assign(new Error("用户名或密码错误"), { status: 401 });
  if (!user) throw generic;
  if (!verifyPassword(password, user.pass_hash)) throw generic;
  return { id: user.id, username: user.username, balance: user.balance };
}

export async function destroySession(sid: string): Promise<void> {
  await q(`DELETE FROM sessions WHERE id = $1`, [sid]);
}

export const AUTH_CONSTANTS = { SIGNUP_BONUS, DAILY_BONUS, SESSION_COOKIE };
