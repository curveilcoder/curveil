-- Phase 4: shielded execution on ShieldedPool v2. Still only public chain data: what each
-- execution sent to an adapter and got back, and the public state of liquidity positions held
-- for the vault. Which notes or account own a position is never known to the server.

-- The vault tables now follow ShieldedPool v2. Rows from the v1 pool are removed here and the
-- indexer re-reads v2 from its deploy block (it also clears these tables whenever the pool in
-- the manifest changes).
DELETE FROM vault_commitments;
DELETE FROM vault_nullifiers;
DELETE FROM vault_activity;

ALTER TABLE vault_activity ADD COLUMN adapter TEXT;   -- execute, exec_leg, exec_output
ALTER TABLE vault_activity ADD COLUMN detail TEXT;    -- JSON: resource, shareId, output index, counts
CREATE INDEX vault_activity_tx ON vault_activity (tx_hash);

CREATE TABLE vault_positions (
  position_id TEXT PRIMARY KEY,      -- decimal uint256, chosen by the client at random
  adapter TEXT NOT NULL,
  kind TEXT NOT NULL,                -- damm | dlmm
  market TEXT NOT NULL,
  holder TEXT NOT NULL,              -- the position's holder contract (owns the LP or bin shares)
  used0 TEXT NOT NULL,               -- amounts deposited at entry, in the market's token order
  used1 TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX vault_positions_market ON vault_positions (market);
CREATE INDEX vault_positions_block ON vault_positions (block_number);

CREATE TABLE vault_position_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  position_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  units TEXT NOT NULL,               -- units exited (of 1e18 at entry)
  remaining_units TEXT NOT NULL,
  amount0 TEXT NOT NULL,             -- paid out, fees included, in the market's token order
  amount1 TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX vault_position_events_position ON vault_position_events (position_id, block_number);

UPDATE module_status SET status = 'testnet',
  reason = 'Shielding, private transfers, withdrawals and shielded swaps and liquidity run on testnet with a single-party test setup. Circuits and contracts are unaudited.',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'vault';

UPDATE module_status SET reason = 'Public and shielded swaps route across DAMM and DLMM on testnet. A shielded swap pays from vault notes and returns a note in the same transaction; it pays the pool fee only.',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'swap';

UPDATE module_status SET reason = 'Public and shielded DAMM and DLMM positions are open on testnet. Shielded positions are entered from vault notes and held as share notes that can be exited or sent privately.',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'liquidity';
