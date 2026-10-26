-- Extend detected wallet buys to support USDC-funded swaps as well as SOL-funded swaps.
ALTER TABLE td_wallet_token_buys ADD COLUMN quote_asset TEXT NOT NULL DEFAULT 'SOL';
ALTER TABLE td_wallet_token_buys ADD COLUMN quote_amount REAL NOT NULL DEFAULT 0;
