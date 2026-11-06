/**
 * Deploys the mainnet Workers and site. Refuses to publish anything unless CURVEIL_MAINNET_GO=yes,
 * which is set only once the owner has approved the launch, and unless the mainnet manifest
 * (written by the contract deploy) exists and passes the schema.
 *
 * Usage: pnpm deploy:mainnet --dry-run          check every Worker's mainnet config, publish nothing
 *        CURVEIL_MAINNET_GO=yes pnpm deploy:mainnet [--only api,web] [--with-vault]
 *
 * Order: manifest into KV, database migrations, keeper, api, webhooks, broadcaster (only with
 * --with-vault), web. Secrets go up with each deploy through a temporary --secrets-file that only
 * this process can read and that is deleted afterwards. A secret a Worker already has is kept.
 * Hot wallets that are not given (MAINNET_KEEPER_KEY, MAINNET_BROADCASTER_KEY) are generated;
 * only their addresses are printed, so they can be funded. Secret values are never printed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { parseManifest } from "../src/index";

const root = resolve(import.meta.dirname, "../../..");
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const KV_ID = "d0efd6b92ac84ebcb6a2e80873afa77c";
const DB = "curveil-mainnet";
// The API binds the keeper, so the keeper goes first.
const ALL = ["keeper", "api", "webhooks", "broadcaster", "web"] as const;
type App = (typeof ALL)[number];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withVault = args.includes("--with-vault");
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice(7) ?? (args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined);
const only = onlyArg ? (onlyArg.split(",") as App[]) : null;
const apps = ALL.filter((a) => (only ? only.includes(a) : a !== "broadcaster" || withVault || dryRun));

function fail(msg: string): never {
  console.error(`Refused: ${msg}`);
  process.exit(1);
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = resolve(root, ".env.mainnet");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m?.[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v) out[k] = v;
  return out;
}

const wrangler = (app: App, cmd: string[], opts: { quiet?: boolean } = {}) => {
  const r = spawnSync("npx", ["wrangler", ...cmd], {
    cwd: resolve(root, "apps", app),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  return { ok: r.status === 0, out: r.stdout ?? "" };
};

function existingSecrets(app: App): Set<string> {
  const r = wrangler(app, ["secret", "list", "--env", "mainnet", "--format", "json"], { quiet: true });
  if (!r.ok) return new Set(); // The Worker does not exist yet.
  try {
    return new Set((JSON.parse(r.out) as { name: string }[]).map((s) => s.name));
  } catch {
    return new Set();
  }
}

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

if (dryRun) {
  // Compile each Worker against its mainnet config, without uploading or touching secrets.
  const out = mkdtempSync(join(tmpdir(), "curveil-dry-"));
  let bad = 0;
  for (const app of apps.filter((a) => a !== "web")) {
    const r = wrangler(app, ["deploy", "--dry-run", "--env", "mainnet", "--outdir", join(out, app)], { quiet: true });
    console.log(`${r.ok ? "✓" : "✗"} ${app}`);
    if (!r.ok) bad++;
  }
  rmSync(out, { recursive: true, force: true });
  const manifestPath = resolve(root, "packages/manifest/manifests/mainnet.json");
  console.log(existsSync(manifestPath) ? "✓ mainnet manifest present" : "· mainnet manifest not written yet (the contract deploy writes it; the site cannot be built before)");
  process.exit(bad ? 1 : 0);
}

// ---- A real deploy ----
const env = loadEnv();
if (env.CURVEIL_MAINNET_GO !== "yes") fail("CURVEIL_MAINNET_GO is not 'yes'. It is set only after the owner approves the mainnet launch.");

const manifestPath = resolve(root, "packages/manifest/manifests/mainnet.json");
if (!existsSync(manifestPath)) fail("packages/manifest/manifests/mainnet.json does not exist. Deploy the contracts first.");
const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
if (manifest.network !== "mainnet" || manifest.chainId !== 4663) fail("the manifest is not for Robinhood Chain mainnet");
if (!manifest.admin.safe) fail("the manifest has no Safe; finish governance and the handover first");
if (withVault && !manifest.contracts.ShieldedPool) fail("--with-vault, but the manifest has no ShieldedPool");

// No testnet key may reach mainnet.
const testnetKeys = ["DEPLOYER_PRIVATE_KEY", "BROADCASTER_PRIVATE_KEY", "BROADCASTER_KEY", "PRICE_SIGNER_KEY", "KEEPER_KEY"]
  .map((k) => env[k])
  .filter(Boolean)
  .map((k) => privateKeyToAddress(hex(k!)).toLowerCase());
for (const k of ["MAINNET_KEEPER_KEY", "MAINNET_BROADCASTER_KEY", "MAINNET_DEPLOYER_KEY"]) {
  if (env[k] && testnetKeys.includes(privateKeyToAddress(hex(env[k]!)).toLowerCase())) fail(`${k} is a testnet key`);
}
if (!env.CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN is not set");

const rpc = env.MAINNET_RPC_URL ?? PUBLIC_RPC;
if (!env.MAINNET_RPC_URL) console.log("· MAINNET_RPC_URL is not set: the Workers use the public RPC");

// Secrets each Worker needs. `shared` values must be equal across Workers.
const masterKey = env.MAINNET_WEBHOOK_MASTER_KEY ?? null;
const apiHas = apps.includes("api") || apps.includes("webhooks") ? existingSecrets("api") : new Set<string>();
const hooksHas = apps.includes("api") || apps.includes("webhooks") ? existingSecrets("webhooks") : new Set<string>();
let generatedMaster: string | null = null;
if (!masterKey && apiHas.has("WEBHOOK_MASTER_KEY") !== hooksHas.has("WEBHOOK_MASTER_KEY")) {
  fail("only one of the api and webhooks Workers has WEBHOOK_MASTER_KEY; set MAINNET_WEBHOOK_MASTER_KEY to the same value for both");
}
if (!masterKey && !apiHas.has("WEBHOOK_MASTER_KEY")) generatedMaster = randomBytes(32).toString("base64");

function secretsFor(app: App): Record<string, string> {
  const has = app === "api" ? apiHas : app === "webhooks" ? hooksHas : existingSecrets(app);
  const s: Record<string, string> = {};
  if (app !== "web" && app !== "webhooks") s.RPC_URL = rpc;
  // Log reads through a separate RPC when one is set (Alchemy's free plan caps them at 10 blocks).
  // Left unset, the Worker keeps the LOGS_RPC_URL it already has.
  const logsRpc = env.MAINNET_LOGS_RPC_URL ?? (env.NODEFLARE_KEY ? `https://rpc.nodeflare.app/robinhood/v1/${env.NODEFLARE_KEY}` : undefined);
  if (app === "api" && logsRpc) s.LOGS_RPC_URL = logsRpc;
  if (app === "api" || app === "webhooks") {
    const v = masterKey ?? generatedMaster;
    if (v) s.WEBHOOK_MASTER_KEY = v;
  }
  if (app === "keeper") {
    if (env.MAINNET_KEEPER_KEY) s.KEEPER_KEY = hex(env.MAINNET_KEEPER_KEY);
    else if (!has.has("KEEPER_KEY")) {
      s.KEEPER_KEY = generatePrivateKey();
      console.log(`· Generated the keeper wallet ${privateKeyToAddress(s.KEEPER_KEY as `0x${string}`)}. Send it about 0.005 ETH.`);
    }
    if (env.ALERT_WEBHOOK_URL) s.ALERT_WEBHOOK_URL = env.ALERT_WEBHOOK_URL;
    // Where Pyth price updates come from (a Hermes provider's URL can carry a key). Unset: the
    // keeper uses Pyth's public Hermes.
    if (env.HERMES_URL) s.HERMES_URL = env.HERMES_URL;
    // Hermes refuses requests without a Pyth API key (since Aug 26, 2026).
    if (env.PYTH_API_KEY) s.PYTH_API_KEY = env.PYTH_API_KEY;
  }
  if (app === "broadcaster") {
    if (env.MAINNET_BROADCASTER_KEY) s.BROADCASTER_KEY = hex(env.MAINNET_BROADCASTER_KEY);
    else if (!has.has("BROADCASTER_KEY")) {
      s.BROADCASTER_KEY = generatePrivateKey();
      console.log(`· Generated the broadcaster wallet ${privateKeyToAddress(s.BROADCASTER_KEY as `0x${string}`)}. Send it about 0.005 ETH.`);
    }
  }
  return s;
}

const dir = mkdtempSync(join(tmpdir(), "curveil-deploy-"));
try {
  // 1. The manifest every Worker reads.
  const kv = wrangler("api", ["kv", "key", "put", "manifest:mainnet", "--path", manifestPath, "--namespace-id", KV_ID, "--remote"]);
  if (!kv.ok) fail("could not write the manifest to KV");
  // 2. Database schema.
  if (apps.includes("api")) {
    const m = wrangler("api", ["d1", "migrations", "apply", DB, "--env", "mainnet", "--remote"]);
    if (!m.ok) fail("database migrations failed");
  }
  // 3. Workers, then the site.
  for (const app of apps) {
    if (app === "web") {
      execFileSync("node", ["scripts/copy-circuits.mjs"], { cwd: resolve(root, "apps/web"), stdio: "inherit" });
      execFileSync("node", ["scripts/pack-sdk.mjs"], { cwd: resolve(root, "apps/web"), stdio: "inherit" });
      execFileSync("npx", ["vite", "build", "--mode", "mainnet"], { cwd: resolve(root, "apps/web"), stdio: "inherit" });
      if (!wrangler("web", ["deploy", "--env", "mainnet"]).ok) fail("the site deploy failed");
      continue;
    }
    const file = join(dir, `${app}.json`);
    writeFileSync(file, JSON.stringify(secretsFor(app)), { mode: 0o600 });
    const r = wrangler(app, ["deploy", "--env", "mainnet", "--secrets-file", file]);
    rmSync(file, { force: true });
    if (!r.ok) fail(`the ${app} deploy failed; earlier steps stay deployed (roll back with wrangler rollback)`);
  }
  console.log("Done. Watch the alert channel for an hour (docs/runbooks.md section 6).");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
