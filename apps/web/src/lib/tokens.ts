import { useMemo } from "react";
import { useBalance, useConnection, useReadContracts } from "wagmi";
import { curveilChain, manifest } from "./config";
import { parseEventLogs, erc20Abi as erc20Events, type TransactionReceipt } from "viem";
import type { TxStep } from "./tx";
import { erc20Abi } from "./abis";
import { useMarkets, type MarketPool } from "./markets";

export type Tok = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Full name, when known. */
  name?: string | null;
  /** Official logo served by this site, or a launch token's own image from the Curveil API. */
  logo?: string | null;
  /** Native ETH: wrapped to WETH before it reaches a pool, unwrapped on the way out. */
  native?: boolean;
};

const lc = (a: string) => a.toLowerCase();
const MAX_UINT = 2n ** 256n - 1n;
export const same = (a: string | undefined, b: string | undefined) => Boolean(a && b && lc(a) === lc(b));

/** The placeholder address wallets and aggregators use for the chain's native coin. */
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;
const wethAsset = manifest.assets.find((a) => a.label === "WETH");
export const WETH = wethAsset?.address as `0x${string}` | undefined;
export const ETH: Tok | null = WETH ? { address: NATIVE, symbol: "ETH", name: "Ether", decimals: 18, logo: "/tokens/eth.png", native: true } : null;
export const isNative = (a: string | undefined) => same(a, NATIVE);
export const wethAbi = [
  { type: "function", name: "deposit", inputs: [], outputs: [], stateMutability: "payable" },
  { type: "function", name: "withdraw", inputs: [{ name: "wad", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
] as const;
/** The symbol to show for a quote token: WETH is paid and shown as ETH. */
export const quoteSym = (q: { address?: string; symbol: string } | null | undefined, fallback = "quote") =>
  !q ? fallback : WETH && same(q.address, WETH) ? "ETH" : q.symbol;

/** ETH kept back for gas when a form fills in a maximum ETH amount. */
export const GAS_RESERVE = 500_000_000_000_000n; // 0.0005 ETH

/** Steps that wrap ETH into WETH and unwrap it again. */
export const wrapStep = (amount: bigint, label = `Wrap ETH`): TxStep => ({
  label,
  // The generated write types do not carry `value` for this ABI, so the params are cast.
  params: { address: WETH!, abi: wethAbi, functionName: "deposit", value: amount, chainId: curveilChain.id } as unknown as TxStep["params"],
});
export const unwrapStep = (amount: bigint, label = `Unwrap WETH to ETH`): TxStep => ({
  label,
  params: { address: WETH!, abi: wethAbi, functionName: "withdraw", args: [amount], chainId: curveilChain.id },
});
/** WETH a transaction paid to `to`, read from its Transfer logs. */
export const wethReceived = (receipt: TransactionReceipt, to: string) =>
  parseEventLogs({ abi: erc20Events, eventName: "Transfer", logs: receipt.logs })
    .filter((l) => same(l.address, WETH) && same(l.args.to, to))
    .reduce((sum, l) => sum + l.args.value, 0n);

/** The token a pool holds for `a`: ETH trades as WETH. */
export const poolToken = (a: `0x${string}`): `0x${string}` => (isNative(a) && WETH ? WETH : a);

const assetByAddress = new Map(manifest.assets.map((a) => [lc(a.address), a]));

/** Logo and full name for any token: the manifest's admitted assets first, then what the API gives. */
export function tokenLook(t: { address: string; symbol: string; name?: string | null; image?: string | null; logo?: string | null }) {
  if (isNative(t.address)) return { logo: ETH?.logo ?? null, name: ETH?.name ?? "Ether" };
  const a = assetByAddress.get(lc(t.address));
  return { logo: a?.logo ?? t.logo ?? t.image ?? null, name: a?.name ?? t.name ?? null };
}

/**
 * Admitted assets from the manifest plus any token that appears in an indexed pool. With
 * `eth`, native ETH comes first: it is wrapped to WETH for the trade.
 */
export function useTokens(opts: { eth?: boolean } = {}): Tok[] {
  const markets = useMarkets();
  return useMemo(() => {
    const out = new Map<string, Tok>();
    if (opts.eth && ETH) out.set(lc(NATIVE), ETH);
    for (const a of manifest.assets) out.set(lc(a.address), { address: a.address as `0x${string}`, symbol: a.symbol, decimals: a.decimals, name: a.name ?? null, logo: a.logo ?? null });
    for (const p of markets.data ?? []) {
      for (const t of [p.token0, p.token1]) {
        if (!out.has(lc(t.address))) out.set(lc(t.address), { address: t.address, symbol: t.symbol, decimals: t.decimals, ...tokenLook(t) });
      }
    }
    return [...out.values()];
  }, [markets.data, opts.eth]);
}

export const poolHas = (p: MarketPool, t: string) => same(p.token0.address, t) || same(p.token1.address, t);
export const poolOther = (p: MarketPool, t: string) => (same(p.token0.address, t) ? p.token1 : p.token0);

/**
 * Wallet balance of each token and, when a spender is given, the allowance granted to it.
 * Reads straight from the chain so approvals are never inferred.
 */
export function useWalletTokens(tokens: (`0x${string}` | undefined)[], spender?: `0x${string}`) {
  const { address } = useConnection();
  const wantsEth = tokens.some((t) => isNative(t));
  const eth = useBalance({ address, query: { enabled: Boolean(address && wantsEth), refetchInterval: 15_000 } });
  const list = tokens.filter((t): t is `0x${string}` => Boolean(t) && !isNative(t));
  const stride = spender ? 2 : 1;
  const reads = useReadContracts({
    allowFailure: false,
    query: { enabled: Boolean(address && list.length), refetchInterval: 15_000 },
    contracts: address
      ? list.flatMap((t) => [
          { address: t, abi: erc20Abi, functionName: "balanceOf", args: [address] } as const,
          ...(spender ? [{ address: t, abi: erc20Abi, functionName: "allowance", args: [address, spender] } as const] : []),
        ])
      : [],
  });
  const get = (t: string | undefined) => {
    // Native ETH needs no approval: it is sent with the transaction.
    if (isNative(t)) return { balance: eth.data?.value, allowance: eth.data ? MAX_UINT : undefined };
    const i = list.findIndex((x) => same(x, t));
    if (i < 0 || !reads.data) return { balance: undefined, allowance: undefined };
    return { balance: reads.data[i * stride] as bigint | undefined, allowance: spender ? (reads.data[i * stride + 1] as bigint | undefined) : undefined };
  };
  const refetch = async () => {
    await Promise.all([reads.refetch(), wantsEth ? eth.refetch() : null]);
  };
  return { get, refetch, isLoading: reads.isLoading || (wantsEth && eth.isLoading) };
}

/** Seconds-based deadline the contracts check against block.timestamp. */
export const deadlineIn = (minutes: number) => BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
