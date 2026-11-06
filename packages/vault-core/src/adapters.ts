/**
 * Parameter encoding for the shielded adapters (ShieldedSwapAdapter and
 * ShieldedLiquidityAdapter). The pool hashes these bytes into the execute context, so the
 * route, market, minimums and position id are bound by every leg's proof.
 */
import { decodeAbiParameters, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { bytesToBig, randomBytes } from "./field";

export type Hop = { pool: Address; tokenIn: Address; tokenOut: Address };

const HOPS = { type: "tuple[]", components: [{ name: "pool", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }] } as const;

/** ShieldedSwapAdapter params: abi.encode(Hop[] hops, uint256 minOut). */
export function encodeSwapParams(hops: readonly Hop[], minOut: bigint): Hex {
  return encodeAbiParameters([HOPS, { type: "uint256" }], [hops.map((h) => ({ pool: getAddress(h.pool), tokenIn: getAddress(h.tokenIn), tokenOut: getAddress(h.tokenOut) })), minOut]);
}

export function decodeSwapParams(params: Hex): { hops: Hop[]; minOut: bigint } {
  const [hops, minOut] = decodeAbiParameters([HOPS, { type: "uint256" }], params);
  return { hops: hops.map((h) => ({ pool: h.pool, tokenIn: h.tokenIn, tokenOut: h.tokenOut })), minOut };
}

export const OP_ENTER_DAMM = 1;
export const OP_ENTER_DLMM = 2;
export const OP_EXIT = 3;
/** Units carried by a new liquidity position's share note. */
export const POSITION_UNITS = 10n ** 18n;

const DAMM_ENTRY = {
  type: "tuple",
  components: [
    { name: "positionId", type: "uint256" },
    { name: "market", type: "address" },
    { name: "min0", type: "uint256" },
    { name: "min1", type: "uint256" },
    { name: "minLiquidity", type: "uint256" },
  ],
} as const;

const DLMM_ENTRY = {
  type: "tuple",
  components: [
    { name: "positionId", type: "uint256" },
    { name: "market", type: "address" },
    { name: "activeIdExpected", type: "uint24" },
    { name: "idSlippage", type: "uint24" },
    { name: "deltaIds", type: "int256[]" },
    { name: "distributionX", type: "uint256[]" },
    { name: "distributionY", type: "uint256[]" },
  ],
} as const;

const EXIT = {
  type: "tuple",
  components: [
    { name: "positionId", type: "uint256" },
    { name: "min0", type: "uint256" },
    { name: "min1", type: "uint256" },
  ],
} as const;

export type DammEntry = { positionId: bigint; market: Address; min0: bigint; min1: bigint; minLiquidity: bigint };
export type DlmmEntry = {
  positionId: bigint;
  market: Address;
  activeIdExpected: number;
  idSlippage: number;
  deltaIds: bigint[];
  distributionX: bigint[];
  distributionY: bigint[];
};
export type PositionExit = { positionId: bigint; min0: bigint; min1: bigint };

const envelope = (op: number, body: Hex): Hex => encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [op, body]);

export function encodeDammEntry(e: DammEntry): Hex {
  return envelope(OP_ENTER_DAMM, encodeAbiParameters([DAMM_ENTRY], [{ ...e, market: getAddress(e.market) }]));
}

export function encodeDlmmEntry(e: DlmmEntry): Hex {
  return envelope(OP_ENTER_DLMM, encodeAbiParameters([DLMM_ENTRY], [{ ...e, market: getAddress(e.market) }]));
}

export function encodeExit(e: PositionExit): Hex {
  return envelope(OP_EXIT, encodeAbiParameters([EXIT], [e]));
}

export type LiquidityOp =
  | { op: typeof OP_ENTER_DAMM; entry: DammEntry }
  | { op: typeof OP_ENTER_DLMM; entry: DlmmEntry }
  | { op: typeof OP_EXIT; exit: PositionExit };

export function decodeLiquidityParams(params: Hex): LiquidityOp {
  const [op, body] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], params);
  if (op === OP_ENTER_DAMM) {
    const [e] = decodeAbiParameters([DAMM_ENTRY], body);
    return { op, entry: { ...e } };
  }
  if (op === OP_ENTER_DLMM) {
    const [e] = decodeAbiParameters([DLMM_ENTRY], body);
    return { op, entry: { ...e, deltaIds: [...e.deltaIds], distributionX: [...e.distributionX], distributionY: [...e.distributionY] } };
  }
  if (op === OP_EXIT) {
    const [e] = decodeAbiParameters([EXIT], body);
    return { op, exit: { ...e } };
  }
  throw new Error(`unknown liquidity op ${op}`);
}

/** A fresh random position id (never 0). The share note's resource is derived from it. */
export function newPositionId(): bigint {
  for (;;) {
    const id = bytesToBig(randomBytes(32));
    if (id !== 0n) return id;
  }
}
