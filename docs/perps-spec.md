# Curveil perps specification

Status: testnet (Phase 5), manifest `0.6.0-testnet.6`. Contracts unaudited. Prices come from
Pyth (FR-19, decided 5 November 2026; section 8). The testnet deployment listed below predates
that and still uses the Curveil test signer until perps are redeployed on testnet.

This document fixes how perps work. The contracts (`packages/contracts/src/perps`, and
`src/vault/adapters/ShieldedPerpsAdapter.sol`), the keeper (`apps/keeper`), the API
(`apps/api/src/perps.ts` and the indexer) and the website (`apps/web/src/routes/Perps.tsx`)
implement it. Changing a rule here means changing all of them together.

## 1. Summary

- Isolated-margin perpetuals on ETH/USD and BTC/USD, long or short, up to 5× leverage.
- Margined and settled in USDG (tUSDG on testnet, 6 decimals). Prices are 18-decimal USD.
- The counterparty is a liquidity vault funded by providers (section 6).
- Opening and closing are two-step requests that a keeper fills at the next oracle price
  (section 3). Anyone may run the keeper.
- Take-profit and stop-loss orders (section 7).
- Positions can be held publicly from a wallet or privately from the shielded vault, where a
  claim note controls the position (section 9).

## 2. Contracts

| Contract | Role | Testnet address |
| --- | --- | --- |
| `PerpEngine` | Positions, requests, margin, funding, liquidation | `0x1796cd1E631e8a815c9226bD36eac1D2516444eb` |
| `PerpLiquidityVault` | Counterparty and LP shares (`cvPLP`) | `0xBbba08B819906Aa5391F6CE7cdb07cD100CCB600` |
| `OracleAdapter` | Every price passes through it; stores the newest checked price per feed | `0xE8715a97dD9D620a5499efABEBd87D5A1Cc5Faeb` |
| `PythReportVerifier` | Checks Pyth price updates through Pyth's contract (section 8) | not yet deployed |
| `SignedReportVerifier` | Testnet only: checks the test signer's EIP-712 reports | `0x15f7954E15DdA7758472657B91C536AB6A954784` |
| `OrderManager` | Take-profit and stop-loss | `0x30b02e73dc8e8201448A5d50D62a8a52d3C055d5` |
| `PerpLens` | Read-only valuation and liquidation checks for keepers and the API | `0xA12b847614D775E7784b20C26817BdA85fD2BfCe` |
| `ShieldedPerpsAdapter` | Shielded positions through the vault pool | `0x526F08d50853111a61B72a4979C7E60E1EE97fBC` |

All are source-verified on the testnet explorer and listed in the manifest. The owner is the
deployer on testnet; the guardian may only turn new positions off in a market.

## 3. Requests and execution

1. **Open.** `requestOpen(market, isLong, size, collateral, acceptablePrice, executionFee)`
   pulls `collateral + executionFee`. Leverage is checked now against the collateral and again
   at execution after the open fee: `size × 10000 ≤ (collateral − openFee) × maxLeverageBps`.
   The website sizes a position as `size = L × C / (1 + L × openFee)` so the chosen leverage
   always passes.
2. **Close.** `requestClose(positionId, size, acceptablePrice, executionFee)`. A size at or
   above the position's size closes it all. The execution fee comes out of the proceeds.
3. **Execute.** `executeRequest(requestId, report)`. Anyone may call. The report must be the
   oracle's **first** price for the feed observed from the second after the request
   (`createdAt + 1`), and no later than `requestTimeout` (120 s) after it. Only one report
   passes, so whoever executes cannot choose the price; a newer price recorded in between does
   not block the fill. The executor earns the execution fee.
4. **Cancel on failure.** If the price is beyond the trader's limit, or a cap, leverage or the
   minimum collateral fails at that price, the request is cancelled in the same call. An open
   request returns its collateral and the executor keeps the execution fee. A close request
   leaves the position open; the executor is paid at most the minimum execution fee from its
   collateral, and only while the position stays above maintenance margin.
5. **Cancel on timeout.** A request nobody executes within `requestTimeout` can be cancelled
   by anyone for a full refund, execution fee included.

