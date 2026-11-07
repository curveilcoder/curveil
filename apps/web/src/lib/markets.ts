import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api";
import { tNow } from "./i18n";

export type TokenRef = { address: `0x${string}`; symbol: string; decimals: number; isQuote: boolean; name?: string | null; image?: string | null };

export type MarketPool = {
  address: `0x${string}`;
  kind: "damm" | "dlmm";
  factory: string;
  token0: TokenRef; // tokenX for DLMM
  token1: TokenRef; // tokenY for DLMM
  fees: { currentBps: number; baseBps: number; maxBps: number | null; protocolShareBps: number; tier: number | null };
  binStep: number | null;
  activeId: number | null;
  reserves: { raw0: string | null; raw1: string | null; amount0: number | null; amount1: number | null };
  lpSupply: string | null;
  price: number | null; // token1 per token0
  tvlQuote: number | null;
  volume24hQuote: number;
  fees24hQuote: number;
  swaps24h: number;
  lastSwapAt: number | null;
  stateBlock: number | null;
  createdBlock: number;
  createdTx: string;
  /** Who created the pool; null for a launch's graduation pool or before the indexer has read it. */
  creator?: string | null;
  /** The launch token whose graduation made this pool, if any. */
  launch?: string | null;
};

export type SwapEvent = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  pool: string;
  sender: string;
  recipient: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  fee: string;
  protocolFee: string;
  feeBps: number;
  quoteValue: number | null;
  activeIdAfter: number | null;
  finality: "sequencer" | "final";
};

export type ActivityItem =
  | ({ type: "swap" } & SwapEvent)
  | {
      type: "liquidity";
      kind: "add" | "remove" | "claim" | "transfer_out" | "transfer_in";
      txHash: string;
      blockNumber: number;
      timestamp: number;
      pool: string;
      amount0: string;
      amount1: string;
      shares: string | null;
      bins: number[] | null;
      finality: "sequencer" | "final";
    };

export type Positions = {
  account: string;
  damm: {
    pool: `0x${string}`;
    lpBalance: string;
    shareOfPool: number;
    amount0: string;
    amount1: string;
    pendingFees0: string;
    pendingFees1: string;
  }[];
  dlmm: {
    pool: `0x${string}`;
    bins: { id: number; shares: string; amountX: string; amountY: string }[];
    amountX: string;
    amountY: string;
    pendingFeesX: string;
    pendingFeesY: string;
    allBins: number[];
  }[];
};

export function useMarkets() {
  return useQuery({ queryKey: ["markets"], queryFn: () => getJson<{ pools: MarketPool[] }>("/v1/markets").then((r) => r.pools), refetchInterval: 10_000 });
}

/** Pools one address created, newest first. */
export function usePoolsBy(creator: string | undefined) {
  return useQuery({
    queryKey: ["pools-by", creator?.toLowerCase()],
    queryFn: () => getJson<{ pools: MarketPool[] }>(`/v1/markets?creator=${creator}`).then((r) => r.pools),
    enabled: Boolean(creator),
    refetchInterval: 15_000,
  });
}

export function usePoolSwaps(pool: string | undefined, limit = 50) {
  return useQuery({
    queryKey: ["swaps", pool, limit],
    queryFn: () => getJson<{ swaps: SwapEvent[] }>(`/v1/markets/${pool}/swaps?limit=${limit}`).then((r) => r.swaps),
    enabled: Boolean(pool),
    refetchInterval: 8_000,
  });
}

export function usePositions(account: string | undefined) {
  return useQuery({
    queryKey: ["positions", account],
    queryFn: () => getJson<Positions>(`/v1/accounts/${account}/positions`),
    enabled: Boolean(account),
    refetchInterval: 15_000,
  });
}

export function useActivity(account: string | undefined) {
  return useQuery({
    queryKey: ["activity", account],
    queryFn: () => getJson<{ items: ActivityItem[] }>(`/v1/accounts/${account}/activity`).then((r) => r.items),
    enabled: Boolean(account),
    refetchInterval: 10_000,
  });
}

export const pairLabel = (p: MarketPool) => `${p.token0.symbol} / ${p.token1.symbol}`;
export const kindLabel = (p: MarketPool) => (p.kind === "damm" ? "DAMM" : tNow(`DLMM · bin ${p.binStep}`, `DLMM · 区间 ${p.binStep}`));

/** Price of `base` in units of the other token of the pool. */
export function priceOf(p: MarketPool, base: string): number | null {
  if (!p.price) return null;
  return base.toLowerCase() === p.token0.address.toLowerCase() ? p.price : 1 / p.price;
}

/** Human price of a DLMM bin: token1 (Y) per token0 (X). */
export function binPrice(id: number, binStep: number, dec0: number, dec1: number): number {
  return Math.pow(1 + binStep / 10_000, id - 2 ** 23) * 10 ** (dec0 - dec1);
}

/** Bin id whose price is the largest not above `price` (token1 per token0, human units). */
export function idForPrice(price: number, binStep: number, dec0: number, dec1: number): number {
  const raw = price / 10 ** (dec0 - dec1);
  return Math.floor(Math.log(raw) / Math.log(1 + binStep / 10_000) + 1e-9) + 2 ** 23;
}
