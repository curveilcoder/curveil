# Factory and developer platform (Phase 6)

Branded launchpads on Curveil's launch contracts, and the API, SDK and webhooks third parties build them with. Testnet only; the contracts are unaudited.

## 1. What a launchpad is

A launchpad ("operator") is a brand plus a fee share on top of the same launch contracts every Curveil launch uses. An operator never deploys or controls launch logic: templates, curves, graduation and LP escrow stay protocol contracts. What the operator chooses:

| Setting | Where it lives | Who can change it | Effect |
| --- | --- | --- | --- |
| Slug (name in links and the API) | `LaunchpadRegistry`, permanent | Nobody | 3 to 32 characters, `a-z 0-9 -`, not starting or ending with `-` |
| Brand (name, tagline, accent, website, logo) | Registry, `brandURI` (inline JSON or a URI, at most 2,048 bytes) | Admin | Display only |
| Templates | Registry, 64-bit mask | Admin | Which templates launches on this pad may use; new launches only |
| Share | Registry, basis points | Admin, capped by `maxShareBps` (protocol owner, 5,000 on testnet) | Fixed into each launch when it is created |
| Active | Registry | Admin | Paused pads refuse new launches |
| Suspended | Registry | Protocol owner (timelock), or the guardian (Safe) at once; only the owner lifts it | Same as paused, but the admin cannot undo it |
| Recipients (1 to 8, weights adding up to 10,000) | `FeeSplitter` | Admin, through the registry | Applies to fees that arrive afterwards |
| Admin | Registry, two-step (`transferAdmin`, `acceptAdmin`) | Admin, then the new admin | |
| Custom domain, description, contact | Curveil API (`operator_profiles`), not on chain | Admin, signed in | Domain needs a DNS TXT record before it is served |

The operator's address is a `FeeSplitter` clone created by `register` with `Clones.cloneDeterministic(salt = keccak256(slug))`, so `predictOperator(slug)` gives it before registration. That address is what launches record as `operator`.

The Curveil app has no setup page. Operators register and manage a launchpad by sending these registry and splitter transactions themselves, usually through the SDK helpers (`registerOperatorTx`, `setBrandTx`, `collectTx` and the rest). The "Run a launchpad" page of the docs (`/docs?page=launchpad-guide`) walks through it, and `apps/launchpad-example` is the reference frontend. The old `/factory` path redirects to that guide.

## 2. Fees

A curve fee is split in `BondingCurve._bookFee`:

```
creator  = fee × creatorFeeShareBps / 10,000          (template)
rest     = fee − creator
operator = rest × operatorShareBps / 10,000            (fixed in the curve at creation; 0 without an operator)
protocol = rest − operator
```

`operatorShareBps` comes from `LaunchpadRegistry.operatorTerms(operator, templateId)` at `createLaunch`, which returns `min(shareBps, maxShareBps)` and refuses (error `OperatorNotAllowed`) a pad that is unknown, paused, suspended or does not offer the template. The share is an immutable of the curve, so no later setting changes an existing launch. Example on Standard v1 (1% fee, 50% creator) with a 35% share: 0.50% creator, 0.175% operator, 0.325% protocol.

Operator fees accrue in the curve's operator bucket. `FeeSplitter.collect(curves, token)` claims the bucket of each curve that names this splitter and allocates everything that arrived (`distribute`); `release(token, recipient)` pays one recipient. Anyone may call all three; money only moves to the recipients. `setRecipients` allocates the listed tokens to the old recipients before switching, so already-arrived fees stay with them.

## 3. API

All under `/v1`. Reads are public. The full contract is `GET /v1/openapi.json` (OpenAPI 3.1), rendered at `/docs?page=api`.

| Endpoint | Auth | |
| --- | --- | --- |
| `GET /factory` | | Registry address, cap, operator count |
| `GET /operators?admin=&limit=` | | Indexed launchpads with brand, share, effective share, recipients, launches, volume |
| `GET /operators/:id` | | By address or slug, with `domainSetup` (TXT record to add) |
| `GET /operators/by-domain/:domain` | | The pad serving a verified domain |
| `GET /operators/:id/revenue` | | Live per token: earned, still in curves, pending, unpaid, distributed, per recipient owed and released; curves with uncollected fees; daily estimate; history |
| `POST /operators` | session, admin only | Domain, description, contact (partial update) |
| `POST /operators/:id/domain/verify` | session | Looks up `_curveil.<domain>` TXT = `curveil-operator=<address>` over DNS-over-HTTPS |
| `GET /launches?operator=` | | Launches on one pad |
| `POST /auth/nonce`, `POST /auth/verify`, `GET /auth/session`, `POST /auth/logout` | | Sign-In with Ethereum (EIP-4361) |
| `GET /keys`, `POST /keys`, `DELETE /keys/:id` | session | API keys |
| `GET /webhooks/events`, `GET/POST /webhooks`, `GET/PATCH/DELETE /webhooks/:id`, `POST /webhooks/:id/rotate-secret`, `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries`, `POST /webhooks/:id/replay` | key or session | Webhooks |

