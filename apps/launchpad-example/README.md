# Launchpad example

A branded launchpad frontend built only on [`@curveil/sdk`](../../packages/sdk) and viem, deployed the way an operator would deploy their own site. It uses nothing from `apps/web` and runs no indexer.

- Loads the launchpad by verified custom domain (`GET /v1/operators/by-domain/<host>`), otherwise the configured slug, and applies its brand and accent colour.
- Discloses the fee split from the pad's on-chain share and the template terms.
- Lists the pad's launches (`curveil.launches({ operator })`), creates tokens on it (`createLaunchTx` with `operator`), and buys or sells on a curve (`quoteBuy`/`quoteSell`, `buyTx`/`sellTx`, `withSlippage`), with any injected EIP-1193 wallet.
- Its Worker verifies Curveil webhooks with `verifyWebhookRequest` at `POST /webhooks`, keeps each event id once, and stores the last 25 in KV for the page's activity feed.

Testnet: https://curveil-launchpad-example-testnet.zeronym.workers.dev (serves the `sprout` launchpad).

## Run it for your launchpad

```bash
pnpm install
cd apps/launchpad-example
pnpm dev                                    # frontend only, on :8792 (VITE_LAUNCHPAD=<slug> to pick a pad)

# Worker and frontend together, with webhooks
pnpm build
npx wrangler kv namespace create curveil-launchpad-example-testnet   # put the id in wrangler.jsonc
printf '%s' "$WEBHOOK_SECRET" | npx wrangler secret put WEBHOOK_SECRET --env testnet
npx wrangler deploy --env testnet --var LAUNCHPAD:<your-slug>
```

Then add a webhook endpoint at `https://<your-site>/webhooks` on Curveil's `/docs?page=webhooks` page and use its signing secret above.
