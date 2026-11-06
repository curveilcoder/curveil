/**
 * Validates vault submissions and encodes ShieldedPool calls. The broadcaster only relays
 * calls whose fee is paid to its own address at or above its posted rate; everything else
 * (recipients, amounts, ciphertexts, adapter parameters, deadline) is fixed by the user's proof.
 */
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, isAddress, isHex, keccak256, type Abi, type Address, type Hex } from "viem";
import shieldedPoolAbiJson from "@curveil/manifest/abis/ShieldedPool.json";
import routerAbiJson from "@curveil/manifest/abis/CurveilRouter.json";
import swapAdapterAbiJson from "@curveil/manifest/abis/ShieldedSwapAdapter.json";
import liquidityAdapterAbiJson from "@curveil/manifest/abis/ShieldedLiquidityAdapter.json";
import dammPoolAbiJson from "@curveil/manifest/abis/DammPool.json";
import dlmmPairAbiJson from "@curveil/manifest/abis/DlmmPair.json";
import perpsAdapterAbiJson from "@curveil/manifest/abis/ShieldedPerpsAdapter.json";
import perpEngineAbiJson from "@curveil/manifest/abis/PerpEngine.json";
import orderManagerAbiJson from "@curveil/manifest/abis/OrderManager.json";

export const shieldedPoolAbi = shieldedPoolAbiJson as Abi;
/** Every error a vault call can revert with: the pool, the adapters and the markets behind them. */
export const revertAbi = [
  shieldedPoolAbiJson,
  routerAbiJson,
  swapAdapterAbiJson,
  liquidityAdapterAbiJson,
  dammPoolAbiJson,
  dlmmPairAbiJson,
  perpsAdapterAbiJson,
  perpEngineAbiJson,
  orderManagerAbiJson,
]
  .flat()
  .filter((x) => (x as { type: string }).type === "error") as Abi;

export type Action = "transfer" | "withdraw" | "execute";
/**
 * Gas use relative to a withdrawal: an execution verifies up to two proofs, inserts up to six
 * notes and runs a market action. Fees scale by this factor.
 */
export const FEE_MULTIPLIER: Record<Action, bigint> = { transfer: 1n, withdraw: 1n, execute: 3n };
export const isAction = (a: unknown): a is Action => a === "transfer" || a === "withdraw" || a === "execute";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_AMOUNT = (1n << 128n) - 1n;
const CIPHERTEXT_HEX_LENGTH = 2 + 129 * 2;
const RESOURCE_FUNGIBLE_TAG = keccak256(new TextEncoder().encode("curveil.resource.fungible.v1"));

export class Rejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function fungibleResource(token: Address): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [RESOURCE_FUNGIBLE_TAG, token]))) % FIELD;
}

const field = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^[0-9]{1,78}$/.test(v)) throw new Rejected("bad_input", `${what} must be a decimal string`);
  const x = BigInt(v);
  if (x >= FIELD) throw new Rejected("bad_input", `${what} is not a field element`);
  return x;
};
const amount = (v: unknown, what: string): bigint => {
  const x = field(v, what);
  if (x > MAX_AMOUNT) throw new Rejected("bad_input", `${what} is out of range`);
  return x;
};
const address = (v: unknown, what: string): Address => {
  if (typeof v !== "string" || !isAddress(v)) throw new Rejected("bad_input", `${what} must be an address`);
  return getAddress(v);
};
const ciphertext = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !isHex(v) || v.length !== CIPHERTEXT_HEX_LENGTH) throw new Rejected("bad_input", `${what} must be a 129-byte hex ciphertext`);
  return v.toLowerCase() as Hex;
};
const pair = <T>(v: unknown, f: (x: unknown, w: string) => T, what: string): [T, T] => {
  if (!Array.isArray(v) || v.length !== 2) throw new Rejected("bad_input", `${what} must have two entries`);
  return [f(v[0], `${what}[0]`), f(v[1], `${what}[1]`)];
};

type Proof = { a: [bigint, bigint]; b: [[bigint, bigint], [bigint, bigint]]; c: [bigint, bigint] };

function proof(v: unknown): Proof {
  const p = v as { a?: unknown; b?: unknown; c?: unknown } | null;
  if (!p || typeof p !== "object") throw new Rejected("bad_input", "proof is missing");
  const b = p.b as unknown[];
  if (!Array.isArray(b) || b.length !== 2) throw new Rejected("bad_input", "proof.b must have two rows");
  return {
    a: pair(p.a, field, "proof.a"),
    b: [pair(b[0], field, "proof.b[0]"), pair(b[1], field, "proof.b[1]")],
    c: pair(p.c, field, "proof.c"),
  };
}

