import type { NonceManager } from "./nonces";

export interface Env {
  NETWORK: "testnet" | "mainnet";
  RPC_URL: string;
  ALLOWED_ORIGINS: string;
  /** JSON map of token address to minimum fee in base units. */
  FEES: string;
  /** Below this gas balance the broadcaster stops accepting work and reports itself unhealthy. */
  MIN_GAS_BALANCE_WEI: string;
  /** Hot wallet key (Worker secret). The wallet holds only gas money. */
  BROADCASTER_KEY: string;
  CONFIG: KVNamespace;
  NONCES: DurableObjectNamespace<NonceManager>;
  SUBMITS?: RateLimit;
}
