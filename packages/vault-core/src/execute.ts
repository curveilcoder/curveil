/**
 * Shielded execution (docs/vault-spec.md 8). One `execute` call spends up to two legs into an
 * approved adapter (a swap, a liquidity entry or an exit) and settles the adapter's outputs as
 * new notes or public payouts in the same transaction.
 *
 * Each leg is proved with the withdraw circuit. Its context is the execute context below,
 * which commits to every leg and every output, so each leg's proof binds the whole action.
 * Output notes have amounts that are only known on-chain, so their ciphertexts are version 2
 * (the pool appends the amount) and the client sends `ownerHash` instead of a commitment.
 */
import { bytesToHex, encodeAbiParameters, getAddress, keccak256, parseAbi, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { FIELD, MAX_AMOUNT, randomField } from "./field";
import { encryptNote, encryptOpenNote } from "./encryption";
import { commitment, ownerHash, type Note } from "./note";
import { inputSignals, prepareInputs, type Recipient, type SolidityProof, type SpendableNote } from "./actions";
import type { NoteTree } from "./tree";

export const EXECUTE_TAG = keccak256(toBytes("curveil.vault.execute.v1"));
export const MAX_LEGS = 2;
export const MAX_OUTPUTS = 4;

export const executeAbi = parseAbi([
  "struct Proof { uint256[2] a; uint256[2][2] b; uint256[2] c; }",
  "struct Leg { Proof proof; uint256 root; uint256[2] nullifiers; uint256 resource; uint256 amount; uint256 fee; uint256 change; bytes encryptedChange; }",
  "struct OutputSpec { uint256 ownerHash; address recipient; uint256 fee; bytes encryptedNote; }",
  "struct ExecuteArgs { address adapter; bytes params; Leg[] legs; OutputSpec[] outputs; address feeRecipient; uint256 deadline; }",
  "function execute(ExecuteArgs a)",
  "function executeContext(ExecuteArgs a) view returns (uint256)",
]);

export type ExecuteLegArgs = {
  proof: SolidityProof;
  root: bigint;
  nullifiers: readonly [bigint, bigint];
  resource: bigint;
  amount: bigint;
  fee: bigint;
  change: bigint;
  encryptedChange: Hex;
};

export type OutputSpecArgs = { ownerHash: bigint; recipient: Address; fee: bigint; encryptedNote: Hex };

/** Field names and order match ShieldedPool.ExecuteArgs. */
export type ExecuteArgs = {
  adapter: Address;
  params: Hex;
  legs: ExecuteLegArgs[];
  outputs: OutputSpecArgs[];
  feeRecipient: Address;
  deadline: bigint;
};

type LegForContext = Omit<ExecuteLegArgs, "proof">;

function legHash(l: LegForContext): Hex {
  return keccak256(
    encodeAbiParameters(
      Array.from({ length: 7 }, () => ({ type: "uint256" })).concat([{ type: "bytes32" }]),
      [l.root, l.resource, l.amount, l.fee, l.nullifiers[0], l.nullifiers[1], l.change, keccak256(l.encryptedChange)],
    ),
  );
}

function outputHash(o: OutputSpecArgs): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [o.ownerHash, getAddress(o.recipient), o.fee, keccak256(o.encryptedNote)],
    ),
  );
}

const concatHashes = (hs: Hex[]): Hex => (hs.length ? (`0x${hs.map((h) => h.slice(2)).join("")}` as Hex) : "0x");

/** ShieldedPool.executeContext, computed locally. */
export function executeContext(a: {
  chainId: number;
  pool: Address;
  adapter: Address;
  params: Hex;
  legs: readonly LegForContext[];
  outputs: readonly OutputSpecArgs[];
  feeRecipient: Address;
  withdrawFeeBps: number;
  deadline: bigint;
}): bigint {
  const hash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        EXECUTE_TAG,
        BigInt(a.chainId),
        getAddress(a.pool),
        getAddress(a.adapter),
        keccak256(a.params),
        keccak256(concatHashes(a.legs.map(legHash))),
        keccak256(concatHashes(a.outputs.map(outputHash))),
        getAddress(a.feeRecipient),
        BigInt(a.withdrawFeeBps),
        a.deadline,
      ],
    ),
  );
  return BigInt(hash) % FIELD;
}

/** One leg: up to two notes of `resource`; `amount` goes to the adapter, `fee` to the fee recipient. */
export type LegSpec = { resource: bigint; inputs: SpendableNote[]; amount: bigint; fee: bigint };

/**
 * Where adapter output `i` goes, in the adapter's output order. A shielded output becomes a
 * note of `resource` for `to`; a public output is paid to `recipient` and pays the protocol
 * withdrawal fee. `fee` is taken from the output for the fee recipient (broadcaster).
 */
export type OutputPlanSpec =
  | { kind: "note"; to: Recipient; resource: bigint; fee?: bigint }
  | { kind: "public"; recipient: Address; fee?: bigint };

/** An output note before settlement: its amount is only known once the transaction lands. */
export type PendingOutputNote = { resource: bigint; ownerKey: bigint; blinding: bigint; ownerHash: bigint };

export type ExecutePlan = {
  context: bigint;
  /** One circuit input (withdraw circuit) and expected public signals per leg. */
  legs: { circuitInput: Record<string, unknown>; publicSignals: bigint[] }[];
  /** Arguments without proofs; pass them with the leg proofs to `withProofs`. */
  args: Omit<ExecuteArgs, "legs"> & { legs: LegForContext[] };
  /** Change notes, one per leg (amount may be 0). */
  changes: Note[];
  /** Per output: the pending note, or null for a public payout. */
  outputNotes: (PendingOutputNote | null)[];
};

