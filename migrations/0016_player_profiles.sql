-- Player profiles: compact, validated avatar data URLs are stored per wallet.
-- Images are resized/compressed in the browser before upload; cap stored data at 180 KB.
ALTER TABLE td_users ADD COLUMN avatar_data_url TEXT;
ALTER TABLE td_users ADD COLUMN display_name TEXT;
