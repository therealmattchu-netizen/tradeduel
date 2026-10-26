-- Repeated observation-time portfolio estimates. These are not historical backfills
-- and must not be treated as official P&L or settlement evidence.
CREATE TABLE IF NOT EXISTS td_match_valuation_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  sol_balance REAL NOT NULL,
  portfolio_usd REAL,
  token_balances_json TEXT NOT NULL DEFAULT '[]',
  priced_mints INTEGER NOT NULL DEFAULT 0,
  unpriced_mints INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'solana_rpc+dexscreener_spot',
  integrity_note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, wallet, observed_at)
);
CREATE INDEX IF NOT EXISTS td_match_valuation_observations_idx
  ON td_match_valuation_observations(match_id, wallet, observed_at DESC);
