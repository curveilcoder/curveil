-- Governance records (Phase 7): every event of the timelock, the protocol treasuries and the
-- buyback burner, so the Transparency page can show the admin queue, treasury releases and burns.
CREATE TABLE governance_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  contract TEXT NOT NULL,   -- manifest name, e.g. CurveilTimelock, TreasuryMarkets, BuybackBurner
  kind TEXT NOT NULL,       -- event name
  op_id TEXT,               -- timelock operation id, for timelock events
  data TEXT NOT NULL,       -- event arguments as JSON (integers as strings)
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX governance_events_contract ON governance_events (contract, block_number);
CREATE INDEX governance_events_op ON governance_events (op_id);
