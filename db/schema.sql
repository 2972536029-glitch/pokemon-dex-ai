-- Phase 1 schema. Idempotent (safe to re-run).
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
  pass_hash     TEXT NOT NULL,            -- scrypt: salt$hash (hex)
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
  kind          TEXT NOT NULL CHECK (kind IN ('signup','daily','gacha')),
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gacha_orders (
  order_id      TEXT PRIMARY KEY,          -- client-generated idempotency key
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id       TEXT NOT NULL,
  card_id       INTEGER NOT NULL REFERENCES cards(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_bonus (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_user_cards_user ON user_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_tx(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- migrations for tables created before this column existed
ALTER TABLE cards ADD COLUMN IF NOT EXISTS zh_name TEXT;
