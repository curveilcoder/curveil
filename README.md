# Curveil

**Open markets. Private participation.**

Curveil is a liquidity, trading and token-launch protocol on Robinhood Chain. Every market is public and on chain. A shielded vault lets people use those same markets without linking what they own to the wallet that funded it.

This repository is the source of the Curveil MVP: smart contracts, zero-knowledge circuits, the public API, the backend workers, the SDK and the website. It is published for transparency and for developers who build on Curveil. It is not packaged for anyone else to run their own Curveil.

> **Status:** live on Robinhood Chain mainnet (chain ID 4663) since November 2026. The contracts have **not** been independently audited. Vault deposits are capped. Start small.

| | |
| --- | --- |
| Website | https://curveil.xyz |
| Public API | https://api.curveil.xyz/v1 |
| API reference (OpenAPI 3) | https://api.curveil.xyz/v1/openapi.json |
| Vault broadcaster | https://broadcaster.curveil.xyz/v1/broadcast/info |
| Explorer | https://robinhoodchain.blockscout.com |
| $CURVEIL | `0xb9fd927f8EBdC35A83274324B138a242A8b37674` |
| X | https://x.com/Curveil_app |

---

## What the MVP includes

### 1. Markets

Two kinds of permissionless pools, one router.

- **DAMM pools** (`DammFactory`, `DammPool`). Constant-product pools with a dynamic fee that rises with volatility, from a base fee up to a ceiling. One pool per pair. Two tiers: 0.30% → 1.00% and 1.00% → 3.00%. LP shares are ERC-20 tokens, and the first mint locks 1,000 units forever.
- **DLMM pairs** (`DlmmFactory`, `DlmmPair`). Concentrated liquidity in discrete price bins. The price of bin `id` is `(1 + binStep / 10,000)^(id − 2^23)`. Bin steps 10, 25 and 100 carry base fees of 0.20%, 0.30% and 0.80%. Bins above the active bin hold only the base token, and bins below hold only the quote token. One call touches at most 101 bins, and one swap crosses at most 128.
- **CurveilRouter**. Multi-hop exact-in swaps across both pool types, and add and remove liquidity with slippage and deadline checks. The router takes no fee.
- **Admission** (`AssetRegistry`, `AdmissionController`). Only admitted tokens can be used in pools, vault deposits and perps collateral. Suspending a token blocks new risk in it but never blocks exits.

Liquidity providers get 80% of pool fees and the protocol gets 20%.

### 2. Launches

- A creator picks a reviewed template from `LaunchTemplateRegistry`. `LaunchFactory` then deploys a fixed-supply `CurveilLaunchToken` and its `BondingCurve`. Supply, curve shape, fees, graduation threshold and lock periods are fixed before the first trade.
- Curve trades pay 1.00%: half to the creator and half to the protocol, with part of the protocol's half going to the launchpad that hosted the launch.
- When net reserves reach the threshold, `GraduationMigrator` seeds a DAMM pool. The LP shares go to `LpEscrow`: 20% for the creator, locked 180 days, and 80% for the protocol, locked 365 days. Escrowed LP can still claim its fees. Nobody can unlock it early.

### 3. Launchpads (developer platform)

- Anyone can register a branded launchpad in `LaunchpadRegistry` with one transaction. Each launchpad is a `FeeSplitter` clone whose address is the launchpad's operator id.
- The operator chooses which templates it offers, its share of the protocol's curve fees (up to a protocol cap) and its fee recipients. It cannot change a live launch's rules, touch curve reserves, skip graduation or the escrow, or pay out more than was collected.
- `apps/launchpad-example` is a complete branded launchpad built only on `@curveil/sdk`.

### 4. Shielded vault

A UTXO-style note pool for privacy. Public deposits and withdrawals; everything in between is private.

