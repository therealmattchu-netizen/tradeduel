-- Custom rooms use the same durable transaction index and valuation evidence as standard duels.
ALTER TABLE td_custom_matches ADD COLUMN started_at TEXT;
ALTER TABLE td_custom_matches ADD COLUMN ends_at TEXT;
ALTER TABLE td_custom_matches ADD COLUMN finished_at TEXT;
CREATE INDEX IF NOT EXISTS td_custom_matches_active_idx ON td_custom_matches(status, ends_at);
