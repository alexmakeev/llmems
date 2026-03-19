-- Billing system tables for AltMe bot
-- Run manually: psql $POSTGRES_URL < migrations/001_billing.sql

CREATE TABLE IF NOT EXISTS user_balances (
  user_id    BIGINT PRIMARY KEY,
  tokens     BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  delta       BIGINT NOT NULL,
  action      TEXT NOT NULL,
  context_id  TEXT,
  stars       INTEGER,
  telegram_payment_charge_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON transactions(user_id);

CREATE TABLE IF NOT EXISTS group_owners (
  group_id     BIGINT PRIMARY KEY,
  owner_id     BIGINT NOT NULL,
  detected_via TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  code       TEXT PRIMARY KEY,
  tokens     BIGINT NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id         BIGSERIAL PRIMARY KEY,
  code       TEXT NOT NULL REFERENCES coupons(code),
  user_id    BIGINT NOT NULL,
  tokens     BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(code, user_id)
);