- `ShieldedPool` keeps a Poseidon Merkle tree of note commitments (24 levels, the last 100 roots accepted) and a set of spent nullifiers. Notes carry an asset, an amount and an owner key. Each note is encrypted to its owner as a 129-byte ciphertext that only the owner's viewing key can read.
- Spends are Groth16 proofs (BN254) from two Circom circuits, `transfer` and `withdraw`, checked by `TransferVerifier` and `WithdrawVerifier`. Each proof fixes its own recipients, amounts, fee and deadline, so whoever submits it cannot change them.
- **Shielded execution**: adapters let a proof spend notes directly into a market action, with the outputs coming back as new notes:
  - `ShieldedSwapAdapter`: swaps.
  - `ShieldedLiquidityAdapter`: liquidity. The positions are held for the note owner by `PositionHolder` clones.
  - `ShieldedPerpsAdapter`: perps.
- **Broadcaster**: an optional relayer (`apps/broadcaster`) that pays gas and submits a proof-bound transaction, so the user's wallet never appears as the sender. Its fee is written into the proof. Users can always submit from their own wallet instead.
- **Keys** are derived in the browser from a recovery phrase (`packages/vault-core`) and never leave it. `docs/vault-alternative-client.md` describes a standalone client that recovers and withdraws funds with only the recovery phrase and an RPC endpoint, without any Curveil server.
- **Proving keys** come from a multi-party ceremony: two Curveil contributors, then a public random beacon. The transcripts and hashes are in `packages/circuits/artifacts/mainnet` and are also pinned in the manifest.

What stays public: the depositing address, asset, amount and time of deposits and withdrawals, plus pool execution and timing. What stays private: which deposit funds which later action, who owns the outputs, and private transfer amounts and recipients.

### 5. Perpetuals

- Isolated-margin perps settled in USDG: **ETH-USD and BTC-USD up to 5×, SOL-USD up to 2×**. Maintenance margin is 2%. Open and close fees are 0.08% of size each, and the liquidation fee is 0.50%.
- **Prices come from Pyth.** `PythReportVerifier` checks pull updates from Pyth Hermes against Pyth's contract on Robinhood Chain, and `OracleAdapter` serves them to the engine. A request fills at the first Pyth price published after it, so nobody can trade against a known stale price.
- `OrderManager` queues requests (market, limit, take-profit and stop-loss). `PerpEngine` holds positions, margin and hourly funding. `PerpLens` provides read views.
- `PerpLiquidityVault` is the counterparty to every trade. Liquidity providers deposit USDG for vault shares and earn trading fees and trader losses. Redemptions have a one-day lock.
- `apps/keeper` executes queued requests, fills orders, liquidates, and records prices and funding. Anyone can do the same on chain.

### 6. Governance and treasury

- Every admin role belongs to `CurveilTimelock`, which has a 72-hour delay. The timelock is controlled by a 3-of-3 Safe (`0x2968bFEB9273411Bd2A8cF6996F19d5aeCc01E4C`). The Safe is also the guardian that can pause new risk at once.
- Pauses never stop exits. A spend pause on the vault lasts at most 72 hours and cannot restart within 24 hours of ending.
- Each module (markets, launch, factory, vault, perps) collects fees into its own `ProtocolTreasury`. Money leaves a treasury only through a timelock operation. `BuybackBurner` buys $CURVEIL with USDG in disclosed tranches, with a cap on price impact, and sends what it buys to the burn address.

---

## Architecture

```
                        ┌──────────────────────────── Robinhood Chain (4663) ────────────────────────────┐
  Browser               │ Markets      Launch            Factory          Vault               Perps      │
  (apps/web)  ──wallet──▶ DammFactory  LaunchFactory     LaunchpadRegistry ShieldedPool       PerpEngine  │
     │                  │ DlmmFactory  BondingCurve      FeeSplitter       Transfer/Withdraw  OrderManager│
     │                  │ CurveilRouter GraduationMigrator                 Verifiers          OracleAdapter│
     │                  │ AdmissionController LpEscrow                      Swap/Liquidity/    PerpLiquidity│
     │                  │                                                   Perps adapters     Vault        │
     │                  │                 CurveilTimelock ◀── Safe (3/3)    ProtocolTreasury × 5             │
     │                  └───────────▲───────────────────────────▲───────────────────────▲──────────────────┘
     │ REST                         │ logs (indexer)            │ proof-bound txs       │ fills, liquidations
     ▼                              │                           │                       │
  apps/api  (Hono, Cloudflare Workers + D1 + KV) ── queue ──▶ apps/webhooks (signed delivery)
  apps/broadcaster (Worker + Durable Object nonce manager) ─────┘                       │
  apps/keeper (Worker + Durable Object alarm loop, Pyth Hermes) ────────────────────────┘
```

