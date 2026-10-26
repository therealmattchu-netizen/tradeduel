-- Additive integrity audit trail. Flags are evidence for review, not automatic findings of cheating.
CREATE TABLE IF NOT EXISTS td_match_integrity_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  flag_code TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'review',
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, flag_code)
);
CREATE INDEX IF NOT EXISTS td_match_integrity_match_idx ON td_match_integrity_flags(match_id, severity);
