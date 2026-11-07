import { Link } from "@tanstack/react-router";
import { Sk } from "../Skeleton";
import { useQuery } from "@tanstack/react-query";
import { Faucet } from "../Faucet";
import { ModuleStatus } from "../ModuleStatus";
import { ApiReference } from "../ApiReference";
import { SDK_VERSION } from "@curveil/sdk";
import { API_URL, BROADCASTER_URL, EXAMPLE_URL, IS_TESTNET, NETWORK, explorerAddress, manifest, shortAddress } from "../../lib/config";

const CHAIN_EXPORT = IS_TESTNET ? "robinhoodTestnet" : "robinhood";
import { api } from "../../lib/launchpads";
import { fmtBps } from "../../lib/format";
import { Callout, C, Code, CodeTabs, Section, Step, Steps } from "./Kit";

const SDK_TARBALL = `/sdk/curveil-sdk-${SDK_VERSION}.tgz`;

const BROADCAST_ENDPOINTS = [
  ["GET", "/v1/broadcast/info", "Broadcaster address, gas balance, health, fee per asset, fee multiplier per action, relayed adapters and what it can see"],
  ["POST", "/v1/broadcast/quote", "Fee and fee recipient to bind into a transfer, withdrawal or shielded execution"],
  ["POST", "/v1/broadcast/submit", "Validates, simulates and sends a proof-bound transfer, withdrawal or shielded execution (swap, liquidity entry or exit)"],
  ["GET", "/v1/broadcast/:id", "Submitted, confirmed, failed or dropped, with the transaction hash"],
];

/** The developer pages of /docs. */
export function DevPage({ page }: { page: "quickstart" | "launchpad-guide" | "api" | "testnet" }) {
  if (page === "quickstart") return <><ModuleStatus id="developers" /><Quickstart /></>;
  if (page === "launchpad-guide") return <LaunchpadGuide />;
  if (page === "api") return <ApiGuide />;
  return <TestnetTools />;
}

function ApiGuide() {
  return (
    <>
      <Section title="Base URL">
        <p className="dk-p">Every endpoint is under one base URL and returns JSON. The full schema is OpenAPI 3.1 at <a href={`${API_URL}/v1/openapi.json`} target="_blank" rel="noreferrer"><C>/v1/openapi.json</C></a>, so any client generator works.</p>
        <Code lang="txt" title="Base URL">{API_URL}</Code>
      </Section>
      <Section title="Authentication and limits">
        <p className="dk-p">
          Reads need no key and allow 300 requests a minute per IP. Send an <Link to="/app/profile" search={{ tab: "developer", sub: "keys" }}>API key</Link> as a bearer token to
          raise that to 3,000. Each response says which limit applied in <C>X-RateLimit-Limit</C> and <C>X-RateLimit-Tier</C>.
        </p>
        <CodeTabs
          tabs={[
            { label: "curl", lang: "sh", code: `curl "${API_URL}/v1/launches?sort=volume&limit=3" \\\n  -H "Authorization: Bearer $CURVEIL_API_KEY"` },
            { label: "SDK", code: `const curveil = createClient({ network: "${NETWORK}", apiKey: process.env.CURVEIL_API_KEY });\nconst { launches } = await curveil.launches({ sort: "volume", limit: 3 });` },
            { label: "fetch", code: `const r = await fetch("${API_URL}/v1/launches?sort=volume&limit=3", {\n  headers: { Authorization: \`Bearer \${process.env.CURVEIL_API_KEY}\` },\n});\nconst { launches } = await r.json();` },
          ]}
        />
        <Callout kind="warn">Keep keys on your server. A key in browser code can be copied by anyone who opens your site.</Callout>
      </Section>
      <Section title="Errors">
        <p className="dk-p">Errors use normal HTTP status codes and a body with a stable code and a readable message. On a 429, wait for the seconds in <C>Retry-After</C>.</p>
        <Code lang="json" title="429 Too Many Requests">{`{
  "error": "rate_limited",
  "message": "Over 300 requests a minute from this address. Use an API key for a higher limit."
}`}</Code>
      </Section>
      <Section title="Endpoints">
        <div className="panel"><ApiReference /></div>
      </Section>
    </>
  );
}

