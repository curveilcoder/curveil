/**
 * Pure decoding of Curveil market events into database rows. No I/O, so it is unit-tested
 * with synthetic logs (see process.test.ts).
 */
import { decodeEventLog, getAddress, type Abi, type Hex } from "viem";
import dammPoolAbiJson from "@curveil/manifest/abis/DammPool.json";
import dlmmPairAbiJson from "@curveil/manifest/abis/DlmmPair.json";
import dammFactoryAbiJson from "@curveil/manifest/abis/DammFactory.json";
import dlmmFactoryAbiJson from "@curveil/manifest/abis/DlmmFactory.json";
import type { RpcLog } from "./rpc";

export const dammPoolAbi = dammPoolAbiJson as Abi;
export const dlmmPairAbi = dlmmPairAbiJson as Abi;
export const dammFactoryAbi = dammFactoryAbiJson as Abi;
export const dlmmFactoryAbi = dlmmFactoryAbiJson as Abi;

export type TokenInfo = { address: string; symbol: string; name: string; decimals: number; isQuote: boolean };

export type PoolInfo = {
  address: string;
  kind: "damm" | "dlmm";
  factory: string;
  token0: string;
  token1: string;
  feeTier: number | null;
  baseFeeBps: number;
  maxFeeBps: number | null;
  protocolShareBps: number;
  binStep: number | null;
  createdBlock: number;
  createdTx: string;
  blockHash: string;
};

/** A DLMM pair's fee config is not in its creation event; the indexer reads it from the pair. */
export type NewPool = Omit<PoolInfo, "baseFeeBps" | "protocolShareBps"> & {
  baseFeeBps: number | null;
  protocolShareBps: number | null;
};

export type SwapRow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
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
  quoteFee: number | null;
  activeIdAfter: number | null;
};

export type LiquidityRow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  pool: string;
  kind: "add" | "remove" | "claim" | "transfer_out" | "transfer_in";
  owner: string;
  counterparty: string | null;
  amount0: string;
  amount1: string;
  shares: string | null;
  bins: number[] | null;
};

const num = (h: string) => Number(BigInt(h));

export function decodeFactoryLogs(logs: RpcLog[], factories: { damm: string; dlmm: string }): NewPool[] {
  const out: NewPool[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    const addr = getAddress(log.address);
    const base = { factory: addr, createdBlock: num(log.blockNumber), createdTx: log.transactionHash, blockHash: log.blockHash };
    if (addr === getAddress(factories.damm)) {
      const ev = tryDecode(dammFactoryAbi, log);
      if (ev?.eventName !== "PoolCreated") continue;
      const a = ev.args as unknown as {
        token0: string;
        token1: string;
        pool: string;
        tier: number;
        params: { baseFeeBps: number; maxFeeBps: number; protocolShareBps: number };
      };
      out.push({
        ...base,
        address: getAddress(a.pool),
        kind: "damm",
        token0: getAddress(a.token0),
        token1: getAddress(a.token1),
        feeTier: Number(a.tier),
        baseFeeBps: Number(a.params.baseFeeBps),
        maxFeeBps: Number(a.params.maxFeeBps),
        protocolShareBps: Number(a.params.protocolShareBps),
        binStep: null,
      });
    } else if (addr === getAddress(factories.dlmm)) {
      const ev = tryDecode(dlmmFactoryAbi, log);
      if (ev?.eventName !== "PairCreated") continue;
      const a = ev.args as unknown as { tokenX: string; tokenY: string; binStep: number; pair: string };
      out.push({
        ...base,
        address: getAddress(a.pair),
        kind: "dlmm",
        token0: getAddress(a.tokenX),
        token1: getAddress(a.tokenY),
        feeTier: null,
        baseFeeBps: null,
        maxFeeBps: null,
        protocolShareBps: null,
        binStep: Number(a.binStep),
      });
    }
  }
  return out;
}

