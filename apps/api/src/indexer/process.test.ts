import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Abi, type AbiEvent } from "viem";
import {
  dammFactoryAbi,
  dammPoolAbi,
  dlmmFactoryAbi,
  dlmmPairAbi,
  decodeFactoryLogs,
  decodePoolLogs,
  dlmmPrice,
  dammPrice,
  quoteValues,
  type PoolInfo,
  type TokenInfo,
} from "./process";
import type { RpcLog } from "./rpc";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const USDG = A(0xb808);
const WETH = A(0x229a);
const DAMM_F = A(0xf1);
const DLMM_F = A(0xf2);
const POOL = A(0x501);
const PAIR = A(0x502);
const ROUTER = A(0x777);
const ALICE = A(0xa11ce);

let logIndex = 0;
function log(abi: Abi, address: string, eventName: string, args: Record<string, unknown>, block = 100): RpcLog {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as any) as `0x${string}`[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as any);
  return {
    address: address.toLowerCase(),
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${(++logIndex).toString(16).padStart(64, "0")}`,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

const tokens = new Map<string, TokenInfo>([
  [USDG, { address: USDG, symbol: "tUSDG", name: "Test USDG", decimals: 6, isQuote: true }],
  [WETH, { address: WETH, symbol: "tWETH", name: "Test WETH", decimals: 18, isQuote: false }],
]);

const dammPool: PoolInfo = {
  address: POOL,
  kind: "damm",
  factory: DAMM_F,
  token0: WETH,
  token1: USDG,
  feeTier: 0,
  baseFeeBps: 30,
  maxFeeBps: 100,
  protocolShareBps: 2000,
  binStep: null,
  createdBlock: 1,
  createdTx: "0x",
  blockHash: "0x",
};
const dlmmPair: PoolInfo = { ...dammPool, address: PAIR, kind: "dlmm", factory: DLMM_F, feeTier: null, maxFeeBps: null, binStep: 25 };
const pools = new Map([
  [POOL, dammPool],
  [PAIR, dlmmPair],
]);

describe("factory events", () => {
  it("decodes DAMM and DLMM pool creation", () => {
    const params = {
      baseFeeBps: 30,
      maxFeeBps: 100,
      protocolShareBps: 2000,
      variableFeeControl: 2000,
      filterPeriod: 30,
      decayPeriod: 600,
      reductionBps: 5000,
      maxVolatilityBps: 5000,
    };
    const out = decodeFactoryLogs(
      [
        log(dammFactoryAbi, DAMM_F, "PoolCreated", { token0: WETH, token1: USDG, pool: POOL, tier: 0, index: 0n, params }),
        log(dlmmFactoryAbi, DLMM_F, "PairCreated", { tokenX: WETH, tokenY: USDG, binStep: 25, pair: PAIR, activeId: 8380585, index: 0n }),
        log(dlmmFactoryAbi, DLMM_F, "PresetSet", { binStep: 25, baseFeeBps: 30, enabled: true }),
      ],
      { damm: DAMM_F, dlmm: DLMM_F },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ address: POOL, kind: "damm", token0: WETH, token1: USDG, baseFeeBps: 30, maxFeeBps: 100, protocolShareBps: 2000 });
    expect(out[1]).toMatchObject({ address: PAIR, kind: "dlmm", binStep: 25, baseFeeBps: null });
  });
});

describe("pool events", () => {
  it("turns a DAMM swap into a row valued in the quote token", () => {
    const { swaps } = decodePoolLogs(
      [
        log(dammPoolAbi, POOL, "Swap", {
          sender: ROUTER,
          to: ALICE,
          zeroForOne: false, // USDG in
          amountIn: 1000_000000n,
          amountOut: 495_000000000000000n,
          fee: 3_000000n,
          protocolFee: 600000n,
          feeBps: 30,
        }),
      ],
      pools,
      tokens,
      new Map([[100, 1_700_000_000]]),
    );
    expect(swaps).toHaveLength(1);
    const s = swaps[0]!;
    expect(s.tokenIn).toBe(USDG);
    expect(s.tokenOut).toBe(WETH);
    expect(s.recipient).toBe(ALICE);
    expect(s.quoteValue).toBe(1000);
    expect(s.quoteFee).toBe(3); // the whitepaper example: 0.30% of 1,000
    expect(s.protocolFee).toBe("600000");
    expect(s.timestamp).toBe(1_700_000_000);
  });

  it("values a sell into the quote token from the output side", () => {
    const { swaps } = decodePoolLogs(
      [
        log(dlmmPairAbi, PAIR, "Swap", {
          sender: ROUTER,
          to: ALICE,
          swapForY: true, // WETH in, USDG out
          amountIn: 10n ** 18n,
          amountOut: 1990_000000n,
          fee: 3n * 10n ** 15n,
          protocolFee: 6n * 10n ** 14n,
          activeIdBefore: 8380585,
          activeIdAfter: 8380584,
        }),
      ],
      pools,
      tokens,
      new Map(),
    );
    const s = swaps[0]!;
    expect(s.tokenIn).toBe(WETH);
    expect(s.quoteValue).toBe(1990);
    expect(s.quoteFee).toBeCloseTo(5.97, 6);
    expect(s.feeBps).toBe(30);
    expect(s.activeIdAfter).toBe(8380584);
  });

  it("records DLMM deposits with the bins that received shares", () => {
    const { liquidity } = decodePoolLogs(
      [
        log(dlmmPairAbi, PAIR, "DepositedToBins", {
          sender: ROUTER,
          to: ALICE,
          ids: [10n, 11n, 12n],
          amountsX: [0n, 5n, 5n],
          amountsY: [7n, 3n, 0n],
          shares: [7n, 0n, 9n],
        }),
        log(dlmmPairAbi, PAIR, "SharesTransferred", { from: ALICE, to: ROUTER, ids: [12n], shares: [9n] }),
      ],
      pools,
      tokens,
      new Map(),
    );
    expect(liquidity[0]).toMatchObject({ kind: "add", owner: ALICE, amount0: "10", amount1: "10", shares: "16", bins: [10, 12] });
    expect(liquidity.slice(1).map((l) => [l.kind, l.owner])).toEqual([
      ["transfer_out", ALICE],
      ["transfer_in", ROUTER],
    ]);
  });

  it("ignores logs from unknown addresses and removed logs", () => {
    const stray = log(dammPoolAbi, A(0xdead), "Sync", { reserve0: 1n, reserve1: 2n });
    const removed = { ...log(dammPoolAbi, POOL, "Sync", { reserve0: 1n, reserve1: 2n }), removed: true };
    const out = decodePoolLogs([stray, removed], pools, tokens, new Map());
    expect(out.swaps).toHaveLength(0);
    expect(out.liquidity).toHaveLength(0);
  });
});

describe("prices", () => {
  it("prices a DLMM bin in human units", () => {
    // 2000 USDG per WETH at bin step 25 sits about 8023 bins below the center.
    const p = dlmmPrice(8380585, 25, 18, 6);
    expect(p).toBeGreaterThan(1990);
    expect(p).toBeLessThan(2010);
  });

  it("prices a DAMM pool from reserves", () => {
    expect(dammPrice(500n * 10n ** 18n, 1_000_000n * 10n ** 6n, 18, 6)).toBe(2000);
    expect(dammPrice(0n, 1n, 18, 6)).toBeNull();
  });

  it("has no quote value when neither side is the quote token", () => {
    const other = A(0xbbb);
    expect(quoteValues(tokens, other, WETH, 1n, 1n, 0n)).toEqual({ value: null, feeValue: null });
  });
});