- **One source of truth for addresses.** Contract code holds no addresses. Network settings live in `packages/contracts/config/<network>.json`. Deployed addresses, ABIs, admitted assets, circuit hashes and governance settings are generated into `packages/manifest/manifests/<network>.json`. The website, API, SDK, broadcaster and keeper all read that manifest, and the API serves it at `/v1/manifest/:network`.
- **The chain is the database.** The API indexes contract logs into D1 and can rebuild everything from the chain, except developer accounts (API keys, sessions, webhooks and launchpad profiles). Market data uses finalized blocks.
- **No custody off chain.** Funds sit only in contracts. The broadcaster and keeper hold gas money only, and neither can change what a user signed or proved.

### Repository layout

| Path | Contents |
| --- | --- |
| `packages/contracts` | Foundry project: Solidity 0.8 contracts, unit, fuzz and fork tests, deploy scripts, per-network config and deploy records (`broadcast/`) |
| `packages/circuits` | Circom circuits (`transfer`, `withdraw`), the ceremony tooling, proving keys, verification keys and transcripts |
| `packages/vault-core` | Vault client library: key derivation, shielded addresses, notes, encryption, Merkle tree, proof inputs |
| `packages/manifest` | Manifest schema (zod), loader, builder and the generated `testnet.json` and `mainnet.json` |
| `packages/sdk` | `@curveil/sdk`: typed API client, transaction builders, webhook verification ([README](packages/sdk/README.md)) |
| `apps/api` | Public `/v1` API and chain indexer: Hono on Cloudflare Workers with D1, KV and a Durable Object |
| `apps/broadcaster` | Vault broadcaster: validates proof-bound transactions, pays gas, keeps no request logs |
| `apps/keeper` | Perps keeper: Pyth updates, request execution, order fills, liquidations, funding and price history |
| `apps/webhooks` | Webhook delivery: a Queues consumer that signs each delivery, retries with backoff for 24 hours, then dead-letters it |
| `apps/web` | Website: React 19, TypeScript, Vite, TanStack Router and Query, wagmi and viem, Reown AppKit; in-browser proving in a Web Worker |
| `apps/launchpad-example` | Example branded launchpad built only on `@curveil/sdk` |
| `docs` | Specifications, runbooks, ceremony record and internal review packages |

---

## Mainnet contracts

Robinhood Chain mainnet, chain ID 4663. Manifest version `0.7.0-mainnet.9`. Source is verified on the explorer.

