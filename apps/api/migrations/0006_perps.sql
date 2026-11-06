-- Phase 5: perps. Every row is a public chain event, appended as it is indexed (reorgs delete
-- rows above the common ancestor). Live position state (size, collateral, PnL, liquidation
-- price) is read from the chain by the API; these tables give ownership, history and charts.

CREATE TABLE perp_markets (            -- MarketSet and MarketEnabled
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  event TEXT NOT NULL,                 -- set | enabled
  feed_id TEXT,
  enabled INTEGER NOT NULL,
  config TEXT,                         -- JSON of the market config (set only)
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX perp_markets_market ON perp_markets (market_id, block_number);

CREATE TABLE perp_requests (           -- RequestCreated, RequestExecuted, RequestCancelled
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event TEXT NOT NULL,                 -- created | executed | cancelled
  request_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  owner TEXT,                          -- created
  kind TEXT,                           -- open | close (created)
  market_id INTEGER,
  is_long INTEGER,
  size TEXT,
  collateral TEXT,
  acceptable_price TEXT,
  execution_fee TEXT,
  price TEXT,                          -- executed | cancelled
  reason TEXT,                         -- cancelled: timeout, price, market_closed, leverage, ...
  fee_charged TEXT,
  executor TEXT,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX perp_requests_owner ON perp_requests (owner, block_number);
CREATE INDEX perp_requests_request ON perp_requests (request_id);
CREATE INDEX perp_requests_position ON perp_requests (position_id);
CREATE INDEX perp_requests_block ON perp_requests (block_number);

CREATE TABLE perp_positions (          -- PositionOpened, PositionDecreased, CollateralAdded, Payout
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event TEXT NOT NULL,                 -- opened | decreased | collateral | payout
  position_id TEXT NOT NULL,
  owner TEXT,
  market_id INTEGER,
  is_long INTEGER,
  version INTEGER,
  price TEXT,
  size_delta TEXT,                     -- decreased
  size TEXT,                           -- size after the event
  collateral TEXT,                     -- collateral after the event
  pnl TEXT,
  funding TEXT,
  gain TEXT,
  fee TEXT,                            -- open fee or close fee
  execution_fee TEXT,
  amount TEXT,                         -- payout to the owner, or collateral added
  executor TEXT,
  detail TEXT,                         -- JSON: reserve and tokens (opened)
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX perp_positions_position ON perp_positions (position_id, block_number);
CREATE INDEX perp_positions_market ON perp_positions (market_id, block_number);
CREATE INDEX perp_positions_block ON perp_positions (block_number);

CREATE TABLE liquidations (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  position_id TEXT NOT NULL,
  liquidator TEXT NOT NULL,
  price TEXT NOT NULL,
  pnl TEXT NOT NULL,
  funding TEXT NOT NULL,
  fee TEXT NOT NULL,                   -- to the liquidator
  to_vault TEXT NOT NULL,              -- the rest of the collateral, to the liquidity vault
  version INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX liquidations_position ON liquidations (position_id);
CREATE INDEX liquidations_block ON liquidations (block_number);

CREATE TABLE perp_orders (             -- OrderPlaced, OrderExecuted, OrderCancelled
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event TEXT NOT NULL,                 -- placed | executed | cancelled
  order_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  owner TEXT,
  kind TEXT,                           -- take_profit | stop_loss
  trigger_price TEXT,
  size TEXT,                           -- 0 closes the whole position
  acceptable_price TEXT,
  execution_fee TEXT,
  expires_at INTEGER,
  price TEXT,                          -- executed
  size_closed TEXT,
  executor TEXT,
  reason TEXT,                         -- cancelled: owner | expired | position_gone
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX perp_orders_owner ON perp_orders (owner, block_number);
CREATE INDEX perp_orders_order ON perp_orders (order_id);
CREATE INDEX perp_orders_position ON perp_orders (position_id);
CREATE INDEX perp_orders_block ON perp_orders (block_number);

CREATE TABLE funding_updates (         -- FundingUpdated: emitted on every open interest change
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  rate TEXT NOT NULL,                  -- per second, 18 decimals; positive: longs pay
  funding_long TEXT NOT NULL,
  funding_short TEXT NOT NULL,
  oi_long TEXT NOT NULL,
  oi_short TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX funding_updates_market ON funding_updates (market_id, block_number);

CREATE TABLE oracle_prices (           -- PriceRecorded
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  feed_id TEXT NOT NULL,
  price TEXT NOT NULL,                 -- USD per unit, 18 decimals
  report_timestamp INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX oracle_prices_feed ON oracle_prices (feed_id, report_timestamp);
CREATE INDEX oracle_prices_block ON oracle_prices (block_number);

CREATE TABLE perp_vault_events (       -- PerpLiquidityVault Deposited and Redeemed
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event TEXT NOT NULL,                 -- deposit | redeem
  account TEXT NOT NULL,
  receiver TEXT,
  assets TEXT NOT NULL,
  shares TEXT NOT NULL,
  nav_before TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX perp_vault_events_account ON perp_vault_events (account, block_number);
CREATE INDEX perp_vault_events_block ON perp_vault_events (block_number);

CREATE TABLE perp_claims (             -- ShieldedPerpsAdapter: which position a private claim backs
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event TEXT NOT NULL,                 -- opened | collected
  claim_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  request_id TEXT,
  amount TEXT,
  kept INTEGER,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX perp_claims_claim ON perp_claims (claim_id);
CREATE INDEX perp_claims_block ON perp_claims (block_number);

UPDATE module_status SET status = 'testnet',
  reason = 'ETH and BTC perpetuals, up to 5x, run on testnet against a liquidity vault, public or from the shielded vault. Prices come from a Curveil test signer (a median of public exchanges); mainnet needs an oracle network. Contracts are unaudited.',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'perps';
