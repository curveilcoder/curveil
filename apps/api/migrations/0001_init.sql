-- Phase 0 schema. Every chain-derived table added later carries
-- block_number, block_hash, tx_hash, log_index with UNIQUE (tx_hash, log_index).

CREATE TABLE module_status (
  id TEXT PRIMARY KEY,               -- markets, swap, liquidity, vault, launch, perps, factory, developers, transparency
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live', 'testnet', 'not_live', 'degraded', 'paused')),
  phase INTEGER NOT NULL,            -- delivery phase that brings it live
  reason TEXT NOT NULL,              -- shown to users verbatim
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE manifests (
  version TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Indexer bookkeeping (used from Phase 1): canonical blocks for reorg detection.
CREATE TABLE blocks (
  number INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  parent_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  finality TEXT NOT NULL CHECK (finality IN ('sequencer', 'posted', 'final'))
);

INSERT INTO module_status (id, name, status, phase, reason) VALUES
  ('markets', 'Markets', 'not_live', 1, 'DAMM and DLMM pools are being built. Pool discovery opens when they pass testnet acceptance.'),
  ('swap', 'Swap', 'not_live', 1, 'Public swaps open with the Markets release. Shielded swaps follow in Phase 4.'),
  ('liquidity', 'Liquidity', 'not_live', 1, 'Public liquidity opens with the Markets release. Shielded positions follow in Phase 4.'),
  ('launch', 'Launch', 'not_live', 2, 'The launch template, bonding curve and LP escrow are scheduled after Markets.'),
  ('vault', 'Vault', 'not_live', 3, 'Shielded accounts need reviewed circuits and the vault contracts. Not available yet.'),
  ('perps', 'Perps', 'not_live', 5, 'No perpetual market is enabled. Markets need a verified oracle and funded counterparty capacity first.'),
  ('factory', 'Factory', 'not_live', 6, 'Branded launchpads follow the Launch module.'),
  ('developers', 'Developers', 'testnet', 0, 'Status and manifest endpoints and the testnet faucet are live on testnet.'),
  ('transparency', 'Transparency', 'testnet', 0, 'The deployment manifest is published. Treasury and governance records start when those contracts deploy.');
