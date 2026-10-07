// Database DDL, embedded as a constant: serverless bundles only trace JS,
// so runtime file reads (fs) are unavailable — this is the standard fix for
// the "ENOENT schema.sql on /var/task" class of failures. Idempotent DDL;
// the migration ALTERs at the bottom make it safe to re-run on old tables.
export const SCHEMA_DDL = `-- Phase 1 schema. Idempotent (safe to re-run).
-- Design notes:
-- - ownership is a SEPARATE table (user_cards), the card catalog (cards) is
--   global and read-only — the 规范化 discipline: reference data lives once.
-- - wallet balance lives on users (single row, single writer path guarded by
--   an optimistic-lock UPDATE ... WHERE balance >= ?); every mutation also
--   writes an append-only wallet_tx row (auditability).
-- - gacha_orders makes a card draw an idempotent ORDER: retrying with the
--   same order key returns the same card instead of charging twice.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,            -- scrypt: salt:hash (hex)
  balance       INTEGER NOT NULL DEFAULT 300 CHECK (balance >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,          -- 32-byte random hex
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY,       -- PokeAPI dex id
  name          TEXT NOT NULL UNIQUE,
  types         TEXT[] NOT NULL,
  stats         JSONB NOT NULL,            -- {hp,attack,defense,special-attack,special-defense,speed}
  bst           INTEGER NOT NULL,          -- base stat total, drives rarity
  rarity        TEXT NOT NULL CHECK (rarity IN ('C','R','UR')),
  sprite        TEXT,
  zh_name       TEXT                      -- official zh-Hans name from PokeAPI species
);

CREATE TABLE IF NOT EXISTS user_cards (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id       INTEGER NOT NULL REFERENCES cards(id),
  count         INTEGER NOT NULL DEFAULT 1,
  first_acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS wallet_tx (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,          -- signed: negative = spend
  kind          TEXT NOT NULL CHECK (kind IN ('signup','daily','gacha','battle')),
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gacha_pity (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id      TEXT NOT NULL,
  since_ur     INTEGER NOT NULL DEFAULT 0,             -- 距上次 UR 的抽数(按卡包独立)
  PRIMARY KEY (user_id, pack_id)
);

CREATE TABLE IF NOT EXISTS gacha_orders (
  order_id      TEXT NOT NULL,             -- client-generated idempotency key
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id       TEXT NOT NULL,
  card_id       INTEGER NOT NULL REFERENCES cards(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, order_id)          -- keys are user-scoped: different
);                                         -- users may reuse the same key

CREATE TABLE IF NOT EXISTS daily_bonus (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_tx(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS user_teams (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  card_ids      INTEGER[] NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS battles (
  id            TEXT PRIMARY KEY,          -- uuid
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state         JSONB NOT NULL,            -- full BattleState snapshot
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','won','lost')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_battles_user_active ON battles(user_id, status);

-- migrations for tables created before these lines existed
ALTER TABLE cards ADD COLUMN IF NOT EXISTS zh_name TEXT;
DROP INDEX IF EXISTS idx_user_cards_user; -- redundant with PK prefix (QA-012)
-- v1.4:对战胜利奖励引入 kind='battle',老库的 CHECK 不含它,获胜入账必炸(QA-033)
ALTER TABLE wallet_tx DROP CONSTRAINT IF EXISTS wallet_tx_kind_check;
ALTER TABLE wallet_tx ADD CONSTRAINT wallet_tx_kind_check CHECK (kind IN ('signup','daily','gacha','battle'));
-- v1.7.1:保底改为按卡包独立(旧表是 user_id 单键;旧计数归入基础包——
-- 该表仅上线一天且全是测试数据,语义重置可接受)
ALTER TABLE gacha_pity ADD COLUMN IF NOT EXISTS pack_id TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE gacha_pity DROP CONSTRAINT IF EXISTS gacha_pity_pkey;
ALTER TABLE gacha_pity ADD CONSTRAINT gacha_pity_pkey PRIMARY KEY (user_id, pack_id);
ALTER TABLE gacha_orders DROP CONSTRAINT IF EXISTS gacha_orders_pkey;
ALTER TABLE gacha_orders ADD PRIMARY KEY (user_id, order_id);

-- ==================== v2.2 好友系统(计划书 docs/updates/v2.2-friends.md) ====================
-- 工程约定:不建物理外键(引用完整性由应用层+事务保证);状态用 SMALLINT+应用层常量,可扩展不改表
CREATE TABLE IF NOT EXISTS friend_requests (
  id BIGSERIAL PRIMARY KEY,
  from_uid INTEGER NOT NULL,
  to_uid   INTEGER NOT NULL,
  status   SMALLINT NOT NULL DEFAULT 1,   -- 1 待处理 2 已同意 3 已拒绝
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_req_pending
  ON friend_requests (from_uid, to_uid) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_friend_req_inbox ON friend_requests (to_uid, status);

CREATE TABLE IF NOT EXISTS friendships (
  id BIGSERIAL PRIMARY KEY,
  user_a INTEGER NOT NULL,               -- 恒为较小 uid,防双向重复建交
  user_b INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_friendship_pair UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS card_trades (
  id BIGSERIAL PRIMARY KEY,
  kind     SMALLINT NOT NULL,            -- 1 赠送(发起人→接收人) 2 索要(接收人→发起人)
  from_uid INTEGER NOT NULL,
  to_uid   INTEGER NOT NULL,
  card_id  INTEGER NOT NULL,
  status   SMALLINT NOT NULL DEFAULT 1,  -- 1 待处理 2 已成交 3 已拒绝 4 已撤销
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trades_inbox ON card_trades (to_uid, status);
CREATE INDEX IF NOT EXISTS idx_trades_outbox ON card_trades (from_uid, status);

CREATE TABLE IF NOT EXISTS friend_battles (
  id BIGSERIAL PRIMARY KEY,
  challenger_uid INTEGER NOT NULL,
  target_uid     INTEGER NOT NULL,
  challenger_team JSONB NOT NULL,        -- [cardId×3] 下战书时的编队快照
  target_team    JSONB,                  -- 应战时才填
  status  SMALLINT NOT NULL DEFAULT 1,   -- 1 待应战 2 已完赛 3 已拒绝 4 已撤销
  winner_uid INTEGER,
  battle_log JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fbattles_inbox ON friend_battles (target_uid, status);
CREATE INDEX IF NOT EXISTS idx_fbattles_outbox ON friend_battles (challenger_uid, status);
`;
