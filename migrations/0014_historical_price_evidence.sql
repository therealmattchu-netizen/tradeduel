-- Historical candle provenance used to revalue captured portfolio snapshots.
-- A candle price is only accepted when the candle timestamp is close to the snapshot.
CREATE TABLE IF NOT EXISTS td_match_historical_price_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  phase TEXT NOT NULL,
  mint TEXT NOT NULL,
  target_at INTEGER NOT NULL,
  candle_at INTEGER,
  price_usd REAL,
  liquidity_usd REAL,
  pool_address TEXT,
  source TEXT NOT NULL DEFAULT 'geckoterminal_ohlcv',
  accepted INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id,wallet,phase,mint)
);
CREATE INDEX IF NOT EXISTS td_match_historical_price_idx
  ON td_match_historical_price_evidence(match_id,wallet,phase,accepted);

CREATE TABLE IF NOT EXISTS td_match_historical_valuations (
  match_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  phase TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  portfolio_usd REAL,
  priced_mints INTEGER NOT NULL DEFAULT 0,
  unpriced_mints INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'geckoterminal_historical_ohlcv',
  integrity_note TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(match_id,wallet,phase)
);
