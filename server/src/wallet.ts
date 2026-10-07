// Wallet ledger: the single writer for wallet_tx rows.
// Before v2.3 five modules each kept an identical INSERT copy; any new
// money-moving path now calls this instead of hand-writing SQL.
// `amount` is signed — negative spends, positive grants.
// Always call INSIDE a transaction: the balance UPDATE and the ledger row
// must commit or roll back together (the ledger IS the audit trail).

import type { PoolClient } from "pg";

export type WalletKind = "signup" | "daily" | "gacha" | "battle";

export async function addWalletTx(
  client: PoolClient,
  userId: number,
  amount: number,
  kind: WalletKind,
  detail: string,
): Promise<void> {
  await client.query(
    `INSERT INTO wallet_tx (user_id, amount, kind, detail) VALUES ($1, $2, $3, $4)`,
    [userId, amount, kind, detail],
  );
}
