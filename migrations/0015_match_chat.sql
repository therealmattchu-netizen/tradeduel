-- Private participant chat for each match room.
CREATE TABLE IF NOT EXISTS td_match_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (match_id) REFERENCES td_matches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS td_match_chat_messages_match_id_id_idx ON td_match_chat_messages(match_id, id);
