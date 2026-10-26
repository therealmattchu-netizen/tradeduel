-- Auditable provisional settlement calculations. Never award ELO from snapshots alone.
CREATE TABLE IF NOT EXISTS td_match_settlements (
  match_id TEXT PRIMARY KEY,
  player_one TEXT NOT NULL,
  player_two TEXT NOT NULL,
  start_one_usd REAL,
  end_one_usd REAL,
  start_two_usd REAL,
  end_two_usd REAL,
  return_one_pct REAL,
  return_two_pct REAL,
  provisional_winner TEXT,
  status TEXT NOT NULL DEFAULT 'blocked',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  elo_applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
