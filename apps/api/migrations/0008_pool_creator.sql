-- Who sent the transaction that created each pool, so an account page can list the pools it made.
-- Filled by the indexer from the creating transaction; null until it has been read.
ALTER TABLE pools ADD COLUMN creator TEXT;
CREATE INDEX pools_creator ON pools (creator);