`acceptablePrice` is the worst price accepted: the most a long open or a short close pays, the
least a short open or a long close receives. The website offers 0.3%, 1% and 2% from the mark.

## 4. Margin, fees and caps

Testnet settings, per market (both markets the same; `packages/contracts/config/testnet.json`):

| Setting | Value |
| --- | --- |
| Max leverage | 5× |
| Maintenance margin | 2% of size |
| Open fee / close fee | 0.08% / 0.08% of size |
| Liquidation fee | 0.5% of size, to the liquidator |
| Profit cap | 100% of size |
| Open interest cap | 100,000 USDG per side |
| Minimum collateral | 10 USDG |
| Max funding | 0.01% of size per hour at full skew |
| Execution fee | at least 0.2 USDG |
| Protocol share of trading fees | 20% (80% to the vault) |

Mainnet (`packages/contracts/config/mainnet.json`) uses the same settings except: open interest
cap 50,000 USDG per side, minimum collateral 5 USDG and execution fee at least 0.25 USDG (both
lowered on 5 Nov 2026 with `setMarket` and `setParams`), and ETH and BTC have a Chainlink
reference feed within 1.5%.

SOL-USD (market 3) was added on 5 Nov 2026 on both networks with three owner calls:
`PythReportVerifier.setFeed`, `OracleAdapter.setFeed` and `PerpEngine.setMarket`. It is more
conservative: up to 2x (maxLeverageBps 20000), and 10,000 USDG open interest per side on mainnet (25,000 on testnet).
Robinhood Chain has no Chainlink SOL/USD feed, so SOL has no reference check and relies on Pyth's
confidence limit (1%). LINK-USD was tried as market 4 on testnet and switched off: the Pyth API
key's plan does not cover the LINK feed (Hermes answers 403 "Not entitled"). Check a feed is in the
plan before adding a market. The keeper asks Hermes feed by feed when a batch is refused, so one
feed outside the plan does not stop the others.

- **Reserve and profit cap.** When a position opens, the vault reserves `size × maxProfitBps`.
  A position's gain (price result less funding) is capped at its reserve, so every payout is
  backed. Total reserves may not pass `maxUtilizationBps` (80%) of the vault's USDG.
- **Partial close.** Closes `sizeDelta` with the same share of collateral, reserve and entry
  tokens. A partial close that would leave less than the minimum collateral closes the whole
  position.
- **Add margin.** `addCollateral(positionId, amount)` needs no price and applies at once.
- **Liquidation.** A position is liquidatable when
  `collateral + cappedGain − funding − closeFee < size × maintenanceMargin` at the reported
  price. `liquidate(positionId, report)` is open to anyone; the caller earns the liquidation
  fee and the rest of the collateral goes to the vault. The trader receives nothing from a
  liquidation. `PerpLens.liquidatable(ids, price)` and `valuation(id, price)` give the same
  answer off-chain.
- **Version and finality.** Every change bumps a position's version. A closed, liquidated or
  cancelled position can never reopen; `paidOut` records everything sent to its owner.

## 5. Funding

Funding accrues every second from the skew. The larger side pays
`maxFundingRatePerHour × (long − short) / (long + short)` per unit of size; the smaller side
receives at the same rate; the vault carries the imbalance and keeps the difference.
`updateFunding(market)` brings the index up to date and is open to anyone (the keeper calls it
hourly while a market has open interest). Funding owed is settled when a position decreases,
closes or is liquidated.

## 6. Liquidity vault

- Providers deposit USDG for `cvPLP` shares (`deposit(assets, minShares)`) and redeem with
  `redeem(shares, minAssets, receiver)`. The website rejects a fill more than 0.5% below the
  quote.
- **Net value.** Balance plus the vault's unrealised result on open positions at the latest
  recorded oracle prices: traders' losses and funding owed count for it, their gains (capped
  per side at what is reserved) against it. If a market with open interest has no recorded
  price newer than `navMaxAge` (900 s), share pricing reverts rather than use a stale value.
  The keeper records a fresh price every 10 minutes while a market has open interest.