export type Prepared = {
  action: Action;
  data: Hex;
  nullifiers: bigint[];
  feeToken: Address;
  fee: bigint;
  deadline: bigint;
};

/**
 * Parses a submission and checks the broadcaster's own terms. `fees` maps token address to
 * the minimum fee in base units. Throws Rejected with a user-facing message.
 */
export function prepare(body: unknown, me: Address, fees: Map<Address, bigint>, nowSeconds: number): Prepared {
  const b = body as { action?: unknown; proof?: unknown; args?: Record<string, unknown> } | null;
  if (!b || typeof b !== "object" || !b.args || typeof b.args !== "object") throw new Rejected("bad_input", "Expected { action, proof, args }.");
  const p = proof(b.proof);
  const a = b.args;
  const deadline = field(a.deadline, "deadline");
  if (deadline < BigInt(nowSeconds + 60)) throw new Rejected("deadline_too_soon", "The proof's deadline is less than a minute away. Make a new proof.");
  const nullifiers = pair(a.nullifiers, field, "nullifiers");
  if (nullifiers[0] === nullifiers[1]) throw new Rejected("bad_input", "nullifiers must differ");
  const fee = amount(a.fee, "fee");
  const feeRecipient = address(a.feeRecipient, "feeRecipient");
  if (feeRecipient !== me) throw new Rejected("wrong_fee_recipient", "The proof pays its fee to a different address. Get a fresh quote and prove again.");

  if (b.action === "transfer") {
    const feeResource = field(a.feeResource, "feeResource");
    const feeToken = [...fees.keys()].find((t) => fungibleResource(t) === feeResource);
    if (!feeToken) throw new Rejected("unsupported_asset", "This broadcaster does not take fees in that asset.");
    if (fee < fees.get(feeToken)! * FEE_MULTIPLIER.transfer) throw new Rejected("fee_too_low", "The fee is below this broadcaster's current rate. Get a fresh quote.");
    const args = {
      root: field(a.root, "root"),
      nullifiers,
      commitments: pair(a.commitments, field, "commitments"),
      fee,
      feeResource,
      feeRecipient,
      deadline,
      encryptedNote0: ciphertext(a.encryptedNote0, "encryptedNote0"),
      encryptedNote1: ciphertext(a.encryptedNote1, "encryptedNote1"),
    };
    return { action: "transfer", data: encodeFunctionData({ abi: shieldedPoolAbi, functionName: "transfer", args: [p, args] }), nullifiers, feeToken, fee, deadline };
  }
  if (b.action === "withdraw") {
    const token = address(a.token, "token");
    const min = fees.get(token);
    if (min === undefined) throw new Rejected("unsupported_asset", "This broadcaster does not take fees in that asset.");
    if (fee < min * FEE_MULTIPLIER.withdraw) throw new Rejected("fee_too_low", "The fee is below this broadcaster's current rate. Get a fresh quote.");
    const args = {
      root: field(a.root, "root"),
      nullifiers,
      commitment: field(a.commitment, "commitment"),
      token,
      amount: amount(a.amount, "amount"),
      fee,
      recipient: address(a.recipient, "recipient"),
      feeRecipient,
      deadline,
      encryptedChange: ciphertext(a.encryptedChange, "encryptedChange"),
    };
    return { action: "withdraw", data: encodeFunctionData({ abi: shieldedPoolAbi, functionName: "withdraw", args: [p, args] }), nullifiers, feeToken: token, fee, deadline };
  }
  throw new Rejected("bad_input", "action must be transfer, withdraw or execute");
}

// ------------------------------------------------------------------ shielded execution

const MAX_LEGS = 2;
const MAX_OUTPUTS = 4;
const MAX_PARAMS_BYTES = 16_384;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export type ExecuteLeg = {
  proof: Proof;
  root: bigint;
  nullifiers: [bigint, bigint];
  resource: bigint;
  amount: bigint;
  fee: bigint;
  change: bigint;
  encryptedChange: Hex;
};
export type ExecuteOutput = { ownerHash: bigint; recipient: Address; fee: bigint; encryptedNote: Hex };
export type ExecuteArgs = { adapter: Address; params: Hex; legs: ExecuteLeg[]; outputs: ExecuteOutput[]; feeRecipient: Address; deadline: bigint };

