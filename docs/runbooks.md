# Curveil runbooks

What to do when something goes wrong, and how routine operations are done. Every step names the exact call or command. On mainnet, "the Safe" is the 3-of-3 Safe and "the timelock" is the CurveilTimelock it controls (72 hours).

## 1. Alerts

Alerts arrive in the alert channel from the keeper (see `docs/perps-spec.md` section 10). Each one repeats hourly while it lasts and posts "resolved" when it clears.

| Alert | What it means | Do this |
| --- | --- | --- |
| Keeper gas is low | The keeper wallet is below its minimum. Below zero it stops filling requests and liquidating. | Send ETH on Robinhood Chain to the keeper address shown in `GET /v1/status` on the keeper. About 0.005 ETH lasts weeks at today's gas price. |
| Keeper passes are failing | Three or more passes in a row errored. Usually the RPC (rate limit or outage). | Read `lastError` in the keeper status. If it is the RPC, switch `RPC_URL` to the backup endpoint and redeploy the keeper. Anyone can still execute and liquidate directly on the contracts meanwhile. |
| Not enough price sources (testnet) | Fewer than two exchanges answered. The keeper cannot sign prices. | Usually clears by itself. If it lasts over 15 minutes, check which exchanges are down in the keeper status. |
| Price is stale | A market with open positions has no price newer than 15 minutes. Vault deposits and redemptions revert until it is refreshed. | Check the keeper is running and the oracle is publishing. Anyone can refresh by submitting a report to `OracleAdapter`. |
| Broadcaster needs attention | The vault broadcaster is down or out of gas. Users can still submit from their own wallet. | Top up the broadcaster address in `GET /v1/broadcast/info`, or check its Worker logs. |
| Admin change queued in the timelock | Someone with the Safe queued an admin call. It can execute after the delay. | Confirm it is expected and announced. If not, the Safe cancels it at once: `timelock.cancel(id)`. Treat an unexpected one as a key compromise (section 4). |

## 2. Emergency pauses

The guardian (the Safe) acts at once; undoing a pause goes through the timelock. No pause stops anyone from exiting.

| Situation | Call (from the Safe) | Effect |
| --- | --- | --- |
| A launch-related bug | `LaunchFactory.setCreationPaused(true)` | No new launches. Live launches keep trading, and graduation and claims continue. |
| An abusive launchpad | `LaunchpadRegistry.setSuspended(operator, true)` | No new launches on that pad. Its existing launches are untouched. |
| A compromised or broken asset | `AdmissionController.suspend(token)` | No new pools, vault deposits or perps collateral in it. Exits continue. |
| A vault bug, deposits | `ShieldedPool.pause(true, false)` | No new deposits until the owner lifts it. |
| A vault bug, spending | `ShieldedPool.pause(false, true)` | Stops transfers, withdrawals and executions for at most 72 hours. Cannot be extended or restarted within 24 hours of ending. Use only for a confirmed exploit in progress. |
| A perps bug or bad prices | `PerpEngine.setMarketEnabled(market, false)` | No new positions. Closes and liquidations continue. |

Then: post a short public notice (what is paused, why, what users should do, which is usually nothing), and schedule the fix and the unpause through the timelock.

## 3. Admin changes

1. Write the change as a Safe transaction batch that calls `timelock.schedule` or `scheduleBatch` with the target calls and the full delay.
2. Announce it publicly with the operation id. The Transparency page and the alert channel show it automatically.
3. After the delay, any Safe signer executes it with `timelock.execute` or `executeBatch` and the same arguments.

Without the Safe app (it is a paid plan on Robinhood Chain), the site's `/safe` page signs and sends the mainnet handover: each owner signs the Safe's EIP-712 message in their wallet for free, signatures can be pasted between devices, and once all are in, any wallet with a little ETH sends `execTransaction`. The two steps' calldata is in `apps/web/src/data/handover-mainnet.json`; regenerate it if the handover is rebuilt.

Paying out fees: collecting is open to anyone and can only pay the fixed recipient (`collectProtocolFees` on a pool or pair, `claimFees` on a bonding curve, `claimProtocolFees` on the vault). Fees then sit in the module's `ProtocolTreasury` until a timelock operation calls `release(token, to, amount, memo)`. The protocol's LP locks are claimed the same way, by a timelock operation calling `LpEscrow.claim` or `claimFees` with a treasury as `to`. The Transparency page lists every treasury balance and release.

Ownership handover after a deploy: `pnpm --filter @curveil/manifest handover` with `NETWORK=mainnet` writes `deployments/mainnet.handover.json`, a two-transaction Safe batch (schedule now, execute after 72 hours). It lists every contract's owner, so nothing is left with the deployer.

## 4. Key compromise or loss