const dec = (x: bigint | number) => x.toString();

export function planExecute(c: {
  spendingKey: bigint;
  tree: NoteTree;
  chainId: number;
  pool: Address;
  domain: bigint;
  adapter: Address;
  params: Hex;
  legs: LegSpec[];
  outputs: OutputPlanSpec[];
  /** Receives every leg's change (normally the sender's own address). */
  changeTo: Recipient;
  /** The broadcaster when any fee is paid; ignored (zero) otherwise. */
  feeRecipient: Address;
  withdrawFeeBps: number;
  deadline: bigint;
}): ExecutePlan {
  if (c.legs.length < 1 || c.legs.length > MAX_LEGS) throw new Error(`an execution spends one or two legs`);
  if (c.outputs.length > MAX_OUTPUTS) throw new Error(`an execution has at most ${MAX_OUTPUTS} outputs`);
  const anyFee = c.legs.some((l) => l.fee > 0n) || c.outputs.some((o) => (o.fee ?? 0n) > 0n);
  const feeRecipient = anyFee ? getAddress(c.feeRecipient) : zeroAddress;
  if (anyFee && feeRecipient === zeroAddress) throw new Error("a fee needs a fee recipient");

  const seen = new Set<number>();
  const root = c.tree.root();
  const prepared = c.legs.map((leg) => {
    if (leg.amount <= 0n || leg.amount > MAX_AMOUNT) throw new Error("leg amount out of range");
    for (const n of leg.inputs) {
      if (seen.has(n.leafIndex)) throw new Error("the same note cannot be spent in two legs");
      seen.add(n.leafIndex);
    }
    const ins = prepareInputs({
      spendingKey: c.spendingKey,
      tree: c.tree,
      chainId: c.chainId,
      pool: c.pool,
      domain: c.domain,
      resource: leg.resource,
      inputs: leg.inputs,
      fee: leg.fee,
      feeRecipient,
      deadline: c.deadline,
    });
    const total = ins.reduce((s, i) => s + i.amount, 0n);
    if (total < leg.amount + leg.fee) throw new Error("selected notes do not cover the amount and fee");
    const change: Note = { resource: leg.resource, amount: total - leg.amount - leg.fee, ownerKey: c.changeTo.ownerKey, blinding: randomField() };
    const encryptedChange = bytesToHex(encryptNote(change, c.changeTo.viewingPublic));
    const args: LegForContext = {
      root,
      nullifiers: [ins[0]!.nullifier, ins[1]!.nullifier],
      resource: leg.resource,
      amount: leg.amount,
      fee: leg.fee,
      change: commitment(change, c.domain),
      encryptedChange,
    };
    return { ins, change, args };
  });

  const outputNotes: (PendingOutputNote | null)[] = [];
  const outputs: OutputSpecArgs[] = c.outputs.map((o) => {
    const fee = o.fee ?? 0n;
    if (fee < 0n || fee > MAX_AMOUNT) throw new Error("output fee out of range");
    if (o.kind === "public") {
      if (getAddress(o.recipient) === zeroAddress) throw new Error("a public output needs a recipient");
      outputNotes.push(null);
      return { ownerHash: 0n, recipient: getAddress(o.recipient), fee, encryptedNote: "0x" };
    }
    const blinding = randomField();
    const oh = ownerHash(o.to.ownerKey, blinding);
    outputNotes.push({ resource: o.resource, ownerKey: o.to.ownerKey, blinding, ownerHash: oh });
    return { ownerHash: oh, recipient: zeroAddress, fee, encryptedNote: bytesToHex(encryptOpenNote({ resource: o.resource, blinding }, o.to.viewingPublic)) };
  });

  const legArgs = prepared.map((p) => p.args);
  const context = executeContext({
    chainId: c.chainId,
    pool: c.pool,
    adapter: c.adapter,
    params: c.params,
    legs: legArgs,
    outputs,
    feeRecipient,
    withdrawFeeBps: c.withdrawFeeBps,
    deadline: c.deadline,
  });

  const legs = prepared.map(({ ins, change, args }) => ({
    circuitInput: {
      root: dec(root),
      domain: dec(c.domain),
      context: dec(context),
      resource: dec(args.resource),
      amount: dec(args.amount),
      fee: dec(args.fee),
      nullifier: args.nullifiers.map(dec),
      outCommitment: dec(args.change),
      spendingKey: dec(c.spendingKey),
      ...inputSignals(ins),
      outAmount: dec(change.amount),
      outOwnerKey: dec(change.ownerKey),
      outBlinding: dec(change.blinding),
    },
    publicSignals: [root, c.domain, context, args.resource, args.amount, args.fee, ...args.nullifiers, args.change],
  }));

  return {
    context,
    legs,
    args: { adapter: getAddress(c.adapter), params: c.params, legs: legArgs, outputs, feeRecipient, deadline: c.deadline },
    changes: prepared.map((p) => p.change),
    outputNotes,
  };
}

/** The final `execute` argument: the plan's arguments with one proof per leg, in leg order. */
export function withProofs(plan: ExecutePlan, proofs: SolidityProof[]): ExecuteArgs {
  if (proofs.length !== plan.args.legs.length) throw new Error("one proof per leg");
  return { ...plan.args, legs: plan.args.legs.map((l, i) => ({ proof: proofs[i]!, ...l })) };
}
