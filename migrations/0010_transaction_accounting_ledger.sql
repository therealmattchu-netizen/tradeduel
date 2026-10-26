-- Durable per-wallet transaction accounting evidence. Evidence is not an official fill.
CREATE TABLE IF NOT EXISTS td_match_accounting_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  success INTEGER NOT NULL,
  fee_lamports INTEGER NOT NULL DEFAULT 0,
  native_delta_lamports INTEGER NOT NULL DEFAULT 0,
  native_delta_ex_fee_lamports INTEGER NOT NULL DEFAULT 0,
  token_deltas_json TEXT NOT NULL DEFAULT '[]',
  external_flows_json TEXT NOT NULL DEFAULT '[]',
  protocols_json TEXT NOT NULL DEFAULT '[]',
  evidence_level TEXT NOT NULL DEFAULT 'candidate',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id,wallet,signature)
);
CREATE INDEX IF NOT EXISTS td_match_accounting_match_idx ON td_match_accounting_ledger(match_id,wallet,block_time DESC);

-- Persist the actual observed quote and source metadata used by a portfolio snapshot.
-- These are observation-time quotes, not historical backfills.
CREATE TABLE IF NOT EXISTS td_match_price_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  phase TEXT NOT NULL,
  mint TEXT NOT NULL,
  price_usd REAL,
  liquidity_usd REAL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  quote_kind TEXT NOT NULL DEFAULT 'observed_spot',
  accepted INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id,wallet,phase,mint,source)
);
CREATE INDEX IF NOT EXISTS td_match_price_evidence_match_idx ON td_match_price_evidence(match_id,wallet,phase);
