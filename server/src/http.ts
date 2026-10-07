// Shared HTTP kernel for every route module (v2.3).
//
// Before this file existed, three route modules each kept a near-identical
// error wrapper, two wrote their own requireUser, and routes-phase1 repeated
// an inline 401 seven times — with three different error-carrier idioms and
// inconsistent `{ error, message }` codes. Everything collapses here:
//
// - HttpError: the ONE error type; `status` + optional machine `code`
//   (5xx answers use the per-domain fallback code instead).
// - wrap(domain, internalMessage, fn): uniform handling — details to the log,
//   friendly text to the client, never a stack trace (QA-009/010).
// - requireUser: session guard; BIGSERIAL ids arrive from pg as strings, so
//   ids are Number-normalized exactly once here and every route can compare
//   them safely (the strict-equality bug class from v2.2).

import express from "express";
import { userFromRequest } from "./auth.js";

export class HttpError extends Error {
  /** machine-readable code carried on 4xx responses (5xx use the domain code) */
  code: string;
  constructor(status: number, message: string, code = "bad_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
  status!: number;
}

export const bad = (message: string): never => {
  throw new HttpError(400, message);
};

export type RouteHandler = (req: express.Request, res: express.Response) => Promise<void>;

/**
 * Uniform async-handler wrapper.
 * - `domain`: log prefix ("battle" → `[battle] POST /x failed`)
 * - `internalMessage`: client-facing text when something unexpected throws 500
 *   (an explicitly-thrown HttpError keeps its own message even at 500 —
 *   handlers annotate known-failure paths with handler-specific copy).
 */
export function wrap(domain: string, internalMessage: string, fn: RouteHandler) {
  return (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err: unknown) => {
      console.error(`[${domain}] ${req.method} ${req.path} failed:`, err);
      const e = err as any;
      const status = e?.status ?? 500;
      const message =
        status >= 500 && !(e instanceof HttpError)
          ? internalMessage
          : (e as Error)?.message ?? "请求失败";
      const code =
        status >= 500
          ? e instanceof HttpError && e.code !== "bad_request" ? e.code : "internal"
          : e instanceof HttpError ? e.code : "request_failed";
      res.status(status).json({ error: code, message });
    });
  };
}

export interface AuthedUser {
  id: number;
  username: string;
  balance: number;
}

/** Session guard for every authenticated route. */
export async function requireUser(req: express.Request): Promise<AuthedUser> {
  const user = await userFromRequest(req);
  if (!user) throw new HttpError(401, "请先登录", "unauthorized");
  return { id: Number(user.id), username: String(user.username), balance: Number(user.balance) };
}
