# Audit package 1: markets, launches and launchpads

This is the first module Curveil puts on mainnet. It covers spot trading (DAMM and DLMM pools and the router), token launches (templates, bonding curves, graduation, LP escrow), branded launchpads, and the governance contracts every module is owned by.

- **Chain:** Robinhood Chain mainnet (Arbitrum Orbit, chain id 4663). Rehearsed on testnet (chain id 46630).
- **Commit:** tag `audit-1-markets-launch` (see `git show audit-1-markets-launch`).
- **Compiler:** solc 0.8.28, optimizer 200 runs, EVM `cancun`, no via-ir, `bytecode_hash = none`.
- **Dependencies:** OpenZeppelin Contracts 5.6.1 (Ownable2Step, ReentrancyGuard, SafeERC20, ERC20, Clones, TimelockController, Math). No proxies. No upgradeable contracts.
- **Specs:** whitepaper sections 5 (markets), 10 and 11 (launch and graduation), 12 (launchpads), 18 (buyback and burn); [`docs/factory-spec.md`](../factory-spec.md).

## 1. Scope

nSLOC counts lines that are not blank and not comments.

| Contract | nSLOC | What it does |
| --- | ---: | --- |
| `src/markets/DammPool.sol` | 249 | Full-range x·y=k pool with a bounded dynamic fee. LP fees are held outside reserves and claimed per share. ERC-20 LP share |
| `src/markets/DammFactory.sol` | 72 | Permissionless pool creation per pair of admitted assets and fee tier |
| `src/markets/DlmmPair.sol` | 483 | Discrete-bin liquidity. Per-bin shares (transferable with `transferShares`), per-bin fee accrual, up to 128 bin crossings per swap |
| `src/markets/DlmmFactory.sol` | 96 | Permissionless pair creation per (pair, bin step) |
| `src/markets/CurveilRouter.sol` | 159 | Exact-input multi-hop swaps and deposit wrappers. Holds nothing between calls |
| `src/markets/libraries/BinMath.sol` | 30 | Bin price `(1 + binStep/10_000)^(id − 2^23)` in Q128 |
| `src/markets/libraries/BinBitmap.sol` | 85 | Two-level bitmap of non-empty bins |
| `src/markets/libraries/LiquidityShapes.sol` | 51 | Spot, curve and bid-ask deposit distributions |
| `src/markets/interfaces/ICurveilPool.sol` | 10 | |
| `src/launch/LaunchFactory.sol` | 145 | Creates a fixed-supply token and its curve from an enabled template |
| `src/launch/LaunchTemplateRegistry.sol` | 149 | Immutable, versioned templates. Derives virtual reserves so the curve ends at the migration price |
| `src/launch/BondingCurve.sol` | 256 | Virtual-reserve curve, fee buckets (creator, operator, protocol), partial fill at the threshold |
| `src/launch/GraduationMigrator.sol` | 150 | Moves a graduated curve into its DAMM pool, with price, pool and LP checks |
| `src/launch/LpEscrow.sol` | 169 | Time locks for graduation LP shares, with fees flowing while locked |
| `src/launch/AdmissionController.sol` | 46 | Owns the AssetRegistry. Launch tokens can only be admitted at graduation |
| `src/launch/CurveilLaunchToken.sol` | 13 | Fixed-supply ERC-20. No owner, no mint, no pause |
| `src/launch/interfaces/ILaunch.sol` | 10 | |
| `src/factory/LaunchpadRegistry.sol` | 178 | Operator registration, terms, brand, suspension |
| `src/factory/FeeSplitter.sol` | 90 | Per-operator clone that splits operator fees by fixed weights |
| `src/shared/AssetRegistry.sol` | 59 | Admitted assets |
| `src/shared/TransferHelper.sol` | 16 | `pullExact`: rejects fee-on-transfer and rebasing tokens |
| `src/shared/Guarded.sol` | 15 | Guardian that can only switch new risk off |
| `src/governance/CurveilTimelock.sol` | 23 | OpenZeppelin TimelockController with a 72-hour floor on chain 4663 |
| `src/governance/ProtocolTreasury.sol` | 23 | One bucket per fee source, released only by the timelock |
| `src/governance/BuybackBurner.sol` | 104 | Buys CURVEIL with USDG through its DAMM pool and sends it to the burn address, capped at 1% price impact |
| **Total** | **2,681** | |

**Out of scope:** the shielded vault and its adapters (package 2), perps (package 3), `src/testnet/*` (testnet faucet and test tokens, never deployed on mainnet), deploy scripts (reviewed for configuration only), and everything off chain (web app, API, keeper, broadcaster).

