# Audit package 3: perps (draft)

Isolated-margin perpetuals on ETH/USD and BTC/USD, settled in USDG, with a liquidity vault as counterparty and a shielded adapter for private positions. Perps go live on mainnet after this audit and a signed agreement with an oracle network for low-latency price reports.

**Status: draft.** The package freezes (tag `audit-3-perps`) only after the oracle network is chosen, because two parts depend on it: the report verifier, and how execution picks its price (section 6, item 1). Everything else is ready for review now.

- **Spec:** [`docs/perps-spec.md`](../perps-spec.md).
- **Toolchain:** as package 1.
- **Depends on:** package 1 (AssetRegistry, governance) and package 2 (ShieldedPool, for the shielded adapter).

## 1. Scope

| Contract | nSLOC | What it does |
| --- | ---: | --- |
| `src/perps/PerpEngine.sol` | 756 | Positions, two-step requests, margin, funding, liquidation, caps |
| `src/perps/PerpLiquidityVault.sol` | 135 | Counterparty vault, `cvPLP` shares with virtual shares, deposit lock, utilisation cap |
| `src/perps/OracleAdapter.sol` | 154 | Checks every report (age, future, sign, deviation from a reference feed, sequencer uptime) and stores the newest per feed |
| `src/perps/OrderManager.sol` | 170 | Take-profit and stop-loss |
| `src/perps/PerpLens.sol` | 45 | Read-only valuation and liquidation checks |
| `src/perps/interfaces/*.sol` | 12 | |
| `src/vault/adapters/ShieldedPerpsAdapter.sol` | 163 | Positions owned by the adapter and controlled by a claim note in the vault |
| `src/perps/oracle/SignedReportVerifier.sol` | 36 | **Testnet only.** Replaced on mainnet by the oracle network's verifier |
| **Total (mainnet)** | **1,435** | |

## 2. Privileged roles

| Contract | Role | Can | Cannot |
| --- | --- | --- | --- |
| PerpEngine | owner (timelock) | `setMarket` (bounded parameters), `setOrderManager`, `setGuardian`, turn new positions on or off | Move collateral, change an open position |
| PerpEngine | guardian (Safe) | Turn new positions off in a market | Turn them on, block closes or liquidations |
| PerpLiquidityVault | owner | `setEngine`, `setParams` (utilisation cap, lock, deposit cap) | Take providers' USDG |
| OracleAdapter | owner | `setVerifier`, feed settings, `setSequencerFeed` | Post a price without a valid report |
| keeper | anyone | Execute requests, liquidate, update funding, execute triggered orders, refresh prices | Choose a price older than the request or than the newest recorded one |

## 3. Trust assumptions

1. **The oracle network** signs prices honestly and on time. The adapter's checks bound the damage of a bad report: freshness, positivity, deviation from a Chainlink push feed (`ETH/USD` `0x78F3…d3A9`, `BTC/USD` `0xa2c5…0251`, both live on Robinhood Chain mainnet), and the sequencer uptime feed.
2. **Keepers** are live. Anyone can run one, so an outage delays but never blocks. Requests nobody executes can be cancelled for a full refund after `requestTimeout`.
3. **USDG** as in package 1.

## 4. Invariants

- Every USDG the engine holds is someone's collateral or escrow, no more and no less. [`PerpsInvariant.invariant_EngineHoldsExactlyCollateral`]
- What the vault has reserved for open positions is always there. [`invariant_VaultCoversReserves`]
- Aggregate open interest and reserves match the positions they summarise. [`invariant_AggregatesMatchPositions`]
- A closed, liquidated or cancelled position never comes back. [`invariant_RetiredPositionsStayRetired`]
- A position's gain is capped at its reserve, so every payout is backed.
- Share pricing reverts rather than use a stale price for a market with open interest.

## 5. Known issues and accepted risks

1. **Execution option (open).** Execution accepts any valid report observed after the request. A trader who self-executes could wait inside the 120-second window and choose a favourable report. Recommended fix for mainnet: require the first report after the request, which Chainlink Data Streams' commit-and-reveal flow allows, or give the keeper a short exclusive window before public execution. Settled together with the oracle choice.
2. **Liquidation leaves the trader nothing.** The remaining collateral goes to the vault, the fee to the liquidator. Disclosed in the app.
3. **Funding is linear in skew** and capped per hour. Parameters are signed off against vault size before launch.

## 6. Before freezing this package

1. Choose the oracle network and integrate its verifier in `OracleAdapter.setVerifier`'s slot.
2. Settle the execution option (item 5.1) and implement it.
3. Set mainnet market parameters and caps against the vault's planned size.
4. Regenerate coverage and Slither output for the frozen commit.
