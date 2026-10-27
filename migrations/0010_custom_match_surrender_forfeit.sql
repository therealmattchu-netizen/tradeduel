-- Record which wallet surrendered so a forfeit cannot be scored as a normal PnL win.
ALTER TABLE td_custom_matches ADD COLUMN surrendered_by TEXT;