| Key | Do this |
| --- | --- |
| A Safe signer | The Safe is 3 of 3 by the owner's choice: every action needs all three keys, so one stolen key cannot act, but one **lost** key freezes the Safe for good (no `swapOwner`, no guardian pause, no timelock changes; the contracts keep running as they are). So each signer keeps a tested offline backup of their seed, and a signer who suspects a compromise tells the others at once: the three swap that owner out with `swapOwner` while all three keys still work. |
| Keeper wallet | Create a new key, `printf '%s' "$KEY" \| npx wrangler secret put KEEPER_KEY --env mainnet` in `apps/keeper`, move the remaining ETH. It holds only gas. |
| Broadcaster wallet | Same, with `BROADCASTER_KEY` in `apps/broadcaster`. Proofs bind their fee recipient, so pending user proofs naming the old address must be re-made; the app does this on the next attempt. |
| Cloudflare API token | Revoke it in the Cloudflare dashboard and create a new least-privilege token. |
| `WEBHOOK_MASTER_KEY` | Webhook signing secrets are encrypted under it. Rotating it means re-issuing every webhook secret (`POST /v1/webhooks/:id/rotate-secret`), so operators must update theirs. |

## 5. Indexer and database

- **Indexer stalled** (`/v1/status` shows `stalled` or a growing `lagBlocks`): any API request restarts its loop. If `lastError` names the RPC, switch `RPC_URL` and redeploy the API. On mainnet a cron trigger also restarts it every minute.
- **Backups**: `apps/api/scripts/backup-d1.sh mainnet <private folder>` exports the database, records its sha256, restores it into a throwaway local copy and compares every table. Run it daily and keep 30 days. The file holds hashed tokens and encrypted webhook secrets: keep it private. D1's Time Travel also restores any minute of the last 30 days on the paid plan (`npx wrangler d1 time-travel restore`).
- **Database lost or corrupted**: everything except developer accounts (API keys, sessions, webhooks, launchpad profiles) is rebuilt from the chain. `apps/api/scripts/replay-check.sh` proves this: it rebuilds the index in an empty database and checks it against the live one. Restore developer tables from the latest backup.

## 6. Deploys and rollback

- Every Worker deploy prints a version id. To undo one: `npx wrangler rollback <previous version id> --env mainnet` in that app's folder.
- Contracts cannot be rolled back. A contract fix ships as a new contract through the timelock, and users move when they choose.
- Never deploy on a Friday or before a holiday, and watch the alert channel for an hour after each deploy.

## 7. Incident notes

For anything users notice: post what happened, what is affected, what users should do, and when the next update comes. Afterwards write a short blameless review (timeline, cause, fix, what changes) and publish it.

## 8. Capacity and load

`pnpm --filter @curveil/sdk load -- --base <api> --concurrency 20 --seconds 60 --max 3000` runs a mix of the website's reads and reports latency per route. `--max` caps the total so a run cannot use up the plan's daily quota; `--rate` paces it.

Rehearsal on 4 November 2026, against the API running locally on testnet data (the production host is not reachable from the build machine, so the hosted numbers will differ):

| Run | Result |
| --- | --- |
| 1,500 requests from one address, unpaced | 300 served in the first minute, the other 1,200 refused with 429: the 300-per-minute limit per address holds. No errors |
| 272 requests at 4.5 per second for 60 seconds | No errors, no 429. Database reads p50 about 30 ms, p95 under 70 ms. Routes that also ask the chain (status, vault, perps) p50 about 125 ms, p95 under 190 ms |

Before mainnet, repeat from a machine that can reach the hosted API, with an API key (3,000 per minute), at the expected launch-day peak. The Workers Paid plan removes the free plan's 100,000 requests a day.

## 9. Mainnet deploy

Everything off-chain for mainnet is created and waiting, and nothing is published:

