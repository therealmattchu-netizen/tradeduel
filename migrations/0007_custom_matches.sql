-- Custom public/private match rooms with team modes and channelled chat.
CREATE TABLE IF NOT EXISTS td_custom_matches (
  id TEXT PRIMARY KEY,
  creator_wallet TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('head_to_head','duo','group')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  max_players INTEGER NOT NULL CHECK (max_players IN (2,4,6,8)),
  duration_seconds INTEGER NOT NULL DEFAULT 900,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS td_custom_matches_browse_idx ON td_custom_matches(status, visibility, created_at DESC);
CREATE TABLE IF NOT EXISTS td_custom_match_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  team_number INTEGER NOT NULL DEFAULT 1,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, wallet)
);
CREATE INDEX IF NOT EXISTS td_custom_match_members_idx ON td_custom_match_members(match_id, team_number);
CREATE TABLE IF NOT EXISTS td_custom_match_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('all','team')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS td_custom_match_chat_idx ON td_custom_match_chat(match_id, channel, id);
