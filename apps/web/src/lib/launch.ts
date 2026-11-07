import { useQuery } from "@tanstack/react-query";
import { API_URL } from "./config";
import { ApiError, getJson } from "./api";
import { tNow, useT } from "./i18n";

export type CurveState = "created" | "trading" | "graduation_ready" | "graduated";

export const STATE_LABEL: Record<CurveState, string> = {
  created: "New",
  trading: "Trading",
  graduation_ready: "Ready to graduate",
  graduated: "Graduated",
};

export const STATE_LABEL_ZH: Record<CurveState, string> = {
  created: "新发行",
  trading: "交易中",
  graduation_ready: "可毕业",
  graduated: "已毕业",
};

export type Template = {
  id: number;
  label: string;
  enabled: boolean;
  quote: { address: `0x${string}`; symbol: string; decimals: number };
  totalSupply: string;
  curveSupply: string;
  migrationSupply: string;
  graduationThreshold: string;
  graduationThresholdQuote: number;
  virtualQuote: string;
  virtualBase: string;
  feeBps: number;
  creatorFeeShareBps: number;
  damm: { tier: number; baseFeeBps: number; maxFeeBps: number };
  priceToleranceBps: number;
  creatorLpBps: number;
  creatorLockSeconds: number;
  protocolLockSeconds: number;
  protocolFeeRecipient: string;
  protocolLpRecipient: string;
  startPrice: number;
  migrationPrice: number;
  startMarketCap: number;
  migrationMarketCap: number;
};

export type Launch = {
  token: `0x${string}`;
  curve: `0x${string}`;
  name: string;
  symbol: string;
  metadataUri: string;
  image: string | null;
  creator: string;
  /** The launchpad (operator) this token launched on, and its share fixed at creation. */
  operator: `0x${string}` | null;
  operatorShareBps: number | null;
  templateId: number;
  templateLabel: string | null;
  quote: { address: `0x${string}`; symbol: string; decimals: number } | null;
  state: CurveState;
  progressBps: number;
  reserveQuote: number;
  price: number | null;
  marketCap: number | null;
  pool: `0x${string}` | null;
  volume24hQuote: number;
  trades24h: number;
  trades: number;
  lastTradeAt: number | null;
  createdAt: number;
  createdBlock: number;
  createdTx: string;
};

export type Lock = {
  id: number;
  lpToken: `0x${string}`;
  beneficiary: `0x${string}`;
  unlockAt: number;
  claimed: boolean;
  amount: string;
  pendingFees0: string;
  pendingFees1: string;
  underlying0: string;
  underlying1: string;
  pool: { token0: { address: string; symbol: string; decimals: number }; token1: { address: string; symbol: string; decimals: number } } | null;
  launch?: { token: string; symbol: string } | null;
};

export type TokenMetadata = {
  description: string;
  website: string | null;
  x: string | null;
  telegram: string | null;
  image: { sha256: string; type: string; bytes: number } | null;
};

export type LaunchDetail = {
  launch: Launch & { creatorRecipient: `0x${string}`; fees: { creator: string; operator: string; protocol: string } };
  template: Template | null;
  graduation: { pool: string; tokenAmount: string; quoteAmount: string; liquidity: string; creatorLockId: number; protocolLockId: number; txHash: string; timestamp: number } | null;
  locks: Lock[];
  metadata: TokenMetadata | null;
};

export type CurveTrade = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  trader: string;
  recipient: string;
  isBuy: boolean;
  quoteAmount: string;
  tokenAmount: string;
  fee: string;
  quoteValue: number;
  reserveAfter: string;
  priceAfter: number | null;
  finality: "sequencer" | "final";
};

export function useTemplates() {
  return useQuery({ queryKey: ["launch-templates"], queryFn: () => getJson<{ factory: string | null; templates: Template[] }>("/v1/launches/templates"), staleTime: 60_000 });
}

export function useLaunches(sort: string) {
  return useQuery({
    queryKey: ["launches", sort],
    queryFn: () => getJson<{ launches: Launch[] }>(`/v1/launches?sort=${sort}&limit=200`).then((r) => r.launches),
    refetchInterval: 8_000,
  });
}

/** Launches created by one address, newest first. */
export function useLaunchesBy(creator: string | undefined) {
  return useQuery({
    queryKey: ["launches-by", creator?.toLowerCase()],
    queryFn: () => getJson<{ launches: Launch[] }>(`/v1/launches?creator=${creator}&limit=200`).then((r) => r.launches),
    enabled: Boolean(creator),
    refetchInterval: 15_000,
  });
}