## 2. How the pieces fit

```
                AssetRegistry  <── owned by ── AdmissionController ── owned by ──┐
                     │                              │                            │
       DammFactory ──┤                   GraduationMigrator (no owner)           │
       DlmmFactory ──┘                              │                            │
            │                                       ▼                            │
   DammPool / DlmmPair  <─── CurveilRouter    LpEscrow                           │
            ▲                                                                    │
            │ graduation                                                         │
   BondingCurve  <── LaunchFactory ── LaunchTemplateRegistry                     │
            │              │                                                     │
            │      LaunchpadRegistry ── FeeSplitter clones                       │
            │                                                                    │
   fees ──► ProtocolTreasury (x5) ──► BuybackBurner ──► 0x…dEaD                  │
                                                                                 │
   CurveilTimelock (72 h) ◄── proposes and executes ── Safe (3 of 3) ────────────┘
```

**A launch's life.** `createLaunch` mints the whole supply to a new `BondingCurve`: curve inventory for sale and migration inventory for the pool. Buyers pay quote (USDG) into the curve. The buy that crosses the graduation threshold is partly filled and the rest stays with the buyer. Anyone can then call `graduate`, which hands reserves and migration inventory to the `GraduationMigrator`. The migrator admits the token, creates the DAMM pool, checks the price against the curve's final price, mints LP, burns the minimum liquidity, and locks the creator and protocol LP shares in `LpEscrow`. If any check fails, the whole graduation reverts and the reserves stay in the curve.

**Fees.** Curve fee = creator share (template) + operator share (fixed per launch, capped by the registry) + protocol share (the rest). Pool fees split between LPs and the protocol share set per tier or pair at creation. Protocol shares go to the factory's `feeTo`, which on mainnet is a `ProtocolTreasury`, as is the launch's `protocolFeeRecipient`. The protocol's LP locks name the timelock as beneficiary: only a lock's beneficiary can claim it, and a `ProtocolTreasury` can only transfer tokens it holds, so the timelock claims them (a Safe vote and the delay) and sends them to a treasury.

## 3. Privileged roles

On mainnet every owner is the `CurveilTimelock` (72-hour minimum delay, refuses less). The Safe (3 of 3, hardware wallets) is the only proposer and executor. The Safe is also the guardian, which can only switch new risk off and acts at once.

| Contract | Role | Can | Cannot |
| --- | --- | --- | --- |
| DammFactory | owner | Add or change fee tiers (bounded: base ≤ max ≤ 10%, protocol share ≤ 50%), set `feeTo` | Change an existing pool's fees, touch reserves or LP fees |
| DlmmFactory | owner | Add or change bin-step presets (base fee ≤ 10%), set protocol share for new pairs (≤ 50%), set `feeTo` | Change an existing pair |
| AdmissionController | owner | Admit, suspend and reinstate assets (except launch tokens), hand the registry on | Admit a launch token before graduation |
| AdmissionController | guardian | Suspend an asset | Reinstate it |
| AdmissionController | migrator | Admit the graduating launch token | Anything else |
| LaunchTemplateRegistry | owner | Add a template (bounded: curve fee ≤ 5%, tolerance ≤ 10%, locks ≤ 4 years), enable or disable it for new launches | Edit a template or a live launch |
| LaunchFactory | owner | Pause and resume new launches, set the migrator once, set the launchpad registry for new launches | Touch a live launch, its token or its reserves |
| LaunchFactory | guardian | Pause new launches | Resume them |
| LpEscrow | owner | Add or remove lockers | Change, shorten or withdraw a lock |
| LaunchpadRegistry | owner | Set the share cap (applies to new launches), suspend and lift suspension of an operator | Change a live launch or move allocated fees |
| LaunchpadRegistry | guardian | Suspend an operator | Lift a suspension |
| LaunchpadRegistry | operator admin | Brand, share (≤ cap), templates, active, recipients, two-step admin transfer | Change live launches or allocated fees |
| BondingCurve | factory (once) | Initialise the curve | Anything after |
| ProtocolTreasury | owner | `release(token, to, amount, memo)` | Pull from anyone |
| BuybackBurner | owner | Bind token and pool once, set operator, return unspent USDG | Re-bind |
| BuybackBurner | operator (Safe) | Run a tranche (≤ 1% impact, `minOut`, deadline), burn held CURVEIL | Send CURVEIL anywhere except the burn address |
| CurveilTimelock | proposer and executor (Safe) | Schedule, execute and cancel admin calls after the delay | Lower the delay under 72 hours on chain 4663 |

