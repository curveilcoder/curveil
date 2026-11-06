/**
 * Perps data for the web app: live markets, positions, orders and the liquidity vault from the
 * API (which reads them from the chain), plus the arithmetic the order panel shows before a
 * trade. Prices are USD per unit with 18 decimals; sizes and collateral are USDG base units.
 */
import { useQuery } from "@tanstack/react-query";
import type { Abi, Address, Hex } from "viem";
import engineAbiJson from "@curveil/manifest/abis/PerpEngine.json";
import ordersAbiJson from "@curveil/manifest/abis/OrderManager.json";
import perpVaultAbiJson from "@curveil/manifest/abis/PerpLiquidityVault.json";
import { API_URL, manifest } from "./config";
import { getJson } from "./api";

export const perpEngineAbi = engineAbiJson as Abi;
export const orderManagerAbi = ordersAbiJson as Abi;
export const perpVaultAbi = perpVaultAbiJson as Abi;

export const PERP_ENGINE = manifest.contracts.PerpEngine?.address as Address | undefined;
export const ORDER_MANAGER = manifest.contracts.OrderManager?.address as Address | undefined;
export const PERP_VAULT = manifest.contracts.PerpLiquidityVault?.address as Address | undefined;
export const PERPS_ADAPTER = manifest.contracts.ShieldedPerpsAdapter?.address as Address | undefined;
export const PERPS_DEPLOYED = Boolean(PERP_ENGINE && ORDER_MANAGER && PERP_VAULT);

export const BPS = 10_000n;
export const WAD = 10n ** 18n;
export const USDG_DECIMALS = 6;
export const LEVERAGES = [1, 2, 3, 5] as const;
export const SLIPPAGES_BPS = [30, 100, 200] as const;

export type MarketConfig = {
  feedId: Hex;
  enabled: boolean;
  maxLeverageBps: number;
  maintenanceMarginBps: number;
  openFeeBps: number;
  closeFeeBps: number;
  liquidationFeeBps: number;
  maxProfitBps: number;
  maxOpenInterestLong: string;
  maxOpenInterestShort: string;
  minCollateral: string;
  maxFundingRatePerHour: string;
};

export type PerpMarket = {
  id: number;
  symbol: string;
  base: string;
  feed: string;
  feedId: Hex;
  config: MarketConfig | null;
  state: { oiLong: string; oiShort: string; reservedLong: string; reservedShort: string; fundingRate: string; fundingUpdatedAt: string } | null;
  fundingRatePerHour: string;
  markPrice: string | null;
  markSources: string[];
  recordedPrice: { price: string; priceWad: string; timestamp: number; ageSeconds: number | null } | null;
  volume24h: string;
  trades24h: number;
};

export type PerpsOverview = {
  network: string;
  collateral: { address: Address; decimals: number };
  priceSource: string;
  priceSigner: Address | null;
  contracts: { engine: Address; orderManager: Address; oracle: Address; vault: Address; lens: Address; adapter: Address | null };
  params: {
    minExecutionFee: string;
    requestTimeout: number;
    navMaxAge: number;
    protocolShareBps: number;
    totalReserved: string;
    totalCollateral: string;
    pendingRequests: string | null;
    openPositions: string | null;
  };
  vault: {
    address: Address;
    totalAssets: string | null;
    freeLiquidity: string | null;
    capacity: string | null;
    totalSupply: string | null;
    maxUtilizationBps: number;
    lockSeconds: number;
    depositCap: string;
    balance: string | null;
    sharePrice: number | null;
  };
  markets: PerpMarket[];
};

export type LivePosition = {
  id: string;
  owner: Address;
  market: number;
  symbol: string | null;
  isLong: boolean;
  status: "pending" | "open" | "closed" | "liquidated" | "cancelled";
  version: number;
  openedAt: number;
  size: string;
  collateral: string;
  reserve: string;
  entryPrice: string;
  pendingClose: string;
  paidOut: string;
  markPrice: string | null;
  valuation: { pnl: string; funding: string; equity: string; liquidatable: boolean; liquidationPrice: string } | null;
};

export type RequestRow = {
  request_id: string;
  position_id: string;
  kind: "open" | "close";
  market_id: number;
  is_long: number;
  size: string;
  collateral: string;
  acceptable_price: string;
  execution_fee: string;
  created_at: number;
  tx_hash: string;
  outcome: "executed" | "cancelled" | null;
  price: string | null;
  reason: string | null;
  fee_charged: string | null;
  settled_at: number | null;
};

export type OrderRow = {
  order_id: string;
  position_id: string;
  kind: "take_profit" | "stop_loss";
  trigger_price: string;
  size: string;
  acceptable_price: string;
  execution_fee: string;
  expires_at: number;
  placed_at: number;
  tx_hash: string;
  outcome: "executed" | "cancelled" | null;
  price: string | null;
  size_closed: string | null;
  reason: string | null;
  status: "active" | "filled" | "cancelled" | null;
};

