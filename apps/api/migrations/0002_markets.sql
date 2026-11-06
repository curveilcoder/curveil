-- Phase 1: public markets. Every chain-derived row carries block_number and block_hash so a
-- reorg can delete everything above the common ancestor. Token amounts are exact decimal
-- strings; *_num columns hold float copies scaled by decimals for aggregates only.

CREATE TABLE tokens (
  address TEXT PRIMARY KEY,          -- checksummed
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  is_quote INTEGER NOT NULL DEFAULT 0 -- 1 for USDG (or tUSDG): values are shown in it
);

CREATE TABLE pools (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('damm', 'dlmm')),
  factory TEXT NOT NULL,
  token0 TEXT NOT NULL,              -- tokenX for DLMM
  token1 TEXT NOT NULL,              -- tokenY for DLMM
  fee_tier INTEGER,                  -- DAMM tier id
  base_fee_bps INTEGER NOT NULL,
  max_fee_bps INTEGER,               -- DAMM only
  protocol_share_bps INTEGER NOT NULL,
  bin_step INTEGER,                  -- DLMM only
  created_block INTEGER NOT NULL,
  created_tx TEXT NOT NULL,
  block_hash TEXT NOT NULL
);

CREATE TABLE pool_state (
  pool TEXT PRIMARY KEY,
  reserve0 TEXT NOT NULL,
  reserve1 TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,          -- fee a swap pays now
  active_id INTEGER,                 -- DLMM only
  total_supply TEXT,                 -- DAMM LP supply
  price REAL,                        -- token1 per token0, human units
  block_number INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE swaps (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  pool TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  fee TEXT NOT NULL,                 -- in token_in units
  protocol_fee TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  quote_value REAL,                  -- trade size in the quote token, when one side is the quote token
  quote_fee REAL,                    -- fee in the quote token, same condition
  active_id_after INTEGER,           -- DLMM only
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX swaps_pool_time ON swaps (pool, timestamp DESC);
CREATE INDEX swaps_recipient ON swaps (recipient, timestamp DESC);
CREATE INDEX swaps_block ON swaps (block_number);

CREATE TABLE liquidity_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  pool TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('add', 'remove', 'claim', 'transfer_out', 'transfer_in')),
  owner TEXT NOT NULL,
  counterparty TEXT,                 -- recipient of withdrawals and claims, or the other side of a transfer
  amount0 TEXT NOT NULL,
  amount1 TEXT NOT NULL,
  shares TEXT,                       -- DAMM LP amount, or total DLMM shares
  bins TEXT,                         -- DLMM: JSON array of bin ids
  PRIMARY KEY (tx_hash, log_index, kind)
);
CREATE INDEX liquidity_owner ON liquidity_events (owner, timestamp DESC);
CREATE INDEX liquidity_pool ON liquidity_events (pool, timestamp DESC);
CREATE INDEX liquidity_block ON liquidity_events (block_number);

CREATE TABLE indexer_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  start_block INTEGER NOT NULL,
  indexed_block INTEGER NOT NULL,
  head_block INTEGER NOT NULL,
  finalized_block INTEGER,
  last_error TEXT,
  reorgs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

UPDATE module_status
SET status = 'testnet',
    reason = 'DAMM pools and DLMM pairs are live on testnet with test assets. Contracts are unaudited.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'markets';

UPDATE module_status
SET status = 'testnet',
    reason = 'Public swaps route across DAMM and DLMM on testnet. Shielded swaps follow in Phase 4.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'swap';

UPDATE module_status
SET status = 'testnet',
    reason = 'Public DAMM and DLMM positions are open on testnet. Shielded positions follow in Phase 4.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'liquidity';
