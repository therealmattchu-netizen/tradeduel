ALTER TABLE td_matches ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 300;
CREATE INDEX IF NOT EXISTS td_matches_public_feed_idx ON td_matches(status, verification_status, created_at);
ALTER TABLE td_queue ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 300;
CREATE TABLE IF NOT EXISTS td_match_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  block_time INTEGER,
  slot INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  pump_fun_related INTEGER NOT NULL DEFAULT 0,
  sol_delta REAL NOT NULL DEFAULT 0,
  token_deltas_json TEXT NOT NULL DEFAULT '[]',
  event_type TEXT NOT NULL DEFAULT 'transaction',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, signature)
);
CREATE INDEX IF NOT EXISTS td_match_events_timeline_idx ON td_match_events(match_id, block_time DESC);
CREATE TABLE IF NOT EXISTS td_wallet_sync_state (
  wallet TEXT PRIMARY KEY,
  last_signature TEXT,
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
