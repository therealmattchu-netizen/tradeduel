-- Valuation evidence is supporting data only; official settlement remains disabled
-- until transfer eligibility, token pricing, and swap fills are independently verified.
CREATE TABLE IF NOT EXISTS td_match_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('start','end')),
  observed_at INTEGER NOT NULL,
  sol_balance REAL NOT NULL,
  portfolio_usd REAL,
  token_balances_json TEXT NOT NULL DEFAULT '[]',
  priced_mints INTEGER NOT NULL DEFAULT 0,
  unpriced_mints INTEGER NOT NULL DEFAULT 0,
  price_source TEXT NOT NULL DEFAULT 'dexscreener',
  complete INTEGER NOT NULL DEFAULT 0,
  integrity_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, wallet, phase)
);
CREATE INDEX IF NOT EXISTS td_match_valuations_match_idx ON td_match_valuations(match_id, wallet, phase);
