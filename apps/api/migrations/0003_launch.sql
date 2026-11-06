-- Phase 2: launches. Templates are read from the registry (they are immutable apart from the
-- enabled flag). Everything else is event-sourced with block_number and block_hash so a reorg
-- deletes rows above the common ancestor; current state is derived from the latest events.

CREATE TABLE launch_templates (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  total_supply TEXT NOT NULL,
  curve_supply TEXT NOT NULL,
  migration_supply TEXT NOT NULL,
  graduation_threshold TEXT NOT NULL,
  virtual_quote TEXT NOT NULL,
  virtual_base TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  creator_fee_share_bps INTEGER NOT NULL,
  damm_tier INTEGER NOT NULL,
  damm_base_fee_bps INTEGER NOT NULL,
  damm_max_fee_bps INTEGER NOT NULL,
  price_tolerance_bps INTEGER NOT NULL,
  creator_lp_bps INTEGER NOT NULL,
  creator_lock_seconds INTEGER NOT NULL,
  protocol_lock_seconds INTEGER NOT NULL,
  protocol_fee_recipient TEXT NOT NULL,
  protocol_lp_recipient TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE launches (
  token TEXT PRIMARY KEY,
  curve TEXT NOT NULL UNIQUE,
  creator TEXT NOT NULL,
  creator_recipient TEXT NOT NULL,   -- at creation; later changes are launch_events
  template_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  metadata_uri TEXT NOT NULL,
  created_block INTEGER NOT NULL,
  created_tx TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  block_hash TEXT NOT NULL
);
CREATE INDEX launches_creator ON launches (creator);
CREATE INDEX launches_block ON launches (created_block);

CREATE TABLE curve_trades (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  token TEXT NOT NULL,
  trader TEXT NOT NULL,
  recipient TEXT NOT NULL,
  is_buy INTEGER NOT NULL,
  quote_amount TEXT NOT NULL,        -- gross: paid in for buys, before the fee for sells
  token_amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  reserve_after TEXT NOT NULL,
  virtual_base_after TEXT NOT NULL,
  quote_value REAL NOT NULL,         -- quote_amount in quote units, for aggregates
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX curve_trades_token ON curve_trades (token, block_number DESC, log_index DESC);
CREATE INDEX curve_trades_trader ON curve_trades (trader, timestamp DESC);
CREATE INDEX curve_trades_block ON curve_trades (block_number);

-- state changes, graduation, fee claims and creator-recipient changes, from the curve
CREATE TABLE launch_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('state', 'graduated', 'fees_claimed', 'recipient_set')),
  data TEXT NOT NULL,                -- JSON
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX launch_events_token ON launch_events (token, kind, block_number DESC, log_index DESC);
CREATE INDEX launch_events_block ON launch_events (block_number);

CREATE TABLE escrow_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  lock_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'claimed', 'fees_claimed', 'transferred')),
  lp_token TEXT,                     -- created
  beneficiary TEXT NOT NULL,         -- the beneficiary after this event
  counterparty TEXT,                 -- recipient of a claim, or previous beneficiary
  amount TEXT,                       -- LP shares (created, claimed)
  amount0 TEXT,                      -- fees (fees_claimed)
  amount1 TEXT,
  unlock_at INTEGER,                 -- created
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX escrow_events_lock ON escrow_events (lock_id, block_number DESC, log_index DESC);
CREATE INDEX escrow_events_beneficiary ON escrow_events (beneficiary);
CREATE INDEX escrow_events_block ON escrow_events (block_number);

UPDATE module_status SET status = 'testnet', reason = 'Token launches, curve trading, graduation into DAMM and LP escrow are live on testnet with test assets. Template economics are proposed and contracts are unaudited.', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'launch';
