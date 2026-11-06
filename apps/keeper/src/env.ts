import type { Keeper } from "./keeper";

export interface Env {
  NETWORK: "testnet" | "mainnet";
  RPC_URL: string;
  ALLOWED_ORIGINS: string;
  MIN_SOURCES: string;
  MAX_SPREAD_BPS: string;
  /** Below this gas balance the keeper reports itself unhealthy. */
  MIN_GAS_BALANCE_WEI: string;
  /** Hot wallet that sends keeper transactions (Worker secret). Holds gas money and earned fees. */
  KEEPER_KEY: string;
  /** Hermes server for Pyth price updates (price source "pyth"). Optional: Pyth's public one by default. */
  HERMES_URL?: string;
  /** Pyth API key for Hermes (Worker secret), sent as a Bearer token. Hermes refuses requests without one. */
  PYTH_API_KEY?: string;
  /** Testnet price signer (Worker secret). Its address is the SignedReportVerifier's signer. */
  PRICE_SIGNER_KEY?: string;
  /** Where operational alerts go: a Slack or Discord webhook URL (Worker secret). Optional. */
  ALERT_WEBHOOK_URL?: string;
  /** The broadcaster to watch, e.g. https://curveil-broadcaster-testnet.example.workers.dev. Optional. */
  BROADCASTER_URL?: string;
  /** Shortest gap between ticks, in ms. Optional: a slow testnet keeper keeps the account inside its Durable Object quota. */
  MIN_TICK_MS?: string;
  CONFIG: KVNamespace;
  KEEPER: DurableObjectNamespace<Keeper>;
}
