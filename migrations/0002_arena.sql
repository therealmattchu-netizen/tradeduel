-- TradeDuel alpha identity and matchmaking tables. Additive migration only.
CREATE TABLE IF NOT EXISTS td_users (
  wallet TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  rating INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS td_challenges (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS td_challenges_expiry_idx ON td_challenges(expires_at);
CREATE TABLE IF NOT EXISTS td_sessions (
  token_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS td_sessions_wallet_idx ON td_sessions(wallet);
CREATE TABLE IF NOT EXISTS td_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL DEFAULT 'practice',
  status TEXT NOT NULL DEFAULT 'waiting',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  match_id TEXT
);
CREATE INDEX IF NOT EXISTS td_queue_status_idx ON td_queue(status, joined_at);
CREATE TABLE IF NOT EXISTS td_matches (
  id TEXT PRIMARY KEY,
  player_one TEXT NOT NULL,
  player_two TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  format TEXT NOT NULL DEFAULT 'practice',
  started_at TEXT,
  ends_at TEXT,
  finished_at TEXT,
  winner_wallet TEXT,
  score_one REAL,
  score_two REAL,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS td_matches_status_idx ON td_matches(status, created_at);