| Resource | Name |
| --- | --- |
| Workers (not deployed) | `curveil-api-mainnet`, `curveil-keeper-mainnet`, `curveil-webhooks-mainnet`, `curveil-broadcaster-mainnet`, `curveil-web-mainnet` (the `mainnet` env in each app's `wrangler.jsonc`) |
| Database | D1 `curveil-mainnet`, all migrations applied, empty except module status: every module "Not live yet" with the reason it is waiting. Set a module live with `UPDATE module_status SET status = 'live', reason = '…' WHERE id = '…'` when its contracts are deployed |
| Config store | KV `curveil-config-mainnet` |
| Queues | `curveil-webhooks-mainnet`, `curveil-webhooks-dlq-mainnet` |
| Crons | None: the free plan's cron triggers are used up. Every request restarts the API and keeper loops. On Workers Paid, add `["* * * * *"]` to both `mainnet` envs as a backup timer |

Steps, after the audit passes and the owner says go:

1. `pnpm mainnet:check` shows no missing inputs for the module going live.
2. Deploy the contracts with the mainnet deployer, in this order: `DeployFoundation`, `DeployGovernance`, then the modules going live (`DeployMarkets`, `DeployLaunch`, `DeployFactory`; later `DeployVault` and `DeployExecution`, then `DeployPerps`). Fee addresses left at zero in `config/mainnet.json` go to the module's treasury and the protocol's LP locks to the timelock (`script/FeeRecipients.sol`), so every payout needs a Safe vote and the 72-hour delay; `pnpm mainnet:check` shows where they go. Simulate each script first (without `--broadcast`): it prints the gas, and the deployer's balance must cover it. Then write the manifest (`NETWORK=mainnet pnpm --filter @curveil/manifest build:manifest`), and hand ownership to the timelock (section 3).
3. `pnpm deploy:mainnet --dry-run` compiles every Worker against its mainnet config.
4. `CURVEIL_MAINNET_GO=yes pnpm deploy:mainnet` publishes the manifest to KV, applies migrations, then deploys the keeper, API, webhooks and the site. Add `--with-vault` once the ceremony and the ZK audit are done. `--only api,web` limits a redeploy.

RPC: the public RPC rate-limits Cloudflare's shared addresses, so mainnet uses two free keys. `RPC_URL` (from `MAINNET_RPC_URL`) is Alchemy's free plan and serves every call except log reads, which that plan caps at 10 blocks. `LOGS_RPC_URL` (from `MAINNET_LOGS_RPC_URL`, or `NODEFLARE_KEY`) is NodeFlare's free key: up to 5,000 blocks a call and about 120,000 calls a month, which is why the mainnet indexer polls every 30 seconds (`INDEXER_IDLE_MS`). Left unset at deploy, the Worker keeps the secret it has. `/v1/indexer` shows both hosts. A changed secret reaches the indexer when Cloudflare restarts its Durable Object, usually within a minute; if it does not, bump the mainnet entry of `INDEXER_GENERATION` in `apps/api/src/lib.ts`.

Launch templates on mainnet (registry `0x390a478c762994D792C15403c20D975Fe0a29788`, all enabled). `config/mainnet.json` holds only template 0, the one `DeployLaunch` adds; the others were added later with `addTemplate` from the deployer. All share Standard v1's terms (1B supply, 80% curve, 1% curve fee, half to the creator, DAMM tier 0, creator LP locked 180 days, protocol LP 365 days) and differ in quote token and graduation size:

| Id | Label | Quote | Graduates at |
| --- | --- | --- | --- |
| 0 | Standard v1 | USDG | 25,000 USDG |
| 1 | ETH v1 | WETH | 10 ETH |
| 2 | Quick ETH | WETH | 2 ETH |
| 3 | Quick USDG | USDG | 5,000 USDG |
| 4 | Big USDG | USDG | 100,000 USDG |

Templates cannot be edited, only switched off with `setEnabled`. For WETH templates the site takes and pays out ETH, wrapping and unwrapping it for the user. After the handover, adding a template is a Safe vote and the 72-hour delay.

The script refuses without `CURVEIL_MAINNET_GO=yes`, without a valid mainnet manifest with a Safe, or if any mainnet key is a testnet key. On mainnet `RPC_URL` is a Worker secret (it can carry a provider key), taken from `MAINNET_RPC_URL` or the public RPC. Keeper and broadcaster wallets that are not given are generated and stored only in Cloudflare; the script prints their addresses to fund. `WEBHOOK_MASTER_KEY` is generated once and given to both the API and the webhooks Worker.

## 10. Connecting $CURVEIL

When the token exists and has a DAMM pool against USDG with liquidity (a Curveil launch creates it at graduation):

1. `NETWORK=mainnet pnpm --filter @curveil/manifest bind-token <token address>` checks the token and its pool, writes the address into `networks.json`, and writes `deployments/mainnet.bind-token.json`.
2. Load that file in the Safe's Transaction Builder and send "schedule". The keeper posts the queued change to the alert channel and it appears on the Transparency page.
3. After 72 hours, send "execute". `BuybackBurner.bind` works once only, which is why the script checks everything first.
4. Rebuild the manifest (`NETWORK=mainnet pnpm --filter @curveil/manifest build:manifest`) and run `CURVEIL_MAINNET_GO=yes pnpm deploy:mainnet --only api,web` so the site shows the contract address.

Buybacks then run from the Safe: `BuybackBurner.buyback(usdgIn, minOut, deadline)`, refused above 1% price impact.

Rehearsed on testnet on 4 November 2026 with tCURVEIL (`0xd9588BCb99890935F086738f42aF419EFc736AA3`) and its tUSDG pool.
