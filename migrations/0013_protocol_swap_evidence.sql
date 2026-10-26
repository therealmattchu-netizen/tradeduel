-- Normalized swap-shaped balance evidence. Rows are candidates, never official fills.
CREATE TABLE IF NOT EXISTS td_protocol_swap_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  protocol TEXT NOT NULL,
  instruction_names_json TEXT NOT NULL DEFAULT '[]',
  input_mint TEXT NOT NULL,
  input_raw TEXT NOT NULL,
  input_decimals INTEGER NOT NULL,
  output_mint TEXT NOT NULL,
  output_raw TEXT NOT NULL,
  output_decimals INTEGER NOT NULL,
  native_delta_lamports INTEGER NOT NULL DEFAULT 0,
  fee_lamports INTEGER NOT NULL DEFAULT 0,
  evidence_level TEXT NOT NULL DEFAULT 'candidate',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id,wallet,signature)
);
CREATE INDEX IF NOT EXISTS td_protocol_swap_evidence_match_idx
  ON td_protocol_swap_evidence(match_id,wallet,block_time DESC);
