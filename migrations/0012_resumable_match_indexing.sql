-- Durable pagination and work queue so indexing can resume across room refreshes.
-- This is incremental polling, not a background cron worker.
CREATE TABLE IF NOT EXISTS td_match_index_state (
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  before_signature TEXT,
  exhausted INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(match_id, wallet)
);
CREATE TABLE IF NOT EXISTS td_match_index_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  tx_error_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','skipped','retry')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, wallet, signature)
);
CREATE INDEX IF NOT EXISTS td_match_index_queue_pending_idx
  ON td_match_index_queue(match_id, wallet, status, id);
