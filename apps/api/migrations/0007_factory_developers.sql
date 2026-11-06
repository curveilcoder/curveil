-- Phase 6: launchpad operators, developer accounts, API keys and webhooks.

-- Operators: current terms, read from the LaunchpadRegistry whenever an event touches one.
-- `address` is the operator's FeeSplitter, which is also its address on launches.
CREATE TABLE operators (
  address TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  admin TEXT NOT NULL,
  pending_admin TEXT,
  share_bps INTEGER NOT NULL,        -- as set; the effective share is min(share_bps, max share)
  active INTEGER NOT NULL,
  suspended INTEGER NOT NULL,
  template_mask TEXT NOT NULL,       -- uint64, decimal
  brand_uri TEXT NOT NULL,
  brand TEXT,                        -- JSON, parsed from an inline data: URI, else null
  recipients TEXT NOT NULL,          -- JSON [{address, weightBps}]
  created_block INTEGER NOT NULL,
  created_tx TEXT NOT NULL,
  created_at INTEGER NOT NULL,       -- unix seconds, from the registry
  block_hash TEXT NOT NULL,
  updated_block INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX operators_admin ON operators (admin);
CREATE INDEX operators_block ON operators (created_block);

CREATE TABLE operator_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  operator TEXT,                     -- null for protocol-wide events (max_share_set)
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'brand_set', 'share_set', 'templates_set', 'active_set', 'suspended',
    'admin_transfer_started', 'admin_transferred', 'max_share_set', 'recipients_set')),
  data TEXT NOT NULL,                -- JSON
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX operator_events_operator ON operator_events (operator, block_number DESC, log_index DESC);
CREATE INDEX operator_events_kind ON operator_events (kind, block_number DESC);
CREATE INDEX operator_events_block ON operator_events (block_number);

-- What each FeeSplitter allocated (distributed) and paid out (released).
CREATE TABLE fee_distributions (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  operator TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('distributed', 'released')),
  token TEXT NOT NULL,
  recipient TEXT,                    -- released only
  amount TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX fee_distributions_operator ON fee_distributions (operator, block_number DESC, log_index DESC);
CREATE INDEX fee_distributions_recipient ON fee_distributions (recipient);
CREATE INDEX fee_distributions_block ON fee_distributions (block_number);

-- Which operator each launch pays (fixed in the curve). Null: not read yet. Zero address: none.
ALTER TABLE launches ADD COLUMN operator TEXT;
ALTER TABLE launches ADD COLUMN operator_share_bps INTEGER;
CREATE INDEX launches_operator ON launches (operator);

-- Off-chain operator settings, written by the operator's admin after sign-in.
CREATE TABLE operator_profiles (
  operator TEXT PRIMARY KEY,
  domain TEXT UNIQUE,
  domain_token TEXT,                 -- expected in the _curveil TXT record
  domain_verified_at TEXT,
  description TEXT,
  contact TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Sign-in with Ethereum (EIP-4361).
CREATE TABLE auth_nonces (
  nonce TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL,
  used_ts INTEGER
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,       -- SHA-256 of the bearer token; the token is never stored
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_ts INTEGER NOT NULL
);
CREATE INDEX sessions_address ON sessions (address);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,              -- first characters, shown in lists
  key_hash TEXT NOT NULL UNIQUE,     -- SHA-256 of the key; the key is shown once and never stored
  tier TEXT NOT NULL DEFAULT 'developer',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_keys_owner ON api_keys (owner);

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,              -- JSON array of event types
  filters TEXT,                      -- JSON {addresses?: string[]}
  description TEXT,
  secret_enc TEXT NOT NULL,          -- signing secret, AES-GCM under the WEBHOOK_MASTER_KEY secret
  secret_hint TEXT NOT NULL,         -- last characters, shown in lists
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_ts INTEGER NOT NULL,       -- events from blocks before this are not delivered
  updated_at TEXT NOT NULL
);
CREATE INDEX webhook_subscriptions_owner ON webhook_subscriptions (owner);
CREATE INDEX webhook_subscriptions_active ON webhook_subscriptions (active);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,            -- stable per chain event, so re-indexing never sends twice
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,             -- the exact JSON body
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_ts INTEGER,
  window_ts INTEGER NOT NULL,        -- start of the 24-hour retry window (creation, or the last replay)
  last_status INTEGER,
  last_error TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  delivered_at TEXT,
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX webhook_deliveries_subscription ON webhook_deliveries (subscription_id, created_ts DESC);
CREATE INDEX webhook_deliveries_status ON webhook_deliveries (status, next_attempt_ts);

CREATE TABLE webhook_attempts (
  delivery_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  at TEXT NOT NULL,
  status INTEGER,                    -- HTTP status, null when no response
  duration_ms INTEGER NOT NULL,
  error TEXT,
  response TEXT,                     -- first 500 characters
  PRIMARY KEY (delivery_id, attempt)
);

UPDATE module_status SET status = 'testnet', reason = 'Branded launchpads are live on testnet: operators register on the LaunchpadRegistry and receive their fee share through a FeeSplitter. Contracts are unaudited.', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'factory';
UPDATE module_status SET reason = 'The public API, OpenAPI reference, SDK, API keys and signed webhooks are live on testnet.', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'developers';
