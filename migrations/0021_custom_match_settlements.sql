-- Persist provisional custom-team standings without treating estimates as verified results.
CREATE TABLE IF NOT EXISTS td_custom_match_settlements (
  match_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'blocked',
  team_one_return_pct REAL,
  team_two_return_pct REAL,
  member_returns_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  indexed_transactions INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
