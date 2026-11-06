import { Hono } from "hono";
import { cors } from "hono/cors";
import { indexerStub, loadManifest, oldIndexerStubs, type Env } from "./lib";
import { markets } from "./markets";
import { launch } from "./launch";
import { vault } from "./vault";
import { perps, perpsHealth } from "./perps";
import { auth, identify, type Vars } from "./auth";
import { governance } from "./governance";
import { operators } from "./operators";
import { webhooks } from "./webhooks";
import { openapi } from "./openapi";
import { ceremony } from "./ceremony";

export { Indexer } from "./indexer/indexer";

type ModuleRow = { id: string; name: string; status: string; phase: number; reason: string; updated_at: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Credentials are bearer tokens, never cookies, so any site may call the API from a browser
// (branded launchpads run on their operators' own domains). Sign-in is still bound to the
// allowed origins: a SIWE message must name one of them as its domain.
app.use("/v1/*", async (c, next) =>
  cors({
    origin: (origin) => {
      const allowed = c.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
      return allowed.includes(origin) ? origin : "*";
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "X-API-Key", "Content-Type"],
    exposeHeaders: ["X-Curveil-Network", "X-RateLimit-Limit", "X-RateLimit-Tier", "Retry-After"],
    maxAge: 86400,
  })(c, next),
);

app.use("/v1/*", identify);

app.use("/v1/*", async (c, next) => {
  await next();
  c.header("X-Curveil-Network", c.env.NETWORK);
  kickIndexer(c.env, c.executionCtx);
});

// The Workers Free plan caps cron triggers per account, so API traffic keeps the indexer's
// alarm loop alive instead: at most one cheap check per minute per isolate.
let lastKick = 0;
function kickIndexer(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
  if (Date.now() - lastKick < 60_000) return;
  lastKick = Date.now();
  const stub = indexerStub(env);
  ctx.waitUntil(stub.kick().catch((e) => console.error("indexer kick failed", e)));
  // Stop objects from earlier generations that are still looping (an object on old code has
  // no retire method; the call then fails and is ignored).
  for (const old of oldIndexerStubs(env)) ctx.waitUntil(old.retire().catch(() => undefined));
  // Also make sure the perps keeper's loop is running (it is a separate Worker).
  if (env.KEEPER) ctx.waitUntil(env.KEEPER.fetch("https://keeper/v1/kick", { method: "POST" }).catch(() => undefined));
}

async function chainHead(env: Env): Promise<{ ok: true; block: number; chainId: number } | { ok: false; error: string }> {
  try {
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] },
    ]);
    const r = await fetch(env.RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, error: `RPC answered ${r.status}` };
    const j = (await r.json()) as { id: number; result?: string; error?: { message: string } }[];
    const block = j.find((x) => x.id === 1)?.result;
    const chainId = j.find((x) => x.id === 2)?.result;
    if (!block || !chainId) return { ok: false, error: "RPC returned no result" };
    return { ok: true, block: Number(BigInt(block)), chainId: Number(BigInt(chainId)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "RPC unreachable" };
  }
}

type IndexerRow = { indexed_block: number; head_block: number; finalized_block: number | null; last_error: string | null; updated_at: string };

/** ok: within ~2 minutes of head; lagging: further behind; stalled: no progress for 5 minutes. */
function indexerStatus(row: IndexerRow | null, head: number | null) {
  if (!row) return { status: "not_started", lagBlocks: null };
  // An error recorded before the first range was indexed.
  if (row.indexed_block < 0) return { status: "not_started", lagBlocks: null, lastError: row.last_error, updatedAt: row.updated_at };
  const lag = Math.max(0, (head ?? row.head_block) - row.indexed_block);
  const ageSeconds = (Date.now() - Date.parse(row.updated_at)) / 1000;
  const status = ageSeconds > 300 ? "stalled" : lag > 500 ? "lagging" : "ok";
  return {
    status,
    lagBlocks: lag,
    indexedBlock: row.indexed_block,
    finalizedBlock: row.finalized_block,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

app.get("/health", (c) => c.text("ok"));

app.get("/v1/status", async (c) => {
  const [{ manifest }, head, modules, indexer, perpsStatus] = await Promise.all([
    loadManifest(c.env),
    chainHead(c.env),
    c.env.DB.prepare("SELECT id, name, status, phase, reason, updated_at FROM module_status ORDER BY phase, id").all<ModuleRow>(),
    c.env.DB.prepare("SELECT indexed_block, head_block, finalized_block, last_error, updated_at FROM indexer_state WHERE id = 1")
      .first<IndexerRow>()
      .catch(() => null),
    perpsHealth(c.env).catch(() => null),
  ]);
  const chainMismatch = head.ok && head.chainId !== manifest.chainId;
  c.header("Cache-Control", "public, max-age=5");
  return c.json({
    network: c.env.NETWORK,
    chainId: manifest.chainId,
    manifestVersion: manifest.version,
    chain: head.ok
      ? { status: chainMismatch ? "wrong_chain" : "ok", headBlock: head.block, rpcChainId: head.chainId }
      : { status: "unavailable", error: head.error },
    indexer: indexerStatus(indexer, head.ok ? head.block : null),
    modules: modules.results,
    perps: perpsStatus,
    generatedAt: new Date().toISOString(),
  });
});

app.get("/v1/manifest/:network", async (c) => {
  const network = c.req.param("network");
  if (network !== c.env.NETWORK) {
    return c.json({ error: "wrong_network", message: `This API serves ${c.env.NETWORK}. Use the ${network} API for that manifest.` }, 404);
  }
  const { manifest, source } = await loadManifest(c.env);
  c.header("Cache-Control", "public, max-age=60");
  c.header("X-Manifest-Source", source);
  return c.json(manifest);
});

app.get("/v1/assets", async (c) => {
  const { manifest } = await loadManifest(c.env);
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ network: manifest.network, assets: manifest.assets });
});

app.route("/v1", markets);
app.route("/v1", launch);
app.route("/v1", vault);
app.route("/v1", perps);
app.route("/v1", auth);
app.route("/v1", operators);
app.route("/v1", governance);
app.route("/v1", webhooks);
app.route("/v1", openapi);
app.route("/v1", ceremony);

app.notFound((c) => c.json({ error: "not_found", message: `No route for ${c.req.method} ${c.req.path}` }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: "The Curveil API hit an error. Please retry." }, 500);
});

export default {
  fetch: app.fetch,
  /** Cron, where the plan allows one: make sure the indexer's alarm loop is running. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(indexerStub(env).kick());
  },
} satisfies ExportedHandler<Env>;