Contracts with no owner at all: `DammPool`, `DlmmPair`, `CurveilRouter`, `BondingCurve` (after initialisation), `GraduationMigrator`, `CurveilLaunchToken`, `FeeSplitter` (only the registry configures it).

**Handover.** Deploy scripts deploy with the deployer as owner, configure, then call `transferOwnership(timelock)` (Ownable2Step). Nothing is live until the Safe schedules one `acceptOwnership` batch through the timelock and executes it 72 hours later. `pnpm --filter @curveil/manifest handover` builds that batch from the deployment files and lists every contract's owner, so none is missed.

## 4. Trust assumptions

1. **USDG is centrally controlled.** USDG on Robinhood Chain (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) is a UUPS proxy. Its issuer can upgrade it, mint, pause, and freeze addresses. A frozen pool, curve or escrow cannot move USDG, so trading and graduation in that market would stop. Curveil cannot prevent this and says so in the app.
2. **WETH is a bridged token** (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, an upgradeable proxy behind the Arbitrum gateway). Same class of risk.
3. **Admitted assets are plain ERC-20s.** No fee on transfer, no rebasing, no transfer hooks. `pullExact` rejects the first two at entry. Admission is a timelocked decision and a compatibility statement, not an endorsement.
4. **The sequencer** orders transactions. Curveil has no MEV protection beyond `minOut` and deadlines.
5. **The Safe signers** act in good faith within the 72-hour window, and users watch the queue. The site shows every queued admin call on the Transparency page.

## 5. Invariants

Each is tested; the test names are in brackets.

**DAMM pool**
- Reserves never exceed the pool's token balances; the gap covers all LP and protocol fees owed. [`MarketsInvariant.invariant_dammSolvent`, `invariant_dammClaimsCovered`]
- The fee charged is always between the tier's base and max fee. [`invariant_dammFeeBounded`]
- k does not decrease across a swap, and the quote equals the executed swap. [`DammPool.t.sol testFuzz_quoteEqualsSwapAndKHolds`]
- The first `MINIMUM_LIQUIDITY` shares go to the dead address, so the share price cannot be inflated from zero.