export function decodePoolLogs(
  logs: RpcLog[],
  pools: Map<string, PoolInfo>,
  tokens: Map<string, TokenInfo>,
  timestamps: Map<number, number>,
): { swaps: SwapRow[]; liquidity: LiquidityRow[] } {
  const swaps: SwapRow[] = [];
  const liquidity: LiquidityRow[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    const pool = pools.get(getAddress(log.address));
    if (!pool) continue;
    const ev = tryDecode(pool.kind === "damm" ? dammPoolAbi : dlmmPairAbi, log);
    if (!ev) continue;
    const blockNumber = num(log.blockNumber);
    const meta = {
      txHash: log.transactionHash,
      logIndex: num(log.logIndex),
      blockNumber,
      blockHash: log.blockHash,
      timestamp: timestamps.get(blockNumber) ?? 0,
      pool: pool.address,
    };
    const a = ev.args as unknown as Record<string, unknown>;
    switch (ev.eventName) {
      case "Swap": {
        const inIs0 = pool.kind === "damm" ? Boolean(a.zeroForOne) : Boolean(a.swapForY);
        const tokenIn = inIs0 ? pool.token0 : pool.token1;
        const tokenOut = inIs0 ? pool.token1 : pool.token0;
        const amountIn = a.amountIn as bigint;
        const amountOut = a.amountOut as bigint;
        const fee = a.fee as bigint;
        const { value, feeValue } = quoteValues(tokens, tokenIn, tokenOut, amountIn, amountOut, fee);
        swaps.push({
          ...meta,
          sender: getAddress(a.sender as string),
          recipient: getAddress(a.to as string),
          tokenIn,
          tokenOut,
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          fee: fee.toString(),
          protocolFee: (a.protocolFee as bigint).toString(),
          feeBps: pool.kind === "damm" ? Number(a.feeBps) : pool.baseFeeBps,
          quoteValue: value,
          quoteFee: feeValue,
          activeIdAfter: pool.kind === "dlmm" ? Number(a.activeIdAfter) : null,
        });
        break;
      }
      case "Mint":
        liquidity.push({
          ...meta,
          kind: "add",
          owner: getAddress(a.to as string),
          counterparty: getAddress(a.sender as string),
          amount0: String(a.amount0),
          amount1: String(a.amount1),
          shares: String(a.liquidity),
          bins: null,
        });
        break;
      case "Burn":
        liquidity.push({
          ...meta,
          kind: "remove",
          owner: getAddress(a.to as string),
          counterparty: getAddress(a.sender as string),
          amount0: String(a.amount0),
          amount1: String(a.amount1),
          shares: String(a.liquidity),
          bins: null,
        });
        break;
      case "FeesClaimed":
        liquidity.push({
          ...meta,
          kind: "claim",
          owner: getAddress(a.owner as string),
          counterparty: getAddress(a.to as string),
          amount0: String(pool.kind === "damm" ? a.amount0 : a.amountX),
          amount1: String(pool.kind === "damm" ? a.amount1 : a.amountY),
          shares: null,
          bins: null,
        });
        break;
      case "DepositedToBins":
      case "WithdrawnFromBins": {
        const ids = (a.ids as bigint[]).map(Number);
        const xs = a.amountsX as bigint[];
        const ys = a.amountsY as bigint[];
        const shares = a.shares as bigint[];
        const deposit = ev.eventName === "DepositedToBins";
        liquidity.push({
          ...meta,
          kind: deposit ? "add" : "remove",
          owner: getAddress((deposit ? a.to : a.owner) as string),
          counterparty: getAddress((deposit ? a.sender : a.to) as string),
          amount0: sum(xs).toString(),
          amount1: sum(ys).toString(),
          shares: sum(shares).toString(),
          bins: ids.filter((_, i) => (shares[i] ?? 0n) > 0n),
        });
        break;
      }
      case "SharesTransferred": {
        const ids = (a.ids as bigint[]).map(Number);
        const total = sum(a.shares as bigint[]).toString();
        const from = getAddress(a.from as string);
        const to = getAddress(a.to as string);
        const row = { ...meta, amount0: "0", amount1: "0", shares: total, bins: ids };
        liquidity.push({ ...row, kind: "transfer_out", owner: from, counterparty: to });
        liquidity.push({ ...row, kind: "transfer_in", owner: to, counterparty: from });
        break;
      }
      default:
        break;
    }
  }
  return { swaps, liquidity };
}

/** Trade size and fee in the quote token (USDG), when one side of the trade is the quote token. */
export function quoteValues(
  tokens: Map<string, TokenInfo>,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
  fee: bigint,
): { value: number | null; feeValue: number | null } {
  const tin = tokens.get(tokenIn);
  const tout = tokens.get(tokenOut);
  if (tin?.isQuote) {
    const s = 10 ** tin.decimals;
    return { value: Number(amountIn) / s, feeValue: Number(fee) / s };
  }
  if (tout?.isQuote && amountIn > 0n) {
    const s = 10 ** tout.decimals;
    const rate = Number(amountOut) / Number(amountIn);
    return { value: Number(amountOut) / s, feeValue: (Number(fee) * rate) / s };
  }
  return { value: null, feeValue: null };
}

/** Human price at the active bin: token1 (Y) per token0 (X). */
export function dlmmPrice(activeId: number, binStep: number, dec0: number, dec1: number): number {
  const raw = Math.pow(1 + binStep / 10_000, activeId - 2 ** 23);
  return raw * 10 ** (dec0 - dec1);
}

export function dammPrice(r0: bigint, r1: bigint, dec0: number, dec1: number): number | null {
  if (r0 === 0n) return null;
  return Number(r1) / 10 ** dec1 / (Number(r0) / 10 ** dec0);
}

function tryDecode(abi: Abi, log: RpcLog): { eventName: string; args: unknown } | null {
  try {
    const ev = decodeEventLog({ abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    return { eventName: String(ev.eventName), args: ev.args };
  } catch {
    return null;
  }
}

function sum(xs: bigint[]): bigint {
  return xs.reduce((a, b) => a + b, 0n);
}
