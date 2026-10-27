-- One verified public trading wallet per authenticated TradeDuel account.
-- Public addresses only: never store private keys or seed phrases.
CREATE TABLE IF NOT EXISTS td_trading_wallets (
  owner_wallet TEXT PRIMARY KEY REFERENCES td_users(wallet) ON DELETE CASCADE,
  trading_wallet TEXT NOT NULL UNIQUE,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(owner_wallet) BETWEEN 32 AND 44),
  CHECK (length(trading_wallet) BETWEEN 32 AND 44),
  CHECK (owner_wallet <> trading_wallet)
);
CREATE INDEX IF NOT EXISTS idx_td_trading_wallets_trading_wallet
  ON td_trading_wallets(trading_wallet);