- **Withdrawals** are limited to USDG not reserved for open positions.
- **Lock.** New deposits lock for `lockSeconds` (15 minutes); locked shares cannot be
  transferred, so the lock cannot be stepped around.
- Virtual shares make share-price inflation by donation unprofitable.

The testnet vault was seeded with 250,000 tUSDG.

## 7. Take-profit and stop-loss

`OrderManager.place(positionId, kind, triggerPrice, size, acceptablePrice, executionFee,
expiresAt)` by the position's owner. Take-profit fires when the price moves in the
position's favour past the trigger; stop-loss when it moves against it. Size zero closes the
whole position. Anyone executes a triggered order with a report newer than the order and
than the newest recorded price; it closes through the engine and the execution fee comes
from the proceeds. Once a position is closed or liquidated, or an order expires, anyone may
clear the order (`expire`); the keeper does this.

The website places a take-profit with a limit 1% beyond the trigger and a stop-loss with no
limit (it always exits), and refuses a trigger on the wrong side of the mark.

## 8. Prices and the oracle

### 8.1 Price source: Pyth

Prices come from Pyth's standard price feeds (pull model), chosen for FR-19 over Chainlink
Data Streams because it is live on Robinhood Chain, needs no agreement and can prove which
update is the first after a time.

| | Mainnet and testnet |
| --- | --- |
| Pyth contract | `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a` (same address on both; Pythnet data source) |
| ETH/USD Pyth id | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| BTC/USD Pyth id | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| Update fee | 0 wei (Pyth governance may change it) |
| Updates from | Hermes, `https://hermes.pyth.network` by default (`HERMES_URL` to change), with a Pyth API key (`PYTH_API_KEY`, required since Aug 26, 2026) |

`report = abi.encode(bytes32 feedId, bytes[] updateData)`, with `feedId = keccak256("ETH/USD")`
or `keccak256("BTC/USD")` and `updateData` as Hermes returns it (`encoding=hex`).
`PythReportVerifier` maps the feed id to the Pyth id and:

- `verifyReport` (liquidations, conditional orders, `submit`): any valid update, through
  `parsePriceFeedUpdates`. The adapter's age limit applies.
