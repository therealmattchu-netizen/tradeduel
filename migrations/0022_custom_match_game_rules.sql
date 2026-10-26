-- Restore rule presets for custom match rooms without changing existing rows.
ALTER TABLE td_custom_matches ADD COLUMN game_rule TEXT NOT NULL DEFAULT 'standard'
  CHECK (game_rule IN ('standard','one_token_at_a_time','max_bet','free_trading'));
