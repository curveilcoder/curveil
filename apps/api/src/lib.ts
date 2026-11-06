import { parseManifest, type Manifest } from "@curveil/manifest";
import bundledTestnet from "@curveil/manifest/manifests/testnet.json";
import type { Indexer } from "./indexer/indexer";

export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  INDEXER: DurableObjectNamespace<Indexer>;
  NETWORK: "testnet" | "mainnet";
  RPC_URL: string;
  /** Optional RPC for eth_getLogs only, when the main RPC limits log ranges (Worker secret). */
  LOGS_RPC_URL?: string;
  /** Optional: most blocks per eth_getLogs call (default 20,000). */
  MAX_LOG_RANGE?: string;
  /** Optional: milliseconds between indexer ticks once caught up (default 8,000). */
  INDEXER_IDLE_MS?: string;
  ALLOWED_ORIGINS: string;
  /** The perps keeper Worker (service binding): signed prices, health, kicks. Optional in dev. */
  KEEPER?: Fetcher;
  /** Per-IP limit on metadata uploads (Workers rate limiting binding); optional in dev. */
  UPLOADS?: RateLimit;
  /** Request limits: per IP without a key, per key with one. Optional in dev. */
  PUBLIC_LIMIT?: RateLimit;
  KEY_LIMIT?: RateLimit;
  /** Webhook deliveries for the delivery Worker (apps/webhooks). Optional in dev. */
  WEBHOOKS?: Queue<{ delivery: string; attempt: number }>;
  /** Encrypts webhook signing secrets at rest (32 bytes, base64). Worker secret. */
  WEBHOOK_MASTER_KEY?: string;
}

/**
 * The indexer object's name. Bump the generation when a deploy must replace the running
 * object outright: a Durable Object kept busy by its own alarm can keep running old code
 * after a deploy. Objects under any other name retire themselves once they run new code.
 */
export const INDEXER_GENERATION: Record<string, number> = { testnet: 7, mainnet: 11 };
export const indexerName = (env: Pick<Env, "NETWORK">) => `indexer-${env.NETWORK}-g${INDEXER_GENERATION[env.NETWORK] ?? 1}`;
export const indexerStub = (env: Env) => env.INDEXER.get(env.INDEXER.idFromName(indexerName(env)));
/** Objects of the few generations before the current one, which may still be running. */
export const oldIndexerStubs = (env: Env) => {
  const g = INDEXER_GENERATION[env.NETWORK] ?? 1;
  const out = [];
  for (let n = Math.max(1, g - 6); n < g; n++) out.push(env.INDEXER.get(env.INDEXER.idFromName(`indexer-${env.NETWORK}-g${n}`)));
  return out;
};

/** Active manifest: KV first (updated on each deploy), bundled copy as fallback. */
export async function loadManifest(env: Env): Promise<{ manifest: Manifest; source: "kv" | "bundled" }> {
  const raw = await env.CONFIG.get(`manifest:${env.NETWORK}`, "json");
  if (raw) {
    const kv = parseManifest(raw);
    // A redeploy can ship a newer bundled manifest before KV is refreshed; prefer the newer one.
    if (env.NETWORK === "testnet") {
      const bundled = parseManifest(bundledTestnet);
      if (buildNumber(bundled.version) > buildNumber(kv.version)) return { manifest: bundled, source: "bundled" };
    }
    return { manifest: kv, source: "kv" };
  }
  if (env.NETWORK === "testnet") return { manifest: parseManifest(bundledTestnet), source: "bundled" };
  throw new Error(`No manifest published for ${env.NETWORK}`);
}

function buildNumber(version: string): number {
  const n = Number(version.split(".").pop());
  return Number.isFinite(n) ? n : 0;
}
