-- Durable public-wallet history indexing and estimated sell events.
CREATE TABLE IF NOT EXISTS td_wallet_index_state (
  wallet TEXT PRIMARY KEY,
  before_signature TEXT,
  exhausted INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS td_wallet_token_sells (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  block_time INTEGER,
  token_amount REAL NOT NULL,
  quote_asset TEXT NOT NULL,
  quote_amount REAL NOT NULL,
  estimated_proceeds_usd REAL,
  source TEXT NOT NULL DEFAULT 'solana_rpc_candidate',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wallet, mint, signature)
);
CREATE INDEX IF NOT EXISTS idx_td_wallet_token_sells_wallet_mint ON td_wallet_token_sells(wallet,mint,block_time);
