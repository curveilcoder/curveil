/**
 * Pure decoding of launch events (factory, bonding curves, LP escrow) into database rows.
 * No I/O, so it is unit-tested with synthetic logs (see launch.test.ts).
 */
import { decodeEventLog, getAddress, type Abi, type Hex } from "viem";
import launchFactoryAbiJson from "@curveil/manifest/abis/LaunchFactory.json";
import bondingCurveAbiJson from "@curveil/manifest/abis/BondingCurve.json";
import lpEscrowAbiJson from "@curveil/manifest/abis/LpEscrow.json";
import templateRegistryAbiJson from "@curveil/manifest/abis/LaunchTemplateRegistry.json";
import type { RpcLog } from "./rpc";

export const launchFactoryAbi = launchFactoryAbiJson as Abi;
export const bondingCurveAbi = bondingCurveAbiJson as Abi;
export const lpEscrowAbi = lpEscrowAbiJson as Abi;
export const templateRegistryAbi = templateRegistryAbiJson as Abi;

/** BondingCurve.State, in enum order. */
export const CURVE_STATES = ["created", "trading", "graduation_ready", "graduated"] as const;
export type CurveState = (typeof CURVE_STATES)[number];
/** BondingCurve.Bucket, in enum order. */
export const FEE_BUCKETS = ["creator", "operator", "protocol"] as const;

export type LaunchRow = {
  token: string;
  curve: string;
  creator: string;
  creatorRecipient: string;
  templateId: number;
  name: string;
  symbol: string;
  metadataUri: string;
  createdBlock: number;
  createdTx: string;
  timestamp: number;
  blockHash: string;
};

/** What the decoder needs to know about each curve it may see logs from. */
export type CurveInfo = { token: string; quoteDecimals: number };

type Meta = { txHash: string; logIndex: number; blockNumber: number; blockHash: string; timestamp: number };

export type CurveTradeRow = Meta & {
  token: string;
  trader: string;
  recipient: string;
  isBuy: boolean;
  quoteAmount: string;
  tokenAmount: string;
  fee: string;
  reserveAfter: string;
  virtualBaseAfter: string;
  quoteValue: number;
};

export type LaunchEventRow = Meta & {
  token: string;
  kind: "state" | "graduated" | "fees_claimed" | "recipient_set";
  data: Record<string, string | number>;
};

export type EscrowRow = Meta & {
  lockId: number;
  kind: "created" | "claimed" | "fees_claimed" | "transferred";
  lpToken: string | null;
  beneficiary: string;
  counterparty: string | null;
  amount: string | null;
  amount0: string | null;
  amount1: string | null;
  unlockAt: number | null;
};

const num = (h: string) => Number(BigInt(h));

function meta(log: RpcLog, timestamps: Map<number, number>): Meta {
  const blockNumber = num(log.blockNumber);
  return {
    txHash: log.transactionHash,
    logIndex: num(log.logIndex),
    blockNumber,
    blockHash: log.blockHash,
    timestamp: timestamps.get(blockNumber) ?? 0,
  };
}

export function decodeLaunchCreated(logs: RpcLog[], factory: string, timestamps: Map<number, number>): LaunchRow[] {
  const out: LaunchRow[] = [];
  const f = getAddress(factory);
  for (const log of logs) {
    if (log.removed || getAddress(log.address) !== f) continue;
    const ev = tryDecode(launchFactoryAbi, log);
    if (ev?.eventName !== "LaunchCreated") continue;
    const a = ev.args as Record<string, unknown>;
    const m = meta(log, timestamps);
    out.push({
      token: getAddress(a.token as string),
      curve: getAddress(a.curve as string),
      creator: getAddress(a.creator as string),
      creatorRecipient: getAddress(a.creatorRecipient as string),
      templateId: Number(a.templateId),
      name: String(a.name),
      symbol: String(a.symbol),
      metadataUri: String(a.metadataURI),
      createdBlock: m.blockNumber,
      createdTx: m.txHash,
      timestamp: m.timestamp,
      blockHash: m.blockHash,
    });
  }
  return out;
}

