-- Persistent wallet token-buy candidates and periodic spot-price observations.
-- Buy attribution is only considered a candidate unless a swap can be reliably identified.
CREATE TABLE IF NOT EXISTS td_wallet_token_buys (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  block_time INTEGER,
  token_amount REAL NOT NULL,
  sol_spent REAL NOT NULL,
  estimated_cost_usd REAL,
  sol_price_usd REAL,
  source TEXT NOT NULL DEFAULT 'solana_rpc_candidate',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wallet, mint, signature)
);
CREATE INDEX IF NOT EXISTS idx_td_wallet_token_buys_wallet_mint ON td_wallet_token_buys(wallet, mint, block_time);
CREATE TABLE IF NOT EXISTS td_wallet_token_price_history (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  token_amount REAL NOT NULL,
  price_usd REAL,
  value_usd REAL,
  liquidity_usd REAL,
  PRIMARY KEY (wallet, mint, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_td_wallet_token_prices_wallet_mint_time ON td_wallet_token_price_history(wallet, mint, observed_at);