| Module | Contract | Address |
| --- | --- | --- |
| Shared | AssetRegistry | `0x86a041EAF91a003d525A921Fda1f2C74B0733F4c` |
| Shared | AdmissionController | `0xd21400C92c47Fe7CbDEAF01Ef328127AB1Cd57cA` |
| Markets | DammFactory | `0x27464A5b14496ccC8b528bD7506f626ADCd683F0` |
| Markets | DlmmFactory | `0x7825D34c63a411A72c6cCA218d8CB51F3b8207f7` |
| Markets | CurveilRouter | `0xc6297DB8038b2c6DE1E17864785BC25654F466A7` |
| Launch | LaunchTemplateRegistry | `0x390a478c762994D792C15403c20D975Fe0a29788` |
| Launch | LaunchFactory | `0x36666329570041Eb00B00D309b0FB5F13710a7FF` |
| Launch | GraduationMigrator | `0x727566a005a1D21b7498a90323481b01c68daB1E` |
| Launch | LpEscrow | `0x5A8f89Db185EbB135823c61C173B7Ee264f3F5d3` |
| Factory | LaunchpadRegistry | `0xd0df826B89C5eFBd316BFbD7B3f535D5ec922963` |
| Factory | FeeSplitter (implementation) | `0xbD2248B49344D581ad5a1B3F1DD938F384343780` |
| Vault | ShieldedPool | `0x171ff5050a6C12476c495FbE4B65Bdf25cFa0696` |
| Vault | TransferVerifier | `0x33BC2680fD34eEC322Eb0AB75EdA6cA8BBf6545F` |
| Vault | WithdrawVerifier | `0x2AaDa901E8Bffc256f400f45434b725b8B342D25` |
| Vault | ShieldedSwapAdapter | `0x91F697B8EECd71D4305bEe94D8116169DD64CA4c` |
| Vault | ShieldedLiquidityAdapter | `0xCBeBd0cA3Afb1F7F9447DeFC74Dfd6CC4572df4B` |
| Vault | ShieldedPerpsAdapter | `0xd36861A5ec8f0C1be1E30e05b1312C295F2a2EEC` |
| Vault | PositionHolder (implementation) | `0x55dB91AB169b09Bb06d4F32ceE16f7EeE48629A5` |
| Vault | ShieldedPoolV1 (previous pool, withdrawals only) | `0xE5250D39A7fB371EAF2E75a0fFDE191A696F3e03` |
| Vault | PoseidonT3 / PoseidonT5 | `0x7bd63041A4a5Ae46E3c6ad1d5edF89A3937BCDF1` / `0x00c19c8240604216f22240B36BF689980fc83C1B` |
| Perps | PerpEngine | `0x4653297459629D3Bf7f8f147cC1dc4F48F8BC5Cb` |
| Perps | OrderManager | `0x57CC5EbfB82ba6653f8dBa6585353F06F06caE37` |
| Perps | PerpLiquidityVault | `0x451290E247438bda2eFDFC224669f38d8207FfA8` |
| Perps | OracleAdapter | `0x91C7ec40F772ee22DbBb6D6bb10805A5b95089Bb` |
| Perps | PythReportVerifier | `0x07Fb095DaE9406A3fC73889DB709e465f35f6201` |
| Perps | PerpLens | `0x5c097EbEfFBECcD0eff973147420A1bA244644B3` |
| Governance | CurveilTimelock (72 h) | `0xC865861EdBfb4A36d69F0D5110b23ce91A2619c2` |
| Governance | BuybackBurner | `0xB506Ac9c233361b8a1c6c2Cf0cA2028530FCeC35` |
| Treasury | TreasuryMarkets | `0x1de63CC8C4bb66282f050c663dD2251F92993Efd` |
| Treasury | TreasuryLaunch | `0x59300c81078a4Cd1199E35E4F56224516d8a6c71` |
| Treasury | TreasuryFactory | `0x76eE5dab43D28b8C06689B309A6ece4bF559F61F` |
| Treasury | TreasuryVault | `0xE469B520e712339c825A8d3BA6Aa74ca7690b34f` |
| Treasury | TreasuryPerps | `0x30165FE555aBD57509116B80F707769889Cde212` |

Admitted assets: USDG, WETH, PONS, CASHCAT, AI, ORBIO, STONKBROKER, HOOKR and PRIORS. The manifest has each token's address and decimals.

The full list, with ABIs, deploy transactions and blocks, is in [`packages/manifest/manifests/mainnet.json`](packages/manifest/manifests/mainnet.json). Testnet (chain ID 46630) is in [`testnet.json`](packages/manifest/manifests/testnet.json).

### Fees

