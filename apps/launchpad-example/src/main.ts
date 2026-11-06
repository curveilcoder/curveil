/**
 * A branded launchpad on Curveil, built only on @curveil/sdk and viem.
 *
 * Everything here goes through the SDK: the brand, fee share and templates come from the
 * launchpad's on-chain registration (via the API), launches are listed by operator, and every
 * transaction (approve, create, buy, sell) is built by an SDK helper and sent by the wallet.
 */
import {
  CurveilApiError,
  approveTx,
  buyTx,
  createClient,
  createLaunchTx,
  erc20Abi,
  quoteBuy,
  quoteSell,
  robinhoodTestnet,
  sellTx,
  withSlippage,
  type CurveilClient,
  type Launch,
  type Operator,
  type Template,
  type Tx,
} from "@curveil/sdk";
import { createPublicClient, createWalletClient, custom, formatUnits, http, parseUnits, type Address, type EIP1193Provider, type PublicClient, type WalletClient } from "viem";
import { h, mount } from "./dom";
import "./style.css";

type Config = { launchpad: string; network: "testnet" | "mainnet"; apiUrl: string; webhooks: boolean };

const app = document.getElementById("app")!;
const SLIPPAGE_BPS = 100;
const state: {
  curveil: CurveilClient;
  chain: PublicClient;
  wallet: WalletClient | null;
  account: Address | null;
  pad: Operator;
  templates: Template[];
  factory: Address;
  launches: Launch[];
  selected: Launch | null;
  config: Config;
} = {} as never;

async function loadConfig(): Promise<Config> {
  const fallback: Config = { launchpad: import.meta.env.VITE_LAUNCHPAD ?? "sprout", network: "testnet", apiUrl: import.meta.env.VITE_API_URL ?? "https://curveil-api-testnet.zeronym.workers.dev", webhooks: false };
  try {
    const r = await fetch("/config.json");
    if (r.ok && r.headers.get("content-type")?.includes("json")) return { ...fallback, ...((await r.json()) as Partial<Config>) };
  } catch {
    /* static hosting without the Worker */
  }
  return fallback;
}

async function boot() {
  const config = await loadConfig();
  const curveil = createClient({ network: config.network, baseUrl: config.apiUrl });
  // A verified custom domain wins; otherwise the configured launchpad.
  let pad: Operator | null = null;
  const host = location.hostname;
  if (host.includes(".") && !/^[\d.]+$/.test(host) && !host.endsWith(".workers.dev")) {
    pad = await curveil.operatorByDomain(host).then((r) => r.operator, () => null);
  }
  pad ??= (await curveil.operator(config.launchpad)).operator;
  const [{ templates }, manifest] = await Promise.all([curveil.templates(), curveil.manifest()]);
  Object.assign(state, {
    config,
    curveil,
    pad,
    templates: templates.filter((t) => t.enabled && pad.templates.includes(t.id)),
    factory: manifest.contracts.LaunchFactory!.address,
    chain: createPublicClient({ chain: robinhoodTestnet, transport: http() }),
    wallet: null,
    account: null,
    launches: [],
    selected: null,
  });
  document.title = pad.brand?.name || pad.slug;
  document.documentElement.style.setProperty("--brand", pad.brand?.accent ?? "#2f9e6e");
  await refreshLaunches();
  render();
  setInterval(() => refreshLaunches().then(render), 15_000);
}

async function refreshLaunches() {
  state.launches = (await state.curveil.launches({ operator: state.pad.address, sort: "new", limit: 50 })).launches;
  if (state.selected) state.selected = state.launches.find((l) => l.token === state.selected!.token) ?? state.selected;
}

// ------------------------------------------------------------------ wallet

async function connect() {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) return toast("No browser wallet found. Install one (for example MetaMask or Rabby) and reload.", "bad");
  const wallet = createWalletClient({ chain: robinhoodTestnet, transport: custom(eth) });
  const [account] = await wallet.requestAddresses();
  try {
    await wallet.switchChain({ id: robinhoodTestnet.id });
  } catch {
    await wallet.addChain({ chain: robinhoodTestnet });
  }
  state.wallet = wallet;
  state.account = account ?? null;
  render();
}