**Sign-in.** The nonce is single use and valid 10 minutes; the message's domain must be one of the API's allowed origins and its chain id the network's. A session token (`cvs_…`) lasts 7 days. Session tokens and API keys (`cvk_test_…`, `cvk_live_…`) are stored only as SHA-256 hashes. A key is shown once, up to 5 per wallet, and cannot create keys.

**Limits.** 300 requests a minute per IP without credentials, 3,000 per key (Workers rate-limit bindings). Responses carry `X-RateLimit-Limit` and `X-RateLimit-Tier`. CORS echoes allowed origins and answers `*` otherwise; credentials are bearer tokens, never cookies.

## 4. Indexing

The indexer (generation 6, code `factory-1`) adds the registry and every splitter to its log filter: `OperatorRegistered`, brand/share/templates/active/suspended/admin events, `Distributed`, `Released`, and `RecipientsSet`. New launches and launches indexed before the registry existed get their `operator` and `operator_share_bps` read from the curve. Rewinds after a reorg delete operator rows, events and distributions above the common ancestor and re-read operator state.

## 5. Webhooks

| Event | When |
| --- | --- |
| `swap` | Swap on a DAMM pool or DLMM pair, or a curve trade |
| `liquidity.changed` | Add, remove, fee claim or position transfer |
| `launch.created` | New launch, with its operator |
| `launch.progress` | A launch's reserve crossed the next 10% step |
| `launch.graduated` | Graduated into DAMM, LP escrowed |
| `escrow.unlocked` | An escrow lock reached its unlock time |
| `perps.liquidation` | A position was liquidated |
| `operator.fee_paid` | A splitter paid a recipient |

**Ids.** `evt_` + the first 32 hex of `keccak256(type:txHash:logIndex)` (`escrow.unlocked` uses the lock id), the same on every retry and replay. A delivery is one subscription and one event: `dlv_` + `keccak256(subscription:event)`, inserted with `INSERT OR IGNORE`, so re-indexing never sends an event twice.

**Signing.** `Curveil-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, plus `Curveil-Event-Id`, `Curveil-Event-Type`, `Curveil-Delivery-Id`, `Curveil-Timestamp`. Receivers should reject timestamps more than 5 minutes off. Secrets (`whsec_…`) are shown once, stored AES-GCM encrypted under `WEBHOOK_MASTER_KEY` (a Worker secret) with the subscription id as associated data.

**Delivery.** The indexer writes deliveries and sends `{delivery, attempt}` to the `curveil-webhooks-<network>` queue. The `curveil-webhooks` consumer POSTs with a 10 second timeout and no redirects; 2xx is delivered. Otherwise it schedules the next attempt by sending the message to its own queue with a delay of `min(max(30 s, time since the window started), 12 h, time left)`: 30 s, 30 s, 1 min, 2 min, … for 24 hours. Then the delivery is dead and also sent to `curveil-webhooks-dlq-<network>`. Updates are guarded by the attempt counter, so duplicate queue messages are dropped. Every 50 indexer ticks a sweep re-sends deliveries whose queue message was lost (pending more than 5 minutes past due, or failed more than 15). Replay (by id, or all dead or failed) resets the 24-hour window. Attempts are kept 30 days.

Events are sent once the sequencer includes them, before L1 finality (`"finality": "sequencer"`). A reorg can therefore produce an event for a transaction that later disappears; receivers that move money should wait for finality themselves.

## 6. SDK

`packages/sdk` (`@curveil/sdk`, MIT): `CurveilClient` for every endpoint above, transaction builders returning `{ to, data, value }` (`registerOperatorTx`, `set*Tx`, `collectTx`, `releaseTx`, `createLaunchTx`, `buyTx`, `sellTx`, `swapExactInTx`, `approveTx`), read helpers (`predictOperator`, `quoteBuy`, `quoteSell`), `encodeBrandURI`, `templateMask`, and `verifyWebhook` / `verifyWebhookRequest`. Fetch and Web Crypto only; `viem` is the peer dependency. Until it is published to npm, the website serves the packed build at `/sdk/curveil-sdk-<version>.tgz` (built by `apps/web/scripts/pack-sdk.mjs`).

## 7. Example launchpad

`apps/launchpad-example` is a third-party launchpad built only on the SDK and viem, deployed as its own Worker: it loads the pad by verified domain or configured slug, applies the brand, lists the pad's launches, creates tokens on it, trades on curves, and its Worker verifies Curveil webhooks (`POST /webhooks`, secret `WEBHOOK_SECRET`) and keeps the last 25 events in KV for the page. It proves FR-27: everything an operator needs is in the public API and SDK.

## 8. Before mainnet

- Audit `LaunchpadRegistry`, `FeeSplitter` and the operator path in `LaunchFactory` and `BondingCurve`.
- Decide `maxShareBps` for mainnet and who holds the registry owner role (cap and suspension).
- Publish `@curveil/sdk` to npm under the project's account.
- Set `ALLOWED_ORIGINS` for mainnet sign-in, rotate `WEBHOOK_MASTER_KEY` for mainnet, and use `cvk_live_` keys.
- Consider moving webhook delivery to L1-final for money-moving events, or add a separate finalized event type.