/** Shape checks for an execute submission (the pool re-checks everything on-chain). */
export function parseExecute(body: unknown, adapters: ReadonlySet<Address>, nowSeconds: number): ExecuteArgs {
  const b = body as { action?: unknown; args?: Record<string, unknown> } | null;
  if (!b || typeof b !== "object" || b.action !== "execute" || !b.args || typeof b.args !== "object") {
    throw new Rejected("bad_input", "Expected { action: execute, args }.");
  }
  const a = b.args;
  const adapter = address(a.adapter, "adapter");
  if (!adapters.has(adapter)) throw new Rejected("unsupported_adapter", "This broadcaster does not relay calls to that adapter.");
  if (typeof a.params !== "string" || !isHex(a.params) || (a.params.length - 2) / 2 > MAX_PARAMS_BYTES) throw new Rejected("bad_input", "params must be hex bytes");
  const deadline = field(a.deadline, "deadline");
  if (deadline < BigInt(nowSeconds + 60)) throw new Rejected("deadline_too_soon", "The proof's deadline is less than a minute away. Make a new proof.");
  if (!Array.isArray(a.legs) || a.legs.length < 1 || a.legs.length > MAX_LEGS) throw new Rejected("bad_input", "an execution has one or two legs");
  if (!Array.isArray(a.outputs) || a.outputs.length > MAX_OUTPUTS) throw new Rejected("bad_input", `an execution has at most ${MAX_OUTPUTS} outputs`);
  const legs = a.legs.map((l: Record<string, unknown>, i: number): ExecuteLeg => {
    if (!l || typeof l !== "object") throw new Rejected("bad_input", `legs[${i}] is missing`);
    const nullifiers = pair(l.nullifiers, field, `legs[${i}].nullifiers`);
    if (nullifiers[0] === nullifiers[1]) throw new Rejected("bad_input", "nullifiers must differ");
    return {
      proof: proof(l.proof),
      root: field(l.root, `legs[${i}].root`),
      nullifiers,
      resource: field(l.resource, `legs[${i}].resource`),
      amount: amount(l.amount, `legs[${i}].amount`),
      fee: amount(l.fee, `legs[${i}].fee`),
      change: field(l.change, `legs[${i}].change`),
      encryptedChange: ciphertext(l.encryptedChange, `legs[${i}].encryptedChange`),
    };
  });
  const all = legs.flatMap((l) => l.nullifiers.map(String));
  if (new Set(all).size !== all.length) throw new Rejected("bad_input", "a note appears in two legs");
  const outputs = a.outputs.map((o: Record<string, unknown>, j: number): ExecuteOutput => {
    if (!o || typeof o !== "object") throw new Rejected("bad_input", `outputs[${j}] is missing`);
    const recipient = address(o.recipient, `outputs[${j}].recipient`);
    const encryptedNote = recipient === ZERO ? ciphertext(o.encryptedNote, `outputs[${j}].encryptedNote`) : o.encryptedNote === "0x" ? ("0x" as Hex) : null;
    if (encryptedNote === null) throw new Rejected("bad_input", `outputs[${j}] is public and must carry no ciphertext`);
    return { ownerHash: field(o.ownerHash, `outputs[${j}].ownerHash`), recipient, fee: amount(o.fee, `outputs[${j}].fee`), encryptedNote };
  });
  return { adapter, params: a.params.toLowerCase() as Hex, legs, outputs, feeRecipient: address(a.feeRecipient, "feeRecipient"), deadline };
}

/**
 * Checks the fee terms of an execution. `outputTokens[j]` is the token adapter output `j` will
 * be paid in (null for a share), resolved from the adapter parameters. The fee may be paid in
 * any asset this broadcaster accepts, from legs or outputs; the largest total counts.
 */
export function prepareExecute(
  args: ExecuteArgs,
  outputTokens: readonly (Address | null)[],
  me: Address,
  fees: Map<Address, bigint>,
  proofFor: (a: ExecuteArgs) => Hex = encodeExecute,
): Prepared {
  if (args.feeRecipient !== me) throw new Rejected("wrong_fee_recipient", "The proof pays its fee to a different address. Get a fresh quote and prove again.");
  if (outputTokens.length !== args.outputs.length) throw new Rejected("bad_input", "outputs do not match the adapter's outputs");
  const paid = new Map<Address, bigint>();
  const add = (t: Address | null | undefined, x: bigint) => {
    if (t && x > 0n) paid.set(t, (paid.get(t) ?? 0n) + x);
  };
  for (const l of args.legs) add([...fees.keys()].find((t) => fungibleResource(t) === l.resource), l.fee);
  args.outputs.forEach((o, j) => add(outputTokens[j], o.fee));
  let best: { token: Address; fee: bigint } | null = null;
  for (const [token, fee] of paid) {
    const min = fees.get(token);
    if (min !== undefined && fee >= min * FEE_MULTIPLIER.execute && (!best || fee > best.fee)) best = { token, fee };
  }
  if (!best) throw new Rejected("fee_too_low", "The fee is below this broadcaster's current rate for this action. Get a fresh quote.");
  return { action: "execute", data: proofFor(args), nullifiers: args.legs.flatMap((l) => l.nullifiers), feeToken: best.token, fee: best.fee, deadline: args.deadline };
}