function Quickstart() {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <>
      <Section title="Before you start">
        <p className="dk-p">
          You need Node 18 or later (or a browser, Worker, Deno or Bun), and a wallet with {IS_TESTNET ? "test tokens" : "a little ETH for gas"} for the steps that send
          transactions.{IS_TESTNET && <> Get them on <Link to="/docs" search={{ page: "testnet" }}>Testnet tools</Link>.</>}
        </p>
      </Section>
      <Section title="Build your first integration" id="steps">
      <Steps>
      <Step title="Install the SDK">
        <p className="dk-p">
          <C>@curveil/sdk</C> works in browsers, Workers, Deno, Bun and Node 18+, with <C>viem</C> as its only peer dependency. Until it
          is on npm, install the build served by this site:
        </p>
        <CodeTabs tabs={[{ label: "npm", lang: "sh", code: `npm install viem ${origin}${SDK_TARBALL}` }, { label: "pnpm", lang: "sh", code: `pnpm add viem ${origin}${SDK_TARBALL}` }, { label: "bun", lang: "sh", code: `bun add viem ${origin}${SDK_TARBALL}` }]} />
      </Step>

      <Step title="Read data">
        <p className="dk-p">Reads need no key (300 requests a minute per IP). An <Link to="/app/profile" search={{ tab: "developer", sub: "keys" }}>API key</Link> raises that to 3,000.</p>
        <CodeTabs
          tabs={[
            {
              label: "SDK",
              code: `import { createClient } from "@curveil/sdk";

const curveil = createClient({ network: "${NETWORK}"${API_URL.includes("localhost") ? `, baseUrl: "${API_URL}"` : ""} /*, apiKey: process.env.CURVEIL_API_KEY */ });

const { launches } = await curveil.launches({ sort: "volume", limit: 10 });
const pad = await curveil.operator("sprout");          // a launchpad by name or address
const revenue = await curveil.revenue(pad.operator.address);`,
            },
            { label: "curl", lang: "sh", code: `curl "${API_URL}/v1/launches?sort=volume&limit=10"\ncurl "${API_URL}/v1/operators/sprout"` },
          ]}
        />
      </Step>

      <Step title="Launch tokens on your launchpad">
        <p className="dk-p">
          <Link to="/docs" search={{ page: "launchpad-guide" }}>Register a launchpad</Link> first. The SDK returns plain <C>{"{ to, data, value }"}</C> transactions for any wallet library;
          the launch records your launchpad and its fee share, fixed for the token's life.
        </p>
        <Code>{`import { approveTx, createLaunchTx } from "@curveil/sdk";
import { parseUnits } from "viem";

const m = await curveil.manifest();
const factory = m.contracts.LaunchFactory.address;
const usdg = m.assets.find((a) => a.label === "USDG")!.address;
const buy = parseUnits("100", 6);                      // optional initial buy in USDG

await wallet.sendTransaction(approveTx(usdg, factory, buy));
await wallet.sendTransaction(createLaunchTx({
  factory,
  templateId: 1,
  name: "Seedling", symbol: "SEED", metadataURI: "",
  creatorRecipient: creator,
  operator: pad.operator.address,                      // your launchpad
  initialBuy: buy,                                     // minTokensOut: use quoteBuy() for slippage
}));`}</Code>
      </Step>

      <Step title="Receive webhooks">
        <p className="dk-p">
          <Link to="/app/profile" search={{ tab: "developer", sub: "webhooks" }}>Add an endpoint</Link> in your profile, keep its signing secret, and verify every delivery against the raw body before trusting it.
        </p>
        <Code>{`import { verifyWebhookRequest, WebhookVerificationError } from "@curveil/sdk/webhooks";

export default {
  async fetch(request: Request, env: { CURVEIL_WEBHOOK_SECRET: string }) {
    try {
      const event = await verifyWebhookRequest(request, env.CURVEIL_WEBHOOK_SECRET);
      if (await alreadyHandled(event.id)) return new Response("ok");   // retries reuse the id
      if (event.type === "launch.created") { /* … */ }
      return new Response("ok");
    } catch (e) {
      if (e instanceof WebhookVerificationError) return new Response("bad signature", { status: 401 });
      throw e;                                                          // a 5xx is retried
    }
  },
};`}</Code>
        <Callout kind="note" title="Verifying without the SDK">
          The signature header is <C>Curveil-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex HMAC-SHA256 of "t.body"&gt;</C>. Compute the same HMAC with your secret,
          compare in constant time, and reject timestamps more than 5 minutes old.
        </Callout>
      </Step>

      </Steps>
      </Section>
      <Section title="Where to go next">
        <ul className="dk-list">
          <li><Link to="/docs" search={{ page: "api" }}>API reference</Link>, generated from <a href={`${API_URL}/v1/openapi.json`} target="_blank" rel="noreferrer" className="mono">/v1/openapi.json</a> (OpenAPI 3.1, usable with any generator).</li>
          <li>Contract addresses, ABIs and verification: <a href={`${API_URL}/v1/manifest/${manifest.network}`} target="_blank" rel="noreferrer" className="mono">/v1/manifest/{manifest.network}</a>, version {manifest.version}.</li>
          <li>
            A complete launchpad frontend built only on the SDK: <C>apps/launchpad-example</C> in the repository
            {EXAMPLE_URL && <>, running at <a href={EXAMPLE_URL} target="_blank" rel="noreferrer">{EXAMPLE_URL.replace(/^https:\/\//, "")}</a></>}.
          </li>
        </ul>
      </Section>
    </>
  );
}

const MANAGE = [
  ["setBrandTx(registry, operator, brandURI)", "Name, tagline, accent, website and logo. Display only."],
  ["setShareTx(registry, operator, shareBps)", "Your fee share, up to the cap. Applies to launches created afterwards."],
  ["setTemplatesTx(registry, operator, ids)", "Which launch templates your launchpad offers. New launches only."],
  ["setActiveTx(registry, operator, false)", "Pauses new launches. Tokens already launched keep trading."],
  ["setRecipientsTx(registry, operator, recipients, tokens)", "Who receives your fees. Fees already received in the listed tokens go to the old recipients first."],
  ["transferAdminTx(registry, operator, next)", "Hands the launchpad to another wallet, which then sends acceptAdminTx(registry, operator)."],
];

/** How to run a launchpad straight on the contracts: register, build the site, collect fees, manage. */
function LaunchpadGuide() {
  const info = useQuery({ queryKey: ["factory"], queryFn: () => api.factory(), staleTime: 30_000 });
  const registry = manifest.contracts.LaunchpadRegistry?.address;
  const launchFactory = manifest.contracts.LaunchFactory?.address;
  const cap = info.data?.maxShareBps;
  return (
    <>
      <Section title="Overview">
        <p className="dk-p">
          A launchpad is a brand and a fee share registered on <C>LaunchpadRegistry</C>. There is nothing to deploy: every token launched through it
          uses the same launch contracts as any Curveil launch, with the same curves, graduation and LP escrow. You build and host the website, and you earn part of the
          protocol's share of every curve fee on tokens launched through it. The steps below use <C>@curveil/sdk</C>, which builds each transaction for
          you. Any wallet library can send them, and so can a block explorer.
        </p>
        <dl className="kv">
          <div><dt>LaunchpadRegistry</dt><dd className="mono small">{registry ? <a href={explorerAddress(registry)} target="_blank" rel="noreferrer" title={registry}>{shortAddress(registry)}</a> : "Not deployed on this network"}</dd></div>
          <div><dt>LaunchFactory</dt><dd className="mono small">{launchFactory ? <a href={explorerAddress(launchFactory)} target="_blank" rel="noreferrer" title={launchFactory}>{shortAddress(launchFactory)}</a> : "Not deployed on this network"}</dd></div>
          <div><dt>Fee share cap</dt><dd>{cap !== undefined ? fmtBps(cap) : info.isLoading ? <Sk w="6ch" /> : "–"}</dd></div>
          <div><dt>Launchpads registered</dt><dd>{info.data?.operatorCount ?? (info.isLoading ? <Sk w="3ch" /> : "–")}</dd></div>
        </dl>
      </Section>

      <Section title="Set it up" id="steps">
      <Steps>
      <Step title="Pick a name">
        <p className="dk-p">
          The name (slug) is permanent and appears in links and the API: 3 to 32 characters of a-z, 0-9 and "-", not starting or ending with "-". Read the registry to see
          whether it is free.
        </p>
        <Code>{`import { createClient, isValidSlug, launchpadRegistryAbi, ${CHAIN_EXPORT} } from "@curveil/sdk";
import { createPublicClient, http, keccak256, toBytes, zeroAddress } from "viem";

const curveil = createClient({ network: "${NETWORK}" });
const chain = createPublicClient({ chain: ${CHAIN_EXPORT}, transport: http() });
const { registry, maxShareBps } = await curveil.factory();

const slug = "northbank";
if (!isValidSlug(slug)) throw new Error("bad name");
const owner = await chain.readContract({
  address: registry, abi: launchpadRegistryAbi,
  functionName: "operatorBySlug", args: [keccak256(toBytes(slug))],
});
const free = owner === zeroAddress;`}</Code>
      </Step>

      <Step title="Register it">
        <p className="dk-p">
          One transaction. The wallet that sends it becomes the launchpad's admin. Your launchpad's address is known before you send it, and that address is what each launch
          records as its operator. Recipients are 1 to 8 addresses whose weights add up to 10,000.
        </p>
        <Code>{`import { encodeBrandURI, predictOperator, registerOperatorTx } from "@curveil/sdk";

const brandURI = encodeBrandURI({
  name: "Northbank", tagline: "Launches for the north bank",
  accent: "#2563ff", url: "https://launch.northbank.xyz",
});
const { templates } = await curveil.templates();
const operator = await predictOperator(chain, registry, slug);   // your launchpad's address

await wallet.sendTransaction(registerOperatorTx({
  registry, slug, brandURI,
  shareBps: 2500,                                  // 25%, at most maxShareBps
  templates: templates.filter((t) => t.enabled).map((t) => t.id),
  recipients: [{ address: treasury, weightBps: 10_000 }],
}));`}</Code>
        <p className="dk-p">
          The share is a part of the protocol's portion of each curve fee, not an extra charge, and creators keep their full share. On the standard template (1% fee, half to
          the creator) a 25% share pays your launchpad 0.125% of every curve trade. Each launch fixes the share when it is created, so a later change never touches existing
          tokens.
        </p>
      </Step>

      <Step title="Build the website">
        <p className="dk-p">
          Your site reads its own settings and launches from the API and sends transactions built by the SDK. There is no indexer to run. Launches made from your site pass
          your launchpad's address as <C>operator</C>, as in step 3 of the <Link to="/docs" search={{ page: "quickstart" }}>Quickstart</Link>.
        </p>
        <Code>{`const { operator: pad } = await curveil.operator(slug);  // brand, share, templates, status
const { launches } = await curveil.launches({ operator: pad.address, sort: "volume" });

// Trading on a curve: quote, then build and send.
const { tokensOut } = await quoteBuy(chain, launch.curve, quoteIn);
await wallet.sendTransaction(buyTx({ curve: launch.curve, quoteIn, minTokensOut: withSlippage(tokensOut, 100), to: user }));`}</Code>
        <ul className="dk-list">
          <li>
            A complete launchpad site built only on the SDK and viem is in <C>apps/launchpad-example</C>
            {EXAMPLE_URL && <>, running at <a href={EXAMPLE_URL} target="_blank" rel="noreferrer">{EXAMPLE_URL.replace(/^https:\/\//, "")}</a></>}. Copy it and set your slug.
          </li>
          <li>
            Custom domain (optional): sign in with your admin wallet, save it with <C>setOperatorProfile({"{ operator, domain }"})</C>, add the DNS TXT
            record that <C>curveil.operator(slug)</C> returns as <C>domainSetup.record</C>, then call{" "}
            <C>verifyDomain(operator)</C>. Your site can then find itself with <C>operatorByDomain(location.hostname)</C>.
          </li>
          <li><Link to="/app/profile" search={{ tab: "developer", sub: "webhooks" }}>Webhooks</Link> tell your backend when a token launches, trades or graduates.</li>
        </ul>
      </Step>

      <Step title="Collect your fees">
        <p className="dk-p">
          Your fees build up inside each token's curve. Collecting pulls them into your launchpad's address and splits them by weight; releasing pays one recipient. Anyone can
          send these transactions, and the money only ever goes to your recipients.
        </p>
        <Code>{`import { collectTx, releaseTx } from "@curveil/sdk";

const rev = await curveil.revenue(slug);
for (const t of rev.tokens) {
  const curves = rev.curves
    .filter((c) => c.quote.toLowerCase() === t.token.toLowerCase() && BigInt(c.uncollected) > 0n)
    .map((c) => c.curve);
  if (curves.length) await wallet.sendTransaction(collectTx(operator, curves, t.token));
  for (const r of t.recipients) {
    if (BigInt(r.owed) > 0n) await wallet.sendTransaction(releaseTx(operator, t.token, r.address));
  }
}`}</Code>
        <p className="dk-p">
          Fees that reach your launchpad's address another way are split with <C>distributeTx(operator, token)</C>.
        </p>
      </Step>

      <Step title="Change settings">
        <p className="dk-p">Only the admin wallet can send these. Every helper is exported by the SDK and goes to the registry.</p>
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead><tr><th>Transaction</th><th>What it changes</th></tr></thead>
            <tbody>{MANAGE.map(([f, d]) => <tr key={f}><td className="mono">{f}</td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <Callout kind="note" title="What nobody can change">
          Not even you: the rules of a live launch, curve reserves, graduation and the LP escrow, or paying out more than was collected. The protocol can suspend a launchpad
          that breaks its terms; that stops new launches the same way a pause does, and only the protocol can lift it.
        </Callout>
      </Step>
      </Steps>
      </Section>
    </>
  );
}

function TestnetTools() {
  return (
    <>
      <Section title="Test tokens">
        <Faucet />
      </Section>
      <Section title="Vault broadcaster">
        <p className="dk-p">
          Submits proof-bound vault transactions and pays gas for a fee taken from the notes. It cannot change recipients, amounts or fees, and it keeps no logs. Anyone can
          submit the same calldata from their own wallet instead.
        </p>
        <Code lang="txt" title="Base URL">{BROADCASTER_URL}</Code>
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead><tr><th>Method</th><th>Path</th><th>Returns</th></tr></thead>
            <tbody>
              {BROADCAST_ENDPOINTS.map(([m, p, d]) => (
                <tr key={p}>
                  <td className="mono">{m}</td>
                  <td className="mono">{p}</td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dk-p">
          The vault construction is specified in <C>docs/vault-spec.md</C>. A standalone client that needs only a recovery phrase and an RPC endpoint is in{" "}
          <C>packages/vault-core/scripts/vault-cli.ts</C> (guide: <C>docs/vault-alternative-client.md</C>).
        </p>
      </Section>
    </>
  );
}