export function usePerpsOverview() {
  return useQuery({ queryKey: ["perps"], enabled: PERPS_DEPLOYED, queryFn: () => getJson<PerpsOverview>("/v1/perps/markets"), refetchInterval: 5_000 });
}

export function usePerpPositions(owner: string | undefined) {
  return useQuery({
    queryKey: ["perp-positions", owner],
    enabled: Boolean(owner && PERPS_DEPLOYED),
    queryFn: () => getJson<{ positions: LivePosition[]; requests: RequestRow[] }>(`/v1/perps/positions/${owner}`),
    refetchInterval: 5_000,
  });
}

export function usePerpOrders(owner: string | undefined) {
  return useQuery({
    queryKey: ["perp-orders", owner],
    enabled: Boolean(owner && PERPS_DEPLOYED),
    queryFn: () => getJson<{ orders: OrderRow[] }>(`/v1/perps/orders/${owner}`),
    refetchInterval: 8_000,
  });
}

export function usePerpPosition(id: string | undefined) {
  return useQuery({
    queryKey: ["perp-position", id],
    enabled: Boolean(id && PERPS_DEPLOYED),
    queryFn: () => getJson<{ position: LivePosition; orders: OrderRow[] }>(`/v1/perps/position/${id}`),
    refetchInterval: 5_000,
  });
}

export function usePerpVaultAccount(account: string | undefined) {
  return useQuery({
    queryKey: ["perp-vault", account],
    enabled: Boolean(account && PERPS_DEPLOYED),
    queryFn: () =>
      getJson<{ shares: string; value: string | null; unlockAt: number; history: { event: string; assets: string; shares: string; timestamp: number; tx_hash: string }[] }>(
        `/v1/perps/vault/${account}`,
      ),
    refetchInterval: 10_000,
  });
}

export function useFundingHistory(market: number | undefined) {
  return useQuery({
    queryKey: ["perp-funding", market],
    enabled: market !== undefined && PERPS_DEPLOYED,
    queryFn: () => getJson<{ updates: { rate: string; oi_long: string; oi_short: string; timestamp: number }[] }>(`/v1/perps/markets/${market}/funding?limit=48`),
    refetchInterval: 30_000,
  });
}

export type PerpFill = { event: "opened" | "decreased" | "liquidated"; position_id: string; price: string; size: string | null; size_delta: string | null; pnl: string | null; is_long: number; timestamp: number; tx_hash: string };

/** Oracle prices recorded on-chain for one market, oldest first. */
export function usePerpPrices(market: number | undefined, seconds: number) {
  return useQuery({
    queryKey: ["perp-prices", market, seconds],
    enabled: PERPS_DEPLOYED && market !== undefined,
    queryFn: () => getJson<{ prices: { price: string; timestamp: number }[] }>(`/v1/perps/markets/${market}/prices?seconds=${seconds}`).then((r) => r.prices),
    refetchInterval: 30_000,
  });
}

export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };
/** How far back to fetch; each range has its own candle size (5h: 1m, 1d: 5m, 3d: 15m, 12d: 1h, 75d: 6h, 290d: 1D). */
export type CandleRange = "5h" | "1d" | "3d" | "1w" | "12d" | "1m" | "75d" | "290d";

/** Reference candles (Coinbase, one of the oracle's four exchanges), oldest first. */
export function usePerpCandles(market: number | undefined, range: CandleRange) {
  return useQuery({
    queryKey: ["perp-candles", market, range],
    enabled: PERPS_DEPLOYED && market !== undefined,
    queryFn: () => getJson<{ source: string; pair: string; granularity: number; candles: Candle[] }>(`/v1/perps/markets/${market}/candles?range=${range}`),
    refetchInterval: 60_000,
    retry: 1,
  });
}

/** Recent opens, closes and liquidations in one market, newest first. */
export function usePerpActivity(market: number | undefined) {
  return useQuery({
    queryKey: ["perp-activity", market],
    enabled: PERPS_DEPLOYED && market !== undefined,
    queryFn: () => getJson<{ activity: PerpFill[] }>(`/v1/perps/markets/${market}/activity`).then((r) => r.activity),
    refetchInterval: 10_000,
  });
}

export type ApiClaim = { claimId: string; positionId: string; requestId: string; blockNumber: number; timestamp: number; txHash: string };

/** Every claim opened through the shielded adapter. Matching claims to notes happens in this browser. */
export function usePerpClaims(enabled: boolean) {
  return useQuery({
    queryKey: ["perp-claims"],
    enabled: enabled && Boolean(PERPS_ADAPTER),
    refetchInterval: 10_000,
    queryFn: async () => {
      const all: ApiClaim[] = [];
      let from = 0;
      for (let i = 0; i < 50; i++) {
        const page = await getJson<{ items: ApiClaim[]; done: boolean }>(`/v1/perps/claims?fromBlock=${from}`);
        const seen = new Set(all.map((c) => c.claimId));
        all.push(...page.items.filter((c) => !seen.has(c.claimId)));
        if (page.done || page.items.length === 0) break;
        from = page.items[page.items.length - 1]!.blockNumber;
      }
      return all;
    },
  });
}