export function encodeExecute(a: ExecuteArgs): Hex {
  return encodeFunctionData({ abi: shieldedPoolAbi, functionName: "execute", args: [a] });
}

const HOPS = { type: "tuple[]", components: [{ name: "pool", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }] } as const;

/**
 * What the broadcaster must read on-chain to know each output's token: nothing for a swap (the
 * route names it), the market for a liquidity entry, the position for an exit.
 */
export type OutputPlan =
  | { kind: "swap"; tokenOut: Address }
  | { kind: "entry"; market: Address }
  | { kind: "exit"; positionId: bigint };

export function outputPlan(adapterKind: "swap" | "liquidity", params: Hex): OutputPlan {
  try {
    if (adapterKind === "swap") {
      const [hops] = decodeAbiParameters([HOPS, { type: "uint256" }], params);
      if (hops.length === 0) throw new Error("no hops");
      return { kind: "swap", tokenOut: getAddress(hops[hops.length - 1]!.tokenOut) };
    }
    const [op, body] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], params);
    const u = { type: "uint256" } as const;
    if (op === 1) {
      const [e] = decodeAbiParameters([{ type: "tuple", components: [u, { type: "address" }, u, u, u] }], body);
      return { kind: "entry", market: getAddress(e[1]) };
    }
    if (op === 2) {
      const [e] = decodeAbiParameters(
        [{ type: "tuple", components: [u, { type: "address" }, { type: "uint24" }, { type: "uint24" }, { type: "int256[]" }, { type: "uint256[]" }, { type: "uint256[]" }] }],
        body,
      );
      return { kind: "entry", market: getAddress(e[1]) };
    }
    if (op === 3) {
      const [e] = decodeAbiParameters([{ type: "tuple", components: [u, u, u] }], body);
      return { kind: "exit", positionId: e[0] };
    }
  } catch {
    /* fall through */
  }
  throw new Rejected("bad_input", "The adapter parameters could not be read.");
}

/** Output tokens in adapter order, given the market's two tokens (sorted, as the markets keep them). */
export function outputTokens(plan: OutputPlan, marketTokens: readonly [Address, Address] | null, outputs: number): (Address | null)[] {
  if (plan.kind === "swap") return [plan.tokenOut].concat(Array(Math.max(0, outputs - 1)).fill(null)).slice(0, outputs);
  if (!marketTokens) throw new Rejected("bad_input", "Unknown market for this position.");
  const list = plan.kind === "entry" ? [null, marketTokens[0], marketTokens[1]] : [marketTokens[0], marketTokens[1]];
  return list.concat(Array(Math.max(0, outputs - list.length)).fill(null)).slice(0, outputs);
}

/**
 * Output tokens of a ShieldedPerpsAdapter call, in order: the claim note (a share, null here)
 * while the claim stays alive, then USDG. Open and add-collateral return only the claim; a
 * collection returns USDG (after the claim when it is kept); close and order actions return
 * the claim and, when a USDG fee leg came in, the rest of that leg.
 */
export function perpsOutputTokens(params: Hex, outputs: number, usdg: Address): (Address | null)[] {
  let op: number;
  let body: Hex;
  try {
    [op, body] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], params) as [number, Hex];
  } catch {
    throw new Rejected("bad_input", "The perps parameters could not be read.");
  }
  let expected: (Address | null)[];
  if (op === 1 || op === 3) expected = [null];
  else if (op === 6) {
    let keep: boolean;
    try {
      [[, keep]] = decodeAbiParameters([{ type: "tuple", components: [{ type: "uint256" }, { type: "bool" }] }], body) as [[bigint, boolean]];
    } catch {
      throw new Rejected("bad_input", "The perps parameters could not be read.");
    }
    expected = keep ? [null, usdg] : [usdg];
  } else if (op === 2 || op === 4 || op === 5) expected = outputs === 2 ? [null, usdg] : [null];
  else throw new Rejected("bad_input", "Unknown perps action.");
  if (expected.length !== outputs) throw new Rejected("bad_input", "outputs do not match the adapter's outputs");
  return expected;
}

export function parseFees(json: string): Map<Address, bigint> {
  const raw = JSON.parse(json) as Record<string, string>;
  return new Map(Object.entries(raw).map(([t, v]) => [getAddress(t), BigInt(v)]));
}
