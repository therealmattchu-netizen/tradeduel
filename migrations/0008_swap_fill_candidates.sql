-- Parsed swap-fill candidates are evidence, not official fills or settlement.
CREATE TABLE IF NOT EXISTS td_swap_fill_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  block_time INTEGER,
  slot INTEGER,
  token_mint TEXT NOT NULL,
  token_delta REAL NOT NULL,
  sol_delta_net REAL NOT NULL,
  estimated_token_price_sol REAL,
  direction TEXT NOT NULL,
  parser TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'low',
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id,wallet,signature,token_mint)
);
CREATE INDEX IF NOT EXISTS td_swap_fill_candidates_match_idx ON td_swap_fill_candidates(match_id,block_time DESC);
