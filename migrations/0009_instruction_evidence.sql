-- Instruction-level movement evidence for reconciliation; never assume a transfer is a trade.
CREATE TABLE IF NOT EXISTS td_match_instruction_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction INTEGER NOT NULL DEFAULT 0,
  program_id TEXT,
  instruction_type TEXT NOT NULL,
  source TEXT,
  destination TEXT,
  mint TEXT,
  amount_raw TEXT,
  decimals INTEGER,
  amount_ui REAL,
  lamports INTEGER,
  classification TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id,wallet,signature,instruction_index,inner_instruction)
);
CREATE INDEX IF NOT EXISTS td_match_instruction_match_idx ON td_match_instruction_evidence(match_id,wallet,classification);