export function decodeCurveLogs(
  logs: RpcLog[],
  curves: Map<string, CurveInfo>,
  timestamps: Map<number, number>,
): { trades: CurveTradeRow[]; events: LaunchEventRow[] } {
  const trades: CurveTradeRow[] = [];
  const events: LaunchEventRow[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    const curve = curves.get(getAddress(log.address));
    if (!curve) continue;
    const ev = tryDecode(bondingCurveAbi, log);
    if (!ev) continue;
    const m = { ...meta(log, timestamps), token: curve.token };
    const a = ev.args as Record<string, unknown>;
    switch (ev.eventName) {
      case "Trade": {
        const quote = a.quoteAmount as bigint;
        trades.push({
          ...m,
          trader: getAddress(a.trader as string),
          recipient: getAddress(a.to as string),
          isBuy: Boolean(a.isBuy),
          quoteAmount: quote.toString(),
          tokenAmount: String(a.tokenAmount),
          fee: String(a.fee),
          reserveAfter: String(a.reserveAfter),
          virtualBaseAfter: String(a.virtualBaseAfter),
          quoteValue: Number(quote) / 10 ** curve.quoteDecimals,
        });
        break;
      }
      case "StateChanged":
        events.push({ ...m, kind: "state", data: { state: CURVE_STATES[Number(a.state)] ?? String(a.state) } });
        break;
      case "Graduated":
        events.push({
          ...m,
          kind: "graduated",
          data: {
            pool: getAddress(a.pool as string),
            tokenAmount: String(a.tokenAmount),
            quoteAmount: String(a.quoteAmount),
            liquidity: String(a.liquidity),
            creatorLockId: Number(a.creatorLockId),
            protocolLockId: Number(a.protocolLockId),
          },
        });
        break;
      case "FeesClaimed":
        events.push({
          ...m,
          kind: "fees_claimed",
          data: {
            bucket: FEE_BUCKETS[Number(a.bucket)] ?? String(a.bucket),
            recipient: getAddress(a.recipient as string),
            amount: String(a.amount),
          },
        });
        break;
      case "CreatorRecipientSet":
        events.push({ ...m, kind: "recipient_set", data: { recipient: getAddress(a.recipient as string) } });
        break;
      default:
        break;
    }
  }
  return { trades, events };
}

export function decodeEscrowLogs(logs: RpcLog[], escrow: string, timestamps: Map<number, number>): EscrowRow[] {
  const out: EscrowRow[] = [];
  const e = getAddress(escrow);
  for (const log of logs) {
    if (log.removed || getAddress(log.address) !== e) continue;
    const ev = tryDecode(lpEscrowAbi, log);
    if (!ev) continue;
    const a = ev.args as Record<string, unknown>;
    const base = { ...meta(log, timestamps), lockId: Number(a.id), lpToken: null, counterparty: null, amount: null, amount0: null, amount1: null, unlockAt: null };
    switch (ev.eventName) {
      case "LockCreated":
        out.push({
          ...base,
          kind: "created",
          lpToken: getAddress(a.lpToken as string),
          beneficiary: getAddress(a.beneficiary as string),
          amount: String(a.amount),
          unlockAt: Number(a.unlockAt),
        });
        break;
      case "LockClaimed":
        out.push({
          ...base,
          kind: "claimed",
          beneficiary: getAddress(a.beneficiary as string),
          counterparty: getAddress(a.to as string),
          amount: String(a.amount),
        });
        break;
      case "LockFeesClaimed":
        out.push({
          ...base,
          kind: "fees_claimed",
          beneficiary: getAddress(a.beneficiary as string),
          counterparty: getAddress(a.to as string),
          amount0: String(a.amount0),
          amount1: String(a.amount1),
        });
        break;
      case "BeneficiaryTransferred":
        out.push({ ...base, kind: "transferred", beneficiary: getAddress(a.to as string), counterparty: getAddress(a.from as string) });
        break;
      default:
        break;
    }
  }
  return out;
}

/** True when a log from the template registry changes the template list. */
export function touchesTemplates(logs: RpcLog[], registry: string): boolean {
  const r = getAddress(registry);
  return logs.some((l) => !l.removed && getAddress(l.address) === r);
}

/**
 * Curve price and progress from raw reserves. Price is quote per token in human units:
 * (initialVirtualQuote + reserve) / virtualBase, scaled by the decimals difference.
 */
export function curveMetrics(p: {
  virtualQuote: bigint;
  virtualBase: bigint;
  initialVirtualBase: bigint;
  reserve: bigint;
  threshold: bigint;
  totalSupply: bigint;
  tokenDecimals: number;
  quoteDecimals: number;
}) {
  const scale = 10 ** (p.tokenDecimals - p.quoteDecimals);
  const price = p.virtualBase > 0n ? (Number(p.virtualQuote + p.reserve) / Number(p.virtualBase)) * scale : null;
  const progressBps = p.reserve >= p.threshold ? 10_000 : Number((p.reserve * 10_000n) / p.threshold);
  const circulating = p.initialVirtualBase - p.virtualBase;
  return {
    price,
    marketCap: price === null ? null : (price * Number(p.totalSupply)) / 10 ** p.tokenDecimals,
    progressBps,
    reserve: Number(p.reserve) / 10 ** p.quoteDecimals,
    circulating: circulating.toString(),
  };
}

function tryDecode(abi: Abi, log: RpcLog): { eventName: string; args: unknown } | null {
  try {
    const ev = decodeEventLog({ abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    return { eventName: String(ev.eventName), args: ev.args };
  } catch {
    return null;
  }
}
