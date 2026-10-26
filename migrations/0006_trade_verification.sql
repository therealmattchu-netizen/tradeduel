-- Transaction-level evidence. Candidate classifications are not settlement or P&L.
CREATE TABLE IF NOT EXISTS td_match_trade_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  fee_lamports INTEGER NOT NULL DEFAULT 0,
  sol_delta REAL NOT NULL DEFAULT 0,
  token_deltas_json TEXT NOT NULL DEFAULT '[]',
  program_ids_json TEXT NOT NULL DEFAULT '[]',
  classification TEXT NOT NULL DEFAULT 'ambiguous',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, wallet, signature)
);
CREATE INDEX IF NOT EXISTS td_match_trade_audits_timeline_idx ON td_match_trade_audits(match_id, block_time DESC);
CREATE INDEX IF NOT EXISTS td_match_trade_audits_wallet_idx ON td_match_trade_audits(match_id, wallet, classification);
