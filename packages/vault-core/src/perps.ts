/**
 * Parameter encoding for ShieldedPerpsAdapter. The pool hashes these bytes into the execute
 * context, so the market, side, size, collateral, price limit and claim id are bound by every
 * leg's proof. A position's claim is a share note of CLAIM_UNITS (1) unit whose resource is
 * shareResource(adapter, claimId).
 */
import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { newPositionId } from "./adapters";

export const PERP_OP_OPEN = 1;
export const PERP_OP_CLOSE = 2;
export const PERP_OP_ADD_COLLATERAL = 3;
export const PERP_OP_PLACE_ORDER = 4;
export const PERP_OP_CANCEL_ORDER = 5;
export const PERP_OP_COLLECT = 6;
/** Units carried by a perps claim note. */
export const CLAIM_UNITS = 1n;

/** OrderManager.Kind */
export const ORDER_TAKE_PROFIT = 1;
export const ORDER_STOP_LOSS = 2;

const u = <N extends string>(name: N) => ({ name, type: "uint256" }) as const;
const u128 = <N extends string>(name: N) => ({ name, type: "uint128" }) as const;

const OPEN = {
  type: "tuple",
  components: [u("claimId"), { name: "market", type: "uint32" }, { name: "isLong", type: "bool" }, u128("size"), u128("collateral"), u("acceptablePrice"), u128("executionFee")],
} as const;
const CLOSE = { type: "tuple", components: [u("claimId"), u128("size"), u("acceptablePrice"), u128("executionFee")] } as const;
const PLACE = {
  type: "tuple",
  components: [u("claimId"), { name: "kind", type: "uint8" }, u("triggerPrice"), u128("size"), u("acceptablePrice"), u128("executionFee"), { name: "expiresAt", type: "uint64" }],
} as const;
const CANCEL = { type: "tuple", components: [u("claimId"), u("orderId")] } as const;
const COLLECT = { type: "tuple", components: [u("claimId"), { name: "keep", type: "bool" }] } as const;

/** Prices are USD per whole unit with 18 decimals; sizes and collateral are USDG base units. */
export type PerpOpen = {
  claimId: bigint;
  market: number;
  isLong: boolean;
  size: bigint;
  collateral: bigint;
  acceptablePrice: bigint;
  executionFee: bigint;
};
export type PerpClose = { claimId: bigint; size: bigint; acceptablePrice: bigint; executionFee: bigint };
export type PerpPlaceOrder = {
  claimId: bigint;
  kind: number;
  triggerPrice: bigint;
  size: bigint;
  acceptablePrice: bigint;
  executionFee: bigint;
  expiresAt: bigint;
};

const envelope = (op: number, body: Hex): Hex => encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [op, body]);

export const encodePerpOpen = (o: PerpOpen): Hex => envelope(PERP_OP_OPEN, encodeAbiParameters([OPEN], [o]));
export const encodePerpClose = (c: PerpClose): Hex => envelope(PERP_OP_CLOSE, encodeAbiParameters([CLOSE], [c]));
export const encodePerpAddCollateral = (claimId: bigint): Hex =>
  envelope(PERP_OP_ADD_COLLATERAL, encodeAbiParameters([{ type: "uint256" }], [claimId]));
export const encodePerpPlaceOrder = (o: PerpPlaceOrder): Hex => envelope(PERP_OP_PLACE_ORDER, encodeAbiParameters([PLACE], [o]));
export const encodePerpCancelOrder = (claimId: bigint, orderId: bigint): Hex =>
  envelope(PERP_OP_CANCEL_ORDER, encodeAbiParameters([CANCEL], [{ claimId, orderId }]));
export const encodePerpCollect = (claimId: bigint, keep: boolean): Hex =>
  envelope(PERP_OP_COLLECT, encodeAbiParameters([COLLECT], [{ claimId, keep }]));

export type PerpsOp =
  | { op: typeof PERP_OP_OPEN; open: PerpOpen }
  | { op: typeof PERP_OP_CLOSE; close: PerpClose }
  | { op: typeof PERP_OP_ADD_COLLATERAL; claimId: bigint }
  | { op: typeof PERP_OP_PLACE_ORDER; order: PerpPlaceOrder }
  | { op: typeof PERP_OP_CANCEL_ORDER; claimId: bigint; orderId: bigint }
  | { op: typeof PERP_OP_COLLECT; claimId: bigint; keep: boolean };

export function decodePerpsParams(params: Hex): PerpsOp {
  const [op, body] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], params);
  switch (op) {
    case PERP_OP_OPEN:
      return { op, open: { ...decodeAbiParameters([OPEN], body)[0] } };
    case PERP_OP_CLOSE:
      return { op, close: { ...decodeAbiParameters([CLOSE], body)[0] } };
    case PERP_OP_ADD_COLLATERAL:
      return { op, claimId: decodeAbiParameters([{ type: "uint256" }], body)[0] };
    case PERP_OP_PLACE_ORDER: {
      const o = decodeAbiParameters([PLACE], body)[0];
      return { op, order: { ...o, kind: Number(o.kind) } };
    }
    case PERP_OP_CANCEL_ORDER: {
      const c = decodeAbiParameters([CANCEL], body)[0];
      return { op, claimId: c.claimId, orderId: c.orderId };
    }
    case PERP_OP_COLLECT: {
      const c = decodeAbiParameters([COLLECT], body)[0];
      return { op, claimId: c.claimId, keep: c.keep };
    }
  }
  throw new Error(`unknown perps op ${op}`);
}

/**
 * Which adapter outputs pay USDG, in order: the claim note (when the claim stays alive) and
 * then USDG (always for a collection; for other actions only when a USDG leg is returned).
 */
export function perpsOutputKinds(op: PerpsOp, returnsUsdg: boolean): ("claim" | "usdg")[] {
  if (op.op === PERP_OP_OPEN) return ["claim"];
  if (op.op === PERP_OP_COLLECT) return op.keep ? ["claim", "usdg"] : ["usdg"];
  if (op.op === PERP_OP_ADD_COLLATERAL) return ["claim"];
  return returnsUsdg ? ["claim", "usdg"] : ["claim"];
}

/** A fresh random claim id (never 0). */
export const newClaimId = newPositionId;
