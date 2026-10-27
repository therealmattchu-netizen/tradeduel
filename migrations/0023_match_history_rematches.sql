-- Persist exact rating deltas for verified Classic results and mutual rematch state.
CREATE TABLE IF NOT EXISTS td_custom_match_elo_results (
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  opponent_wallet TEXT NOT NULL,
  return_pct REAL NOT NULL,
  elo_before INTEGER NOT NULL,
  elo_after INTEGER NOT NULL,
  elo_delta INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('win','loss','draw')),
  settled_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (match_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_td_custom_match_elo_results_wallet_settled
  ON td_custom_match_elo_results(wallet, settled_at DESC);
CREATE TABLE IF NOT EXISTS td_custom_match_rematches (
  match_id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  opponent_wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired')),
  new_match_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