/** Wakes the keeper so a new request executes within seconds. Best effort. */
export function kickKeeper() {
  void fetch(`${API_URL}/v1/perps/kick`, { method: "POST" }).catch(() => undefined);
}

// ------------------------------------------------------------------ arithmetic

/** "2280.155" -> 18-decimal bigint. */
export function wad(price: string | null | undefined): bigint | null {
  if (!price) return null;
  const [w, f = ""] = price.split(".");
  if (!/^\d+$/.test(w ?? "") || !/^\d*$/.test(f)) return null;
  return BigInt(w!) * WAD + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
}

/**
 * The worst price a request accepts: a long open or a short close pays at most mark + slippage;
 * a short open or a long close receives at least mark - slippage.
 */
export function acceptablePrice(mark: bigint, buying: boolean, slippageBps: number): bigint {
  const s = BigInt(slippageBps);
  return buying ? (mark * (BPS + s)) / BPS : (mark * (BPS - s)) / BPS;
}

export type OpenPreview = {
  size: bigint;
  openFee: bigint;
  collateralAfterFee: bigint;
  liquidationPrice: bigint | null;
  maxProfit: bigint;
  leverageBps: bigint;
};

/**
 * What an open at `entry` would look like (liquidation price ignores funding, which accrues
 * later). Leverage is measured on collateral after the open fee, as the engine checks it, so
 * size = L * C / (1 + L * fee): a 5x position stays within a 5x cap once the fee is taken.
 */
export function previewOpen(c: MarketConfig, isLong: boolean, collateral: bigint, leverage: number, entry: bigint): OpenPreview {
  const l100 = BigInt(Math.round(leverage * 100));
  const size = (collateral * l100 * BPS) / (100n * BPS + l100 * BigInt(c.openFeeBps));
  const openFee = (size * BigInt(c.openFeeBps)) / BPS;
  const after = collateral > openFee ? collateral - openFee : 0n;
  const buffer = (size * BigInt(c.closeFeeBps + c.maintenanceMarginBps)) / BPS;
  let liquidationPrice: bigint | null = null;
  if (size > 0n && entry > 0n) {
    const room = after - buffer; // may be negative
    liquidationPrice = isLong ? (entry * (size - room)) / size : (entry * (size + room)) / size;
    if (liquidationPrice < 0n) liquidationPrice = 0n;
  }
  return { size, openFee, collateralAfterFee: after, liquidationPrice, maxProfit: (size * BigInt(c.maxProfitBps)) / BPS, leverageBps: collateral > 0n ? (size * BPS) / collateral : 0n };
}

/** Signed USDG amount for display ("+12.34" / "-5.00"). */
export function signedUsd(v: string | bigint | null | undefined, decimals = USDG_DECIMALS): string {
  if (v === null || v === undefined) return "–";
  const n = typeof v === "bigint" ? v : BigInt(v);
  const abs = n < 0n ? -n : n;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").slice(0, 2);
  const sign = whole === 0n && frac === "00" ? "" : n < 0n ? "-" : n > 0n ? "+" : "";
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`;
}

/** Price with sensible precision: 2 decimals above 1,000, more below. */
export function fmtUsdPrice(p: string | bigint | null | undefined): string {
  if (p === null || p === undefined) return "–";
  const n = typeof p === "bigint" ? Number(p / 10n ** 12n) / 1e6 : Number(p);
  if (!Number.isFinite(n) || n === 0) return "–";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n >= 1000 ? 2 : 4 });
}

export const REASON_TEXT: Record<string, string> = {
  timeout: "nobody executed it in time; refunded in full",
  price: "the price moved past your limit; refunded less the execution fee",
  market_closed: "the market was closed",
  leverage: "the leverage was above the market's maximum",
  min_collateral: "the collateral was below the minimum after fees",
  open_interest: "the market's open interest cap was reached",
  capacity: "the liquidity vault had no room for the position's maximum profit",
  not_open: "the position was no longer open",
  liquidatable: "the position was liquidatable at that price",
};

/** Note resource of each claim (shareResource of the adapter and claim id), for matching notes locally. */
export function claimResources(claims: ApiClaim[] | undefined, adapter: Address | undefined, shareResource: (a: Address, id: bigint) => bigint) {
  const out = new Map<string, ApiClaim>();
  if (!adapter) return out;
  for (const c of claims ?? []) out.set(shareResource(adapter, BigInt(c.claimId)).toString(), c);
  return out;
}