export function useLaunch(token: string, enabled = true) {
  return useQuery({ queryKey: ["launch", token.toLowerCase()], queryFn: () => getJson<LaunchDetail>(`/v1/launches/${token}`), refetchInterval: 8_000, retry: 1, enabled });
}

export function useLaunchTrades(token: string) {
  return useQuery({
    queryKey: ["launch-trades", token.toLowerCase()],
    queryFn: () => getJson<{ trades: CurveTrade[] }>(`/v1/launches/${token}/trades?limit=200`).then((r) => r.trades),
    refetchInterval: 6_000,
  });
}

export function useEscrow(owner: string | undefined) {
  return useQuery({
    queryKey: ["escrow", owner],
    queryFn: () => getJson<{ locks: Lock[] }>(`/v1/escrow/${owner}`).then((r) => r.locks),
    enabled: Boolean(owner),
    refetchInterval: 15_000,
  });
}

/** Stores description, links and image; returns the content-addressed URI to put on-chain. */
export async function uploadMetadata(input: { description: string; website: string; x: string; telegram: string; image: string | null }): Promise<string> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/launches/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError(tNow("The Curveil API could not be reached to store the token details.", "无法连接 Curveil API 来保存代币信息。"));
  }
  const j = (await r.json().catch(() => ({}))) as { uri?: string; message?: string };
  if (!r.ok || !j.uri) throw new ApiError(j.message ?? `The Curveil API answered ${r.status}.`);
  return j.uri;
}

// ------------------------------------------------------------------ curve math (mirrors BondingCurve)

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Fresh-curve buy, for previewing a creator's initial buy before the curve exists. */
export function previewInitialBuy(t: Template, quoteIn: bigint): { tokensOut: bigint; fee: bigint; quoteUsed: bigint } | null {
  if (quoteIn <= 0n) return null;
  const vq = BigInt(t.virtualQuote);
  const vb = BigInt(t.virtualBase);
  const threshold = BigInt(t.graduationThreshold);
  const fb = BigInt(t.feeBps);
  let fee = ceilDiv(quoteIn * fb, BPS);
  let net = quoteIn - fee;
  let quoteUsed = quoteIn;
  const completes = net >= threshold;
  if (completes) {
    net = threshold;
    quoteUsed = ceilDiv(threshold * BPS, BPS - fb);
    fee = quoteUsed - net;
  }
  const newBase = ceilDiv(vb * vq, vq + net);
  let tokensOut = vb - newBase;
  const inv = BigInt(t.curveSupply);
  if (completes || tokensOut > inv) tokensOut = inv;
  return { tokensOut, fee, quoteUsed };
}

export function lockDuration(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return tNow(`${seconds / 86_400} days`, `${seconds / 86_400} 天`);
  if (seconds >= 3600 && seconds % 3600 === 0) return tNow(`${seconds / 3600} hours`, `${seconds / 3600} 小时`);
  if (seconds >= 60) return tNow(`${Math.round(seconds / 60)} minutes`, `${Math.round(seconds / 60)} 分钟`);
  return tNow(`${seconds} seconds`, `${seconds} 秒`);
}

export function untilLabel(ts: number): string {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return tNow("unlocked", "已解锁");
  if (s < 3600) return tNow(`in ${Math.ceil(s / 60)} min`, `${Math.ceil(s / 60)} 分钟后`);
  if (s < 86_400) return tNow(`in ${Math.round(s / 3600)} h`, `${Math.round(s / 3600)} 小时后`);
  return tNow(`in ${Math.round(s / 86_400)} days`, `${Math.round(s / 86_400)} 天后`);
}

const createdKey = (token: string) => `curveil-new-launch:${token.toLowerCase()}`;
/** Remembers, for a few minutes, that this browser just created the launch or pool. */
export function markCreated(token: string) {
  try { sessionStorage.setItem(createdKey(token), String(Date.now())); } catch { /* private mode */ }
}
/** True for a launch or pool this browser created in the last three minutes, which may not be indexed yet. */
export function justCreated(token: string): boolean {
  try { return Date.now() - Number(sessionStorage.getItem(createdKey(token)) ?? 0) < 180_000; } catch { return false; }
}
