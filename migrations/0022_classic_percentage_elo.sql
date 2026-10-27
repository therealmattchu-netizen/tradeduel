-- Add one-time ELO settlement guard for Classic percentage 1v1 rooms.
ALTER TABLE td_custom_match_settlements ADD COLUMN elo_applied INTEGER NOT NULL DEFAULT 0;