/** Sends SDK-built transactions one by one, waiting for each receipt. */
async function send(label: string, txs: Tx[]) {
  if (!state.wallet || !state.account) return connect();
  try {
    for (let i = 0; i < txs.length; i++) {
      toast(`${label}: confirm ${txs.length > 1 ? `step ${i + 1} of ${txs.length} ` : ""}in your wallet…`);
      const hash = await state.wallet.sendTransaction({ ...txs[i]!, account: state.account, chain: robinhoodTestnet });
      toast(`${label}: waiting for the transaction…`);
      const receipt = await state.chain.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted.");
    }
    toast(`${label}: done.`, "good");
    await refreshLaunches();
    render();
    return true;
  } catch (e) {
    toast(`${label} failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, "bad");
    return false;
  }
}

async function needsApproval(token: Address, spender: Address, amount: bigint) {
  if (!state.account) return true;
  const allowance = await state.chain.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [state.account, spender] });
  return allowance < amount;
}

// ------------------------------------------------------------------ actions

async function createToken(form: HTMLFormElement) {
  const data = new FormData(form);
  const t = state.templates.find((x) => x.id === Number(data.get("template")));
  if (!t || !state.account) return connect();
  const name = String(data.get("name")).trim();
  const symbol = String(data.get("symbol")).trim().toUpperCase();
  if (!name || !/^[A-Z0-9]{1,10}$/.test(symbol)) return toast("Enter a name and a symbol of 1 to 10 letters or digits.", "bad");
  const buy = String(data.get("buy") || "0").trim();
  const initialBuy = parseUnits(buy || "0", t.quote.decimals);
  const txs: Tx[] = [];
  if (initialBuy > 0n && (await needsApproval(t.quote.address, state.factory, initialBuy))) txs.push(approveTx(t.quote.address, state.factory, initialBuy));
  txs.push(createLaunchTx({ factory: state.factory, templateId: t.id, name, symbol, metadataURI: "", creatorRecipient: state.account, operator: state.pad.address, initialBuy }));
  if (await send(`Create ${symbol}`, txs)) form.reset();
}

async function trade(l: Launch, side: "buy" | "sell", amountText: string) {
  if (!state.account) return connect();
  const quote = l.quote!;
  if (side === "buy") {
    const quoteIn = parseUnits(amountText || "0", quote.decimals);
    if (quoteIn <= 0n) return toast("Enter an amount.", "bad");
    const q = await quoteBuy(state.chain, l.curve, quoteIn);
    const txs: Tx[] = [];
    if (await needsApproval(quote.address, l.curve, quoteIn)) txs.push(approveTx(quote.address, l.curve, quoteIn));
    txs.push(buyTx({ curve: l.curve, quoteIn, minTokensOut: withSlippage(q.tokensOut, SLIPPAGE_BPS), to: state.account }));
    return send(`Buy ${l.symbol}`, txs);
  }
  const tokensIn = parseUnits(amountText || "0", 18);
  if (tokensIn <= 0n) return toast("Enter an amount.", "bad");
  const q = await quoteSell(state.chain, l.curve, tokensIn);
  const txs: Tx[] = [];
  if (await needsApproval(l.token, l.curve, tokensIn)) txs.push(approveTx(l.token, l.curve, tokensIn));
  txs.push(sellTx({ curve: l.curve, tokensIn, minQuoteOut: withSlippage(q.quoteOut, SLIPPAGE_BPS), to: state.account }));
  return send(`Sell ${l.symbol}`, txs);
}

// ------------------------------------------------------------------ view

const fmt = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits }));
const pct = (bps: number | null | undefined) => (bps === null || bps === undefined ? "–" : `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function render() {
  const p = state.pad;
  const name = p.brand?.name || p.slug;
  const t0 = state.templates[0];
  const operatorPart = t0 ? Math.round(((10_000 - t0.creatorFeeShareBps) * p.effectiveShareBps) / 10_000) : 0;

  mount(
    app,
    h("header", { class: "top" },
      h("div", { class: "brand" }, h("span", { class: "mark", "aria-hidden": "true" }, name.slice(0, 1).toUpperCase()), h("div", null, h("strong", null, name), p.brand?.tagline && h("span", { class: "muted small" }, p.brand.tagline))),
      state.account ? h("span", { class: "pill mono" }, short(state.account)) : h("button", { class: "btn primary", onclick: connect }, "Connect wallet"),
    ),
    h("main", null,
      !p.acceptingLaunches && h("p", { class: "note bad" }, `${name} is not accepting new launches right now.`),
      h("section", { class: "hero" },
        h("h1", null, `Launch a token on ${name}`),
        h("p", { class: "muted" },
          "Fixed supply, a bonding curve until the reserve reaches the graduation threshold, then a locked-liquidity pool. ",
          t0 ? `Of each ${pct(t0.feeBps)} curve fee, the creator keeps ${pct(t0.creatorFeeShareBps)}, ${name} gets ${pct(operatorPart)} and the protocol the rest. ` : "",
          "These terms are fixed in each token when it is created.",
        ),
      ),
      h("div", { class: "cols" },
        h("section", { class: "card" }, h("h2", null, "Create a token"), createForm()),
        h("section", { class: "card" }, state.selected ? tradePanel(state.selected) : h("p", { class: "muted" }, "Pick a launch below to trade it.")),
      ),
      h("section", null,
        h("h2", null, `Launches on ${name}`),
        state.launches.length === 0 ? h("p", { class: "muted" }, "No launches yet. Be the first.") : h("div", { class: "grid" }, state.launches.map(launchCard)),
      ),
      state.config.webhooks && webhookFeed(),
    ),
    h("footer", { class: "muted small" },
      `Powered by Curveil contracts on ${state.config.network}. Launchpad `, h("span", { class: "mono" }, `${p.slug} (${short(p.address)})`), ". Built with @curveil/sdk.",
    ),
  );
}

function createForm() {
  const quote = state.templates[0]?.quote.symbol ?? "USDG";
  return h("form", { class: "stack", onsubmit: (e: Event) => { e.preventDefault(); void createToken(e.target as HTMLFormElement); } },
    h("label", null, "Template", h("select", { name: "template" }, state.templates.map((t) => h("option", { value: String(t.id) }, `${t.label} · graduates at ${fmt(t.graduationThresholdQuote, 0)} ${t.quote.symbol}`)))),
    h("label", null, "Name", h("input", { name: "name", maxLength: 32, required: true, placeholder: "Seedling" })),
    h("label", null, "Symbol", h("input", { name: "symbol", maxLength: 10, required: true, placeholder: "SEED", class: "mono" })),
    h("label", null, `Initial buy (${quote}, optional)`, h("input", { name: "buy", inputMode: "decimal", placeholder: "0", class: "mono" })),
    h("button", { class: "btn primary", type: "submit", disabled: !state.pad.acceptingLaunches || state.templates.length === 0 }, state.account ? "Create token" : "Connect wallet to create"),
  );
}

function launchCard(l: Launch) {
  return h("button", { class: `card launch${state.selected?.token === l.token ? " on" : ""}`, onclick: () => { state.selected = l; render(); } },
    h("div", { class: "row" }, h("strong", null, l.name), h("span", { class: "mono muted" }, l.symbol)),
    h("div", { class: "bar", "aria-label": `${pct(l.progressBps)} to graduation` }, h("div", { style: { width: `${Math.min(100, l.progressBps / 100)}%` } })),
    h("div", { class: "row small muted" }, h("span", null, l.state === "graduated" ? "Graduated" : `${pct(l.progressBps)} to graduation`), h("span", { class: "mono" }, `cap ${fmt(l.marketCap, 0)}`)),
  );
}

function tradePanel(l: Launch) {
  const amount = h("input", { inputMode: "decimal", placeholder: "Amount", class: "mono", "aria-label": "Amount" });
  const out = h("p", { class: "small muted" }, " ");
  let side: "buy" | "sell" = "buy";
  const seg = (s: typeof side, label: string) => h("button", { type: "button", class: `seg${side === s ? " on" : ""}`, onclick: (e: Event) => { side = s; for (const b of (e.target as HTMLElement).parentElement!.children) b.classList.toggle("on", b === e.target); preview(); } }, label);
  const preview = async () => {
    try {
      const v = amount.value.trim();
      if (!v || Number(v) <= 0) return (out.textContent = " ");
      if (side === "buy") {
        const q = await quoteBuy(state.chain, l.curve, parseUnits(v, l.quote!.decimals));
        out.textContent = `About ${fmt(Number(formatUnits(q.tokensOut, 18)), 2)} ${l.symbol}, fee ${formatUnits(q.fee, l.quote!.decimals)} ${l.quote!.symbol}`;
      } else {
        const q = await quoteSell(state.chain, l.curve, parseUnits(v, 18));
        out.textContent = `About ${formatUnits(q.quoteOut, l.quote!.decimals)} ${l.quote!.symbol}`;
      }
    } catch {
      out.textContent = "No quote for that amount.";
    }
  };
  amount.addEventListener("input", () => void preview());
  if (l.state === "graduated") {
    return h("div", { class: "stack" }, h("h2", null, `${l.name} graduated`), h("p", { class: "muted" }, "It now trades in a DAMM pool on Curveil, with its liquidity locked in escrow."), l.pool && h("p", { class: "mono small" }, `Pool ${short(l.pool)}`));
  }
  return h("div", { class: "stack" },
    h("h2", null, `Trade ${l.symbol}`),
    h("p", { class: "small muted" }, `Price ${fmt(l.price, 8)} ${l.quote?.symbol ?? ""} · ${l.trades} trades · ${pct(l.operatorShareBps)} launchpad share`),
    h("div", { class: "segs" }, seg("buy", `Buy with ${l.quote?.symbol ?? "quote"}`), seg("sell", `Sell ${l.symbol}`)),
    amount,
    out,
    h("button", { class: "btn primary", type: "button", onclick: () => void trade(l, side, amount.value.trim()) }, state.account ? "Review in wallet" : "Connect wallet"),
    h("p", { class: "small muted" }, `Slippage limit ${pct(SLIPPAGE_BPS)}.`),
  );
}

function webhookFeed() {
  const list = h("ol", { class: "feed small" }, h("li", { class: "muted" }, "Loading…"));
  fetch("/webhooks/recent")
    .then((r) => r.json() as Promise<{ events: { id: string; type: string; createdAt: string; test: boolean }[] }>)
    .then(({ events }) => mount(list, events.length ? events.map((e) => h("li", null, h("span", { class: "mono" }, e.type), e.test && " (test)", h("span", { class: "muted" }, ` · ${new Date(e.createdAt).toLocaleString()} · ${e.id.slice(0, 14)}…`))) : h("li", { class: "muted" }, "No events received yet.")))
    .catch(() => mount(list, h("li", { class: "muted" }, "Could not load events.")));
  return h("section", null, h("h2", null, "Webhook events"), h("p", { class: "small muted" }, "Signed deliveries from Curveil, each verified by this site's Worker with verifyWebhookRequest before it is stored."), list);
}

// Lives outside #app so a re-render never clears a message.
const toastEl = document.body.appendChild(h("div", { id: "toast", role: "status", "aria-live": "polite" }));
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, kind: "info" | "good" | "bad" = "info") {
  const el = toastEl;
  el.textContent = text;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  if (kind !== "info") toastTimer = setTimeout(() => (el.className = ""), 8000);
}

boot().catch((e) => {
  const msg = e instanceof CurveilApiError && e.status === 404 ? "This launchpad is not registered on Curveil yet." : "The launchpad could not be loaded. Try again in a moment.";
  mount(app, h("p", { class: "note bad" }, msg));
});
