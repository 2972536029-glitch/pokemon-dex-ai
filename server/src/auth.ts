// Account auth: register / login / logout / session resolution.
//
// Decisions worth defending:
// - scrypt from node:crypto (memory-hard, zero native deps) instead of
//   bcrypt/argon2 native addons; parameters r=8,p=1,N=2^14 per OWASP.
// - httpOnly + SameSite=Lax cookie holding a random 32-byte session id;
//   sessions live in DB with expiry — revocable, unlike stateless JWTs.
// - Login failures return a GENERIC message (防用户枚举). Register does reveal
//   "username taken" — a deliberate UX tradeoff for a game (documented).
// - Login rate limit lives in ratelimit.ts (DB-backed rolling window,
//   shared across serverless instances) since v2.3.
// - scrypt is async: the N=2^14 KDF blocks the event loop for ~50-100ms
//   when done synchronously — unacceptable on a shared serverless thread.

import crypto from "node:crypto";
import { promisify } from "node:util";
import { q, tx } from "./db.js";
import { HttpError } from "./http.js";

const SESSION_COOKIE = "dex_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SIGNUP_BONUS = 300;
const DAILY_BONUS = 50;

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// ---- password hashing ------------------------------------------------------
const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;
const SCRYPT_PARAMS = { N: 1 << 14, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, "hex"), 64, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
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
  // 过期会话清理:sessions 表只增不减会无界膨胀。本用户的过期行必删;
  // 全表过期行 5% 采样删(每次登录摊一点清理成本,无需定时任务)。
  await q(`DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()`, [userId]);
  if (Math.random() < 0.05) {
    await q(`DELETE FROM sessions WHERE expires_at <= now()`);
  }
  return { cookieValue: sid, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

// ---- register / login ------------------------------------------------------
export async function register(username: string, password: string): Promise<SessionUser> {
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "用户名需为 3-20 位字母、数字或下划线", "invalid_username");
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 100) {
    throw new HttpError(400, "密码需为 6-100 位", "invalid_password");
  }
  const hash = await hashPassword(password);
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
      throw new HttpError(409, "该用户名已被使用", "username_taken");
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
  const generic = new HttpError(401, "用户名或密码错误", "bad_credentials");
  if (!user) throw generic;
  if (!(await verifyPassword(password, user.pass_hash))) throw generic;
  return { id: user.id, username: user.username, balance: user.balance };
}

export async function destroySession(sid: string): Promise<void> {
  await q(`DELETE FROM sessions WHERE id = $1`, [sid]);
}

export const AUTH_CONSTANTS = { SIGNUP_BONUS, DAILY_BONUS, SESSION_COOKIE };