| Action | Fee | Goes to |
| --- | --- | --- |
| DAMM swap | 0.30% base, up to 1.00% (or 1.00% → 3.00% tier) | 80% LPs, 20% protocol |
| DLMM swap | 0.20%, 0.30% or 0.80% base by bin step, plus a variable part | 80% LPs, 20% protocol |
| Router | 0% | — |
| Bonding-curve trade | 1.00% | 50% creator, 50% protocol (part to the launchpad) |
| Shielding, private transfer | 0% (a broadcaster may charge for gas) | — |
| Vault withdrawal | 0.10% | Protocol |
| Shielded swap or liquidity | The pool's own fee | As the pool |
| Perps open or close | 0.08% of size | Liquidity vault, with a share to the protocol |
| Broadcaster | 0.05 USDG or 0.00002 WETH per transfer or withdrawal, ×3 for an execution | Broadcaster (for gas) |

---

## Public API

Base URL: `https://api.curveil.xyz/v1`. JSON over HTTPS, read-mostly, indexed from the chain. The machine-readable description is at [`/v1/openapi.json`](https://api.curveil.xyz/v1/openapi.json) (OpenAPI 3).

- **Rate limits:** 300 requests a minute per IP without a key, and 3,000 a minute with an API key. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Tier` and `Retry-After` when limited.
- **Authentication:** reads are open. Developer endpoints need either a session token (`cvs_…`, valid 7 days), obtained with Sign-In with Ethereum, or an API key (`cvk_…`). Send either one as `Authorization: Bearer <token>`. An API key can also go in `X-API-Key`.
- **Errors** are JSON `{ "error": "<code>", "message": "<plain-language reason>" }` with a matching HTTP status. Every response names its network in `X-Curveil-Network`.
- **Amounts** are decimal strings in base units. Addresses are checksummed.

| Area | Endpoints |
| --- | --- |
| Status | `GET /status` (chain head, indexer lag, module health) · `GET /indexer` · `GET /manifest/:network` · `GET /assets` · `GET /governance` (timelock queue, treasuries, releases) |
| Markets | `GET /markets` (DAMM pools and DLMM pairs with price, TVL, volume and fees; filters and sorting) · `GET /markets/:pool` (detail, DLMM bins) · `GET /markets/:pool/swaps` |
| Accounts | `GET /accounts/:address/positions` · `GET /accounts/:address/activity` · `GET /escrow/:owner` |
| Launches | `GET /launches` · `GET /launches/:token` · `GET /launches/:token/trades` · `GET /launches/templates` · `POST /launches/metadata` · `GET /launches/metadata/:hash` · `GET /launches/metadata/:hash/image` |
| Launchpads | `GET /factory` · `GET /operators` · `GET /operators/:id` · `GET /operators/by-domain/:domain` · `GET /operators/:id/revenue` · `POST /operators` (profile) · `POST /operators/:id/domain/verify` |
| Vault | `GET /vault/status` · `GET /vault/roots` · `GET /vault/commitments` (encrypted notes for client-side scanning) · `GET /vault/nullifiers` · `GET /vault/positions` · `GET /vault/activity` |
| Perps | `GET /perps/markets` · `GET /perps/markets/:id/candles` · `/prices` · `/funding` · `/activity` · `GET /perps/prices` · `GET /perps/positions/:owner` · `GET /perps/position/:id` · `GET /perps/orders/:owner` · `GET /perps/vault/:account` · `GET /perps/claims` |
| Developer accounts | `POST /auth/nonce` · `POST /auth/verify` · `GET /auth/session` · `POST /auth/logout` · `GET/POST /keys` · `DELETE /keys/:id` |
| Webhooks | `GET /webhooks/events` · `GET/POST /webhooks` · `GET/PATCH/DELETE /webhooks/:id` · `GET /webhooks/:id/deliveries` · `POST /webhooks/:id/test` · `/replay` · `/rotate-secret` |
| Ceremony | `POST /ceremony/contributions` |

### Webhooks

Subscribe a URL to one or more events (up to 10 subscriptions per account, each optionally filtered to a list of up to 50 addresses):

`swap` · `liquidity.changed` · `launch.created` · `launch.progress` · `launch.graduated` · `escrow.unlocked` · `perps.liquidation` · `operator.fee_paid`

Each delivery is a `POST` with a JSON body and the header `Curveil-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, keyed with the subscription's signing secret. Check it with `verifyWebhook` from `@curveil/sdk`, and reject timestamps older than a few minutes. A failed delivery is retried with backoff for 24 hours, then dead-lettered, and can be replayed from the API.

### Broadcaster API

Base URL: `https://broadcaster.curveil.xyz`.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/broadcast/info` | Network, pool, broadcaster address, gas balance, health, fee per asset, fee multipliers per action, accepted adapters, disclosure |
| `POST /v1/broadcast/quote` | `{ action: "transfer" \| "withdraw" \| "execute", token }` → the fee and fee recipient to bind into the proof, valid 10 minutes |
| `POST /v1/broadcast/submit` | `{ action, proof, args }` → a request id. The broadcaster checks the proof's fee, recipient and deadline before paying gas |
| `GET /v1/broadcast/:id` | `submitted`, `confirmed`, `failed` or `dropped`, with the transaction hash |

Submissions are rate limited per connection. The broadcaster sees request timing and network address. It does not log or keep them, and it cannot change recipients, amounts or fees.

---

## SDK

`@curveil/sdk` (TypeScript) works in browsers, Workers, Deno, Bun and Node 18+. Its only peer dependency is `viem`.

- `createClient({ network: "mainnet" | "testnet", apiKey? })`: a typed client for every read endpoint above. Errors throw `CurveilApiError`.
- Transaction builders that return plain `{ to, data, value }`:
  - Launches: `createLaunchTx`, `buyTx`, `sellTx`, with `quoteBuy`, `quoteSell` and `withSlippage`.
  - Launchpads: `registerOperatorTx`, `setBrandTx`, `setShareTx`, `setTemplatesTx`, `setActiveTx`, `setRecipientsTx`, `transferAdminTx`, `acceptAdminTx`, `collectTx`, `distributeTx`, `releaseTx`.
  - Swaps and approvals: `swapExactInTx`, `approveTx`.
- Helpers: `encodeBrandURI`, `predictOperator`, `siweMessage`, `verifyWebhook` and `verifyWebhookRequest`, plus the contract ABIs and chain definitions.

See [`packages/sdk/README.md`](packages/sdk/README.md) for examples.

---

## Security model and risks

- **Unaudited.** The contracts, circuits and workers have had internal review only (`docs/audit/`). Vault deposits are capped at 1,000 USDG and 0.5 WETH per deposit, and only assets the owner has enabled for shielding can be deposited.
- **Admin power is slow and visible.** Every admin change waits 72 hours in the timelock and shows on the site's Transparency page. The Safe can cancel a queued change, or pause new risk at once, but it cannot move user funds or block exits.
- **Privacy has limits.** Shielding hides links, not activity. A deposit and a withdrawal close in size and time can be linked. Losing both the recovery phrase and the backup means losing the funds.
- **Oracle and liquidity risk in perps.** Positions depend on Pyth prices and on the liquidity vault being able to pay profits. Profit per position is capped.
- **Launches are permissionless.** A template constrains the mechanics, not the quality of a token.

Specifications:

- [`docs/vault-spec.md`](docs/vault-spec.md): vault construction, note format, circuits and threat model.
- [`docs/vault-alternative-client.md`](docs/vault-alternative-client.md): recovering funds without Curveil.
- [`docs/perps-spec.md`](docs/perps-spec.md): margin, funding, liquidation and oracle rules.
- [`docs/factory-spec.md`](docs/factory-spec.md): launchpads, fees, API, webhooks and SDK.
- [`docs/ceremony.md`](docs/ceremony.md): the mainnet trusted setup.
- [`docs/runbooks.md`](docs/runbooks.md): incident and admin procedures.

---

## Licence

No licence has been chosen yet. Files are marked `UNLICENSED`. The exception is `packages/circuits` and the generated Solidity verifiers, which build on GPL-3.0 code (circomlib and the snarkjs verifier template) and carry GPL-3.0 headers.

Curveil runs on Robinhood Chain but is not affiliated with or endorsed by Robinhood.
