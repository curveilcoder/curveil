# @curveil/sdk

TypeScript SDK for [Curveil](https://curveil-web-testnet.zeronym.workers.dev): a typed client for the public API, transaction builders for launches, launchpads and swaps, and webhook signature checks.

- Works in browsers, Cloudflare Workers, Deno, Bun and Node 18+ (Fetch and Web Crypto only).
- `viem` is the only peer dependency. Transactions come back as plain `{ to, data, value }`, so any wallet library can send them.
- Testnet only for now: Robinhood Chain testnet (chain id 46630). The contracts are unaudited.

## Install

The package is not on npm yet. Install the build the Curveil site serves:

```sh
npm install viem https://curveil-web-testnet.zeronym.workers.dev/sdk/curveil-sdk-0.1.0.tgz
```

Inside the Curveil repository, depend on it as `"@curveil/sdk": "workspace:*"`.

## Read data

```ts
import { createClient } from "@curveil/sdk";

const curveil = createClient({ network: "testnet" }); // apiKey: "cvk_test_…" raises the limit

const status = await curveil.status();
const { launches } = await curveil.launches({ sort: "volume", limit: 10 });
const { operator } = await curveil.operator("sprout");  // a launchpad by name or address
const revenue = await curveil.revenue(operator.address);
```

Limits: 300 requests a minute per IP without a key, 3,000 a minute per API key. Errors throw `CurveilApiError` with `status`, `code` and a plain-language `message`.

## Register a launchpad

```ts
import { encodeBrandURI, predictOperator, registerOperatorTx } from "@curveil/sdk";

const m = await curveil.manifest();
const registry = m.contracts.LaunchpadRegistry.address;

await wallet.sendTransaction(registerOperatorTx({
  registry,
  slug: "sprout",                                       // permanent, a-z 0-9 and "-"
  brandURI: encodeBrandURI({ name: "Sprout", accent: "#2f9e6e" }),
  shareBps: 4000,                                       // 40% of the protocol's part of each curve fee
  templates: [0, 1],
  recipients: [
    { address: treasury, weightBps: 7000 },             // adding up to 10,000
    { address: partner, weightBps: 3000 },
  ],
}));
const operatorAddress = await predictOperator(publicClient, registry, "sprout");
```

Your launchpad's address (its operator id) is a fee splitter the registry creates for it. After registering, change it with `setBrandTx`, `setShareTx`, `setTemplatesTx`, `setActiveTx`, `setRecipientsTx` and `transferAdminTx` / `acceptAdminTx`. Pull fees with `collectTx` (from launches) and pay each recipient with `releaseTx`; anyone may send these, and money only goes to the recipients.

## Launch a token on your launchpad

```ts
import { approveTx, createLaunchTx, quoteBuy, withSlippage } from "@curveil/sdk";
import { parseUnits } from "viem";

const factory = m.contracts.LaunchFactory.address;
const usdg = m.assets.find((a) => a.label === "USDG")!.address;
const buy = parseUnits("100", 6);

await wallet.sendTransaction(approveTx(usdg, factory, buy));
await wallet.sendTransaction(createLaunchTx({
  factory,
  templateId: 1,
  name: "Seedling",
  symbol: "SEED",
  metadataURI: "",
  creatorRecipient: creator,
  operator: operator.address,  // records your launchpad and its share, fixed for the token's life
  initialBuy: buy,
}));
```

Trade on a curve with `buyTx` / `sellTx`, quoting first with `quoteBuy` / `quoteSell` (read calls through a viem public client) and `withSlippage`.

## Webhooks

Create an endpoint in the developer console (`/docs?page=webhooks`) or with `curveil.createWebhook(...)` while signed in. Every delivery is a signed POST:

| Header | Value |
| --- | --- |
| `Curveil-Event-Id` | Stable id of the chain event, the same on every retry and replay |
| `Curveil-Event-Type` | `swap`, `liquidity.changed`, `launch.created`, `launch.progress`, `launch.graduated`, `escrow.unlocked`, `perps.liquidation`, `operator.fee_paid` or `webhook.test` |
| `Curveil-Delivery-Id` | One per endpoint and event |
| `Curveil-Timestamp` | Unix seconds when this attempt was signed |
| `Curveil-Signature` | `t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">` |

```ts
import { verifyWebhookRequest, WebhookVerificationError } from "@curveil/sdk/webhooks";

export default {
  async fetch(request: Request, env: { CURVEIL_WEBHOOK_SECRET: string }) {
    try {
      const event = await verifyWebhookRequest(request, env.CURVEIL_WEBHOOK_SECRET);
      // A delivery can arrive more than once: skip event ids you already handled.
      return new Response("ok");
    } catch (e) {
      if (e instanceof WebhookVerificationError) return new Response("bad signature", { status: 401 });
      throw e;
    }
  },
};
```

Any answer other than 2xx within 10 seconds is retried with exponential backoff (30 seconds, doubling, at most 12 hours apart) for 24 hours. After that the delivery is dead; replay it from the console or with `curveil.replay(id, { status: "dead" })`. Events are sent once the sequencer includes them, before L1 finality.

## Sign-in and API keys

Keys and webhooks belong to a wallet. `curveil.signIn({ address, domain, uri, sign })` runs Sign-In with Ethereum (EIP-4361) and stores a seven-day session token on the client. With a session you can `createKey(label)` (the key is shown once; Curveil stores only its hash), `keys()` and `revokeKey(id)`. An API key can read and manage webhooks but not create other keys.

## Reference

- OpenAPI 3.1: `GET /v1/openapi.json`, rendered at `/docs?page=api`.
- Contract addresses, ABIs and verification: `GET /v1/manifest/testnet`.
- A launchpad frontend built only on this SDK: `apps/launchpad-example` in the Curveil repository.

MIT licensed.
