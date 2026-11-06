-- Phase 3: shielded vault. Only public chain data: commitments with their ciphertexts in
-- leaf order, spent nullifiers, and the public side of shield/transfer/withdraw actions.
-- No table holds keys, note plaintext or any link between a wallet and a note.

CREATE TABLE vault_commitments (
  leaf_index INTEGER PRIMARY KEY,
  commitment TEXT NOT NULL,          -- decimal field element
  encrypted_note TEXT NOT NULL,      -- 0x hex, 129 bytes
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX vault_commitments_block ON vault_commitments (block_number);

CREATE TABLE vault_nullifiers (
  nullifier TEXT PRIMARY KEY,        -- decimal field element
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX vault_nullifiers_block ON vault_nullifiers (block_number, log_index);

CREATE TABLE vault_activity (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- shield | transfer | withdraw | fees_claimed
  token TEXT,                        -- null for a transfer without a fee (asset not revealed)
  account TEXT,                      -- depositor (shield) or recipient (withdraw, fees_claimed)
  amount TEXT,
  fee TEXT,
  protocol_fee TEXT,
  fee_recipient TEXT,
  leaf_index INTEGER,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX vault_activity_block ON vault_activity (block_number);
CREATE INDEX vault_activity_account ON vault_activity (account);

UPDATE module_status SET status = 'testnet',
  reason = 'Shielding, private transfers and withdrawals run on testnet with a single-party test setup. Circuits and contracts are unaudited.',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'vault';
