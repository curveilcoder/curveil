/**
 * Execute submissions against the contract fixture (real arguments the pool accepts with real
 * proofs in ShieldedExecute.t.sol): shape checks, fee terms and output-token resolution.
 */
import { decodeFunctionData, encodeAbiParameters, getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import fixture from "../../../packages/contracts/test/fixtures/execute.json";
import { FEE_MULTIPLIER, Rejected, outputPlan, outputTokens, parseExecute, perpsOutputTokens, prepareExecute, shieldedPoolAbi } from "./actions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx = fixture as any;
const ME = getAddress(fx.broadcaster) as Address;
const USDG = getAddress(fx.usdg) as Address;
const WETH = getAddress(fx.weth) as Address;
const adapters = new Set([getAddress(fx.swapAdapter), getAddress(fx.liquidityAdapter)] as Address[]);
const fees = new Map<Address, bigint>([[USDG, 50_000n], [WETH, 40_000_000_000_000n]]);
// The fixture's deadline is far in the future; "now" only has to be before it.
const NOW = 1_800_000_000;
const body = (k: string) => ({ action: "execute", args: fx[k] });
const tokens: [Address, Address] = [getAddress(fx.token0), getAddress(fx.token1)];

describe("execute submissions", () => {
  it("accepts a DLMM entry whose leg pays the fee, and encodes the same call", () => {
    const args = parseExecute(body("dlmmEntry"), adapters, NOW);
    const plan = outputPlan("liquidity", args.params);
    expect(plan).toEqual({ kind: "entry", market: getAddress(fx.dlmmPair) });
    const out = outputTokens(plan, tokens, args.outputs.length);
    expect(out).toEqual([null, ...tokens]);
    const p = prepareExecute(args, out, ME, fees);
    expect(p).toMatchObject({ action: "execute", feeToken: USDG, fee: 250_000n });
    expect(p.nullifiers).toHaveLength(4);
    const decoded = decodeFunctionData({ abi: shieldedPoolAbi, data: p.data });
    expect(decoded.functionName).toBe("execute");
  });

  it("takes an exit's fee from the output it is paid in", () => {
    const args = parseExecute(body("dammExit"), adapters, NOW);
    const plan = outputPlan("liquidity", args.params);
    expect(plan).toEqual({ kind: "exit", positionId: BigInt(fx.positions.p1) });
    const p = prepareExecute(args, outputTokens(plan, tokens, args.outputs.length), ME, fees);
    expect(p).toMatchObject({ feeToken: USDG, fee: 300_000n });
  });

  it("reads a swap's output token from the route", () => {
    const args = parseExecute(body("swap"), adapters, NOW);
    expect(outputPlan("swap", args.params)).toEqual({ kind: "swap", tokenOut: WETH });
    expect(prepareExecute(args, [WETH], ME, fees)).toMatchObject({ feeToken: USDG, fee: 500_000n });
  });

  it("refuses unpaid, underpaid, misdirected and malformed submissions", () => {
    // Self-submitted actions pay no fee.
    const free = parseExecute(body("bobExit"), adapters, NOW);
    expect(() => prepareExecute(free, tokens, ME, fees)).toThrow(Rejected);
    // Above the withdraw rate but below the execute rate.
    const swap = parseExecute(body("swap"), adapters, NOW);
    const pricey = new Map(fees);
    pricey.set(USDG, 500_000n / FEE_MULTIPLIER.execute + 1n);
    expect(() => prepareExecute(swap, [WETH], ME, pricey)).toThrow(/rate/);
    expect(() => prepareExecute(swap, [WETH], getAddress("0x00000000000000000000000000000000000000ff"), fees)).toThrow(/different address/);
    expect(() => parseExecute({ action: "execute", args: { ...fx.swap, adapter: fx.mockAdapter } }, adapters, NOW)).toThrow(/adapter/);
    expect(() => parseExecute(body("swap"), adapters, Number(fx.swap.deadline))).toThrow(/deadline/);
    const twice = { ...fx.dlmmEntry, legs: [fx.dlmmEntry.legs[0], fx.dlmmEntry.legs[0]] };
    expect(() => parseExecute({ action: "execute", args: twice }, adapters, NOW)).toThrow(/two legs/);
    const publicWithNote = { ...fx.bobExit, outputs: [{ ...fx.bobExit.outputs[0], encryptedNote: fx.swap.outputs[0].encryptedNote }, fx.bobExit.outputs[1]] };
    expect(() => parseExecute({ action: "execute", args: publicWithNote }, adapters, NOW)).toThrow(/public/);
  });
});

describe("shielded perps outputs", () => {
  const USDG = "0xB80877C55B95A3998412cb0ddf40E643EDa3F102" as const;
  const env = (op: number, body: `0x${string}`) => encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [op, body]);
  const collect = (keep: boolean) => env(6, encodeAbiParameters([{ type: "tuple", components: [{ type: "uint256" }, { type: "bool" }] }], [[7n, keep]]));

  it("knows which outputs pay USDG", () => {
    expect(perpsOutputTokens(env(1, "0x"), 1, USDG)).toEqual([null]);
    expect(perpsOutputTokens(env(2, "0x"), 2, USDG)).toEqual([null, USDG]);
    expect(perpsOutputTokens(env(4, "0x"), 1, USDG)).toEqual([null]);
    expect(perpsOutputTokens(collect(false), 1, USDG)).toEqual([USDG]);
    expect(perpsOutputTokens(collect(true), 2, USDG)).toEqual([null, USDG]);
  });

  it("refuses an output count the adapter will not produce", () => {
    expect(() => perpsOutputTokens(env(1, "0x"), 2, USDG)).toThrow(Rejected);
    expect(() => perpsOutputTokens(collect(true), 1, USDG)).toThrow(Rejected);
    expect(() => perpsOutputTokens(env(9, "0x"), 1, USDG)).toThrow(Rejected);
  });
});