**DLMM pair**
- The sum of bin reserves equals the pair's recorded reserves. [`invariant_dlmmBinsMatchReserves`]
- Balances cover reserves plus every fee owed. [`invariant_dlmmSolventAndClaimsCovered`]
- Bins above the active bin hold only X, bins below only Y. [`invariant_dlmmCompositionAroundActive`]
- A deposit followed by a withdrawal in the active bin can never act as a fee-free swap (the deposit is taken in the bin's current proportion, the excess refunded). [`DlmmPair.t.sol`]

**Launch**
- Quote held by a curve equals its reserve plus its unclaimed fee buckets. [`LaunchInvariant.invariant_QuoteBackedByReservesAndFees`]
- Tokens are conserved: curve inventory + holders = total supply, and no mint exists. [`invariant_TokensConserved`]
- A curve can always pay every seller back along the curve. [`invariant_CurveSolvent`]
- No buy passes the threshold. The crossing buy is partly filled and stops trading. [`Launch.t.sol test_ThresholdBuyIsPartiallyFilledAndStopsTrading`]
- Graduation either completes every check or reverts with reserves in place.
- The DAMM pool opens within the template's tolerance of the curve's final price.

**Launchpads**
- A FeeSplitter's allocations always add up to what it received, never more. Allocated amounts stay with their recipient when recipients change. [`Factory.t.sol`]
- An operator's share on a launch is `min(share, cap)` at creation and never changes.

**Governance**
- No owner function on a timelock-owned contract runs without the full delay. [`Governance.t.sol test_noAdminCallBypassesTheDelay`]
- The timelock on chain 4663 refuses a delay under 72 hours, at construction and on update. [`test_mainnetFloorHolds`]
- A treasury releases only through the timelock. [`test_treasuryReleasesOnlyThroughTheTimelock`]
- A buyback above 1% quoted impact reverts. Every token bought goes to the dead address. [`test_buybackRefusesAboveOnePercentImpact`, `test_buybackBurnsWithinTheImpactCap`]
- The guardian can only switch things off. Pausing never stops trading or exits on live launches. [`Guardian.t.sol`]

## 6. Known issues and accepted risks

1. **Pools follow the Uniswap v2 "transfer, then call" pattern.** `swap` and `mint` measure input by balance difference. Tokens sent to a pool outside one atomic call can be taken by the next caller. The router and the migrator always transfer and call in one transaction. Direct integrators must do the same.
2. **Suspending an asset stops new pools, not existing ones.** The factories check admission at creation. Swaps, deposits and withdrawals in existing pools continue, by design (exits are never blocked).
3. **Buybacks can be front-run.** The 1% cap is measured against the pool's price at execution, so a sandwich can move the reference first. The operator must set `minOut` from an independent quote. Tranches are small and announced in advance.
4. **The CURVEIL token cannot burn.** Launch tokens have a fixed supply and no burn function. A burn is a transfer to `0x…dEaD`, and circulating supply is `totalSupply − balanceOf(0x…dEaD)`.
5. **Fee tiers and templates are only as good as their parameters.** The bounds in code stop extreme values, but a badly chosen template (for example a threshold that is too low) would still be valid. Templates are timelocked and published before they are enabled.
6. **A launch name, symbol or metadata URI is user input.** The contracts bound the lengths only. The app and API escape them.
7. **Rounding** favours the pool or curve everywhere (fees round up, outputs round down). Dust can stay in contracts.

## 7. Static analysis

Slither 0.11.6 over `src/`, filtered to this package. Full output: `slither.json` in the audit bundle.

| Detector | Count | Triage |
| --- | ---: | --- |
| arbitrary-send-erc20 (High) | 1 | `TransferHelper.pullExact(token, from, amount)`. Every caller passes `msg.sender` as `from`. False positive |
| reentrancy-balance (High) | 2 | `GraduationMigrator._deposit` reads balances after calling the pool. The pool is the factory's own, the tokens are the launch token and an admitted quote asset, and the migrator is only reachable from a curve's `nonReentrant` `graduate`. False positive |
| incorrect-equality (Medium) | 14 | All are `== 0` checks on amounts and supplies. False positive |
| reentrancy-no-eth (Medium) | 4 | `LpEscrow` calls the trusted DAMM pool's `claimFees` and the LP token's `transfer` inside `nonReentrant` functions. `LaunchpadRegistry.register` calls a fresh clone it just created. False positive |
| uninitialized-local (Medium) | 6 | Accumulators relying on Solidity's zero default. Intended |
| unused-return (Medium) | 3 | `FeeSplitter.collect` ignores the claimed amount (it distributes the balance difference). `LaunchFactory._initialBuy` uses only `quoteUsed`. `DlmmPair` constructor calls `getPrice` only to revert out of range. Intended |
| Low and informational | 42 | Loops over external calls (bounded by `MAX_RECIPIENTS = 8` and `MAX_BINS_PER_CALL = 101`), timestamp use for deadlines and locks, events after calls, missing zero checks on owner setters. Reviewed, none actionable |

## 8. Tests and coverage

`forge test`: 269 tests across 30 suites, all passing, including fuzz (512 runs) and invariant (128 runs × depth 64) suites. Full numbers are in [`coverage-package-1.txt`](coverage-package-1.txt). For this package:

| | Lines | Branches |
| --- | ---: | ---: |
| Markets (DAMM, DLMM, router, libraries) | 96% to 100% per contract | 47% (router) to 100% |
| Launch (factory, templates, curve, migrator, escrow) | 87% to 100% | 48% (escrow) to 75% |
| Launchpads (registry, splitter) | 96% to 100% | 93% to 100% |
| Shared and governance | 87% to 100% | 50% to 100% |

Branch coverage counts each side of every compound check separately, so it runs below line coverage. The lowest (router, escrow, DLMM pair) are the areas to extend first during the audit.

## 9. Where to look hardest

1. **DLMM swap loop** (`DlmmPair._executeSwap`, `_simulate`): bin crossing, per-bin fee accrual, the active-bin composition rule, and the 128-crossing cap.
2. **Virtual reserve derivation** (`LaunchTemplateRegistry._build` and `_simulate`) and the partial fill at the threshold (`BondingCurve.quoteBuy`): the curve's last price must equal the pool's opening price.
3. **Graduation** (`GraduationMigrator`): can anyone grief or skew it, for example by donating to the pool address before it exists, or by trading in the same block?
4. **DAMM dynamic fee** (`DammPool._feeFromVolatility`, `_deviationBps`): bounded, cannot be pushed to zero or used to grief LPs.
5. **LpEscrow fee accounting** while locks are created and claimed at different times.
6. **Fee splitting** in `BondingCurve._bookFee` and `FeeSplitter.distribute`: rounding, and whether an operator can take more than its share.
7. **BuybackBurner impact formula**: whether the cap holds for both token orders and with the dynamic fee.