- `verifyFirstReport(report, notBefore, notAfter)` (request fills): only the first update at or
  after `notBefore`, through `parsePriceFeedUpdatesUnique` (its publish time is in the range
  and the previous update's is before `notBefore`).
- Scales `price × 10^expo` to 18 decimals and refuses a confidence interval wider than the
  feed's `maxConfBps` (100 bps).
- Pays Pyth's fee from its own ETH balance, at most `maxFee` (1e12 wei) per report. Only the
  OracleAdapter may call it.

The testnet test signer (`SignedReportVerifier`, below) implements `verifyFirstReport` as a
range check only; it remains for the existing testnet deployment.

### 8.2 OracleAdapter checks

Feed configured and enabled; report not older than `maxReportAge` (60 s) and not in the
future; price positive; when a reference feed (a Chainlink push feed) is set, within
`maxDeviationBps` of it (a stale reference blocks new risk only); when a sequencer uptime
feed is set, new risk and liquidations wait for the grace period after an outage (closing is
never held back). The newest checked price per feed is stored, and anyone may submit a report
to refresh it. `priceForRequest` adds the first-price rule (8.1) for request fills.

Mainnet reference feeds: Chainlink ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` and
BTC/USD `0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251` (free to read, 150 bps). No sequencer
uptime feed is configured yet: set one if Chainlink publishes it for Robinhood Chain. Testnet
has neither.

### 8.3 Trust

Pyth prices are an aggregate of Pyth's publishers, signed on Pythnet and carried by Wormhole;
Pyth's contract checks those signatures. Curveil holds no key that can set a price. The
Chainlink reference check limits the damage of a wrong Pyth price to `maxDeviationBps`.

The testnet test signer (`0x34A2BfeC3a400228F764876b9b6CC573Da06378C`) signs a median of
Coinbase, Kraken, Bitstamp and Gemini; whoever holds that key can set any price within the
freshness rules. The manifest schema refuses it on mainnet.

### 8.4 Execution window (settled)

Before, anyone could execute a request with any report observed after it, so a trader who
self-executed could wait inside the 120 s window and pick a favourable price. Requests now fill
only at the first Pyth price after them (3 and 8.1), which removes the choice while keeping
execution open to anyone; no keeper-exclusive period is needed. If Pyth publishes nothing in
the window, the request times out and is refunded. A fill more than `maxReportAge` (60 s) after
the request fails as too old, as before.

Conditional orders and liquidations still accept any fresh price (within 60 s and not older
than the newest recorded), so an executor has some choice there; lowering their age limit is a
possible follow-up.

## 9. Shielded perps

A position opened from vault notes is owned on-chain by `ShieldedPerpsAdapter`. Control sits
in a **claim note**: one unit of `shareResource(adapter, claimId)` in the owner's vault
account, with a random 256-bit `claimId` chosen by the client. Every action spends the claim
note (proving ownership) and issues a fresh one, so actions cannot be linked to a wallet or to
each other.

`params = abi.encode(uint8 op, bytes body)`; every body starts with the claim id.

| Op | Legs (inputs) | Outputs, in order |
| --- | --- | --- |
| Open | USDG `collateral + executionFee` (broadcaster fee on this leg) | claim |
| Close, place order, cancel order | claim; plus USDG 1 unit when the broadcaster takes a fee | claim; USDG 1 unit back when that leg was added |
| Add collateral | claim; USDG `amount` | claim |
| Collect (`keep`) | claim | claim, USDG (fee taken from it) |
| Collect (final) | claim | USDG (fee taken from it) |

Money the engine sends for the position (refunds, close proceeds, order fills) waits in the
adapter until the claim holder collects it into a note (`collectable(claimId)`). A claim only
collects what the engine paid out and the claim has not collected yet; a liquidated position
leaves nothing. `keep` must be true while the position is pending or open and false after.

Public: the market, side, size, collateral, prices and payouts (the engine's events), and that
the adapter holds the position. Private: which vault account holds it, which notes paid for
it, and where the proceeds go. The broadcaster sees the network address and timing, as for
other shielded actions. The website finds a user's claims by matching its unspent notes
against the public claim list (`/v1/perps/claims`).

## 10. Keeper

`apps/keeper` is a Cloudflare Worker with one Durable Object. Each tick:

1. One batched RPC round: nonce, gas balance, gas price, pending requests, open positions,
   active orders, market state and recorded prices.
2. Fetch the latest Pyth prices from Hermes (test signer: aggregate exchange prices), cached;
   refreshed every minute when idle.
3. Plan, in priority order: liquidate, execute requests, cancel timed-out requests, fill
   triggered orders, clear dead orders, record a price (market with open interest and a
   recorded price older than 10 minutes), update funding (hourly with open interest).
4. Build reports (a request fill fetches Hermes's first update after `createdAt + 1`;
   everything else uses the latest), estimate gas in one batch, sign and send up to 6
   transactions.

Cadence: every 3 s while requests wait, 5 s while positions or orders are open, 20 s when idle,
10 s after an error. The Workers free plan allows few cron triggers, so the loop runs on
Durable Object alarms and is also woken by API traffic, by every price read and by the website
after each request. A wake restarts an alarm that is overdue by more than 15 s, so a lost alarm
(after a deploy or an exhausted retry) cannot stop the loop. Tick results are kept in storage, so
status survives the object being evicted between ticks.
Status: `GET /v1/status` on the keeper and `perps.keeper` in the API's `/v1/status`
(health ok, starting, stalled, erroring or low_gas, plus oracle freshness per market).

Keys: the keeper's transaction key is a Worker secret; with Pyth there is no price key (the
test signer's key is a secret only for the old testnet deployment). `PYTH_API_KEY` is a Worker
secret and is required: Hermes answers 401 without it. `HERMES_URL` is optional. The
keeper wallet (`0xf875042Cc8bA6E47e8AdffDBf58386859ed96AD2`) needs testnet ETH; it reports
`low_gas` below 0.0002 ETH. Gas per action is about 0.000003 ETH at testnet prices.

Alerts: when `ALERT_WEBHOOK_URL` (a Worker secret: a Slack or Discord webhook) is set, the
keeper checks once a minute and posts when its gas is low, three passes in a row fail, fewer
than `MIN_SOURCES` price sources answer, a market with open interest has no price newer than
15 minutes, or the broadcaster (`BROADCASTER_URL`) is down. A problem is posted when it
starts, again every hour while it lasts, and once when it clears. Every call queued in the
timelock (`CallScheduled`) is posted once, with its target, function and delay.

## 11. API

| Endpoint | Returns |
| --- | --- |
| `GET /v1/perps/markets` | Engine parameters, vault stats, per-market config, state, mark and recorded price, 24 h volume |
| `GET /v1/perps/markets/:id/funding` | Funding updates |
| `GET /v1/perps/markets/:id/prices` | Recorded oracle prices |
| `GET /v1/perps/markets/:id/activity` | Recent requests, closes and liquidations |
| `GET /v1/perps/positions/:owner` | Positions with live valuation, and requests |
| `GET /v1/perps/position/:id` | One position with its full history and orders |
| `GET /v1/perps/orders/:owner` | Orders with live status |
| `GET /v1/perps/vault/:account` | LP shares, value, unlock time and history |
| `GET /v1/perps/claims` | Shielded claims (claim id, position, request) |
| `GET /v1/perps/prices` | Current reports from the keeper (latest Pyth updates) |
| `POST /v1/perps/kick` | Wakes the keeper |

## 12. Without Curveil's services

Everything is callable directly on the contracts. Positions, orders and claims are readable
from the engine, `OrderManager` and the adapter, and `PerpLens` values them at any price.

- **Execute your own request.** Fetch the first Pyth update after it from any Hermes:
  `GET /v2/updates/price/{createdAt + 1}?ids[]=<pyth id>&encoding=hex`, wrap it as
  `abi.encode(feedId, [update])` and call `executeRequest`. Every executor gets the same price.
- **Get your money back if nobody executes.** After 120 s, `cancelRequest(requestId)` refunds
  an open request in full, from any address.
- **Run a keeper.** `apps/keeper` deploys to any Cloudflare account with your own transaction
  key; with Pyth it needs no Curveil key at all.
- **Shielded claims.** Claim notes are ordinary vault notes, so the vault alternative client
  (`docs/vault-alternative-client.md`) finds them and can spend them with the adapter's
  params above.

## 13. Testnet verification (2 November 2026)

Run against the deployed contracts, keeper and indexer, through the production website build:

- Public: LP deposit (1,000 tUSDG) and redeem (500 shares); 3× ETH long opened and filled by
  the keeper in about 20 s; take-profit placed and cancelled; stop-loss placed; a triggered
  50% take-profit filled by the keeper; the rest closed by request; the stop-loss cleared by
  the keeper once the position was gone.
- Shielded (through the broadcaster and from a wallet): 2× ETH short opened from notes;
  margin added twice; take-profit placed and cancelled; 50% closed; proceeds collected while
  the position stayed open; the rest closed from a wallet; final proceeds collected, ending the
  claim; a leftover order cleared by the keeper.
- Liquidation, on a local fork of testnet with the deployed contracts: a 5× long at 2,275
  showed a liquidation price of 1,867.32; the lens flagged it just below that price and not
  just above; liquidating above it reverted; liquidating below paid the liquidator 0.5% of
  size and the rest to the vault.

## 14. Before mainnet

- Deploy perps with the Pyth verifier (decided: FR-19, section 8) and confirm the Pyth address
  on Pyth's own contract list. Sequencer uptime feed if Chainlink publishes one.
- Audit of the perps contracts and the shielded adapter.
- Market parameters and caps signed off against vault size.
- A dedicated RPC for the keeper (the public testnet RPC rate-limits under load) and a funded,
  monitored keeper wallet; at least one independent keeper.
- Owner and guardian moved to the protocol multisig.
