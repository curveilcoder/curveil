/**
 * Builds circuit inputs, expected public signals and contract arguments for vault actions
 * (docs/vault-spec.md 5). The context hash binds everything the contract checks outside the
 * circuit: chain, pool, recipients, fee terms, deadline and the published ciphertexts.
 */
import { bytesToHex, getAddress, keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { MAX_AMOUNT, abiHashToField, randomField } from "./field";
import { encryptNote } from "./encryption";
import { commitment, nullifier, ownerKeyOf, type Note } from "./note";
import { NoteTree, ZEROS, rootFromPath } from "./tree";

export const TRANSFER_TAG = keccak256(toBytes("curveil.vault.transfer.v1"));
export const WITHDRAW_TAG = keccak256(toBytes("curveil.vault.withdraw.v1"));

/** A note this account owns and can spend. */
export type SpendableNote = { leafIndex: number; resource: bigint; amount: bigint; blinding: bigint };

export type Recipient = { ownerKey: bigint; viewingPublic: Uint8Array };

export type Common = {
  spendingKey: bigint;
  tree: NoteTree;
  chainId: number;
  pool: Address;
  domain: bigint;
  resource: bigint;
  /** One or two notes of `resource`. */
  inputs: SpendableNote[];
  /** Broadcaster fee in base units (0 when self-submitting). */
  fee: bigint;
  feeRecipient: Address;
  /** Unix seconds; the contract rejects the action after this time. */
  deadline: bigint;
};

export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
export type SolidityProof = { a: [bigint, bigint]; b: [[bigint, bigint], [bigint, bigint]]; c: [bigint, bigint] };

export function toSolidityProof(p: Groth16Proof): SolidityProof {
  const n = (s: string | undefined) => BigInt(s ?? "0");
  return {
    a: [n(p.pi_a[0]), n(p.pi_a[1])],
    // The pairing precompile takes G2 coordinates as (imaginary, real).
    b: [
      [n(p.pi_b[0]?.[1]), n(p.pi_b[0]?.[0])],
      [n(p.pi_b[1]?.[1]), n(p.pi_b[1]?.[0])],
    ],
    c: [n(p.pi_c[0]), n(p.pi_c[1])],
  };
}

export function transferContext(a: {
  chainId: number;
  pool: Address;
  feeRecipient: Address;
  fee: bigint;
  feeResource: bigint;
  deadline: bigint;
  encryptedNotes: readonly [Hex, Hex];
}): bigint {
  return abiHashToField(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      TRANSFER_TAG,
      BigInt(a.chainId),
      getAddress(a.pool),
      getAddress(a.feeRecipient),
      a.fee,
      a.feeResource,
      a.deadline,
      keccak256(a.encryptedNotes[0]),
      keccak256(a.encryptedNotes[1]),
    ],
  );
}

export function withdrawContext(a: {
  chainId: number;
  pool: Address;
  token: Address;
  recipient: Address;
  feeRecipient: Address;
  fee: bigint;
  withdrawFeeBps: number;
  deadline: bigint;
  encryptedChange: Hex;
}): bigint {
  return abiHashToField(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [
      WITHDRAW_TAG,
      BigInt(a.chainId),
      getAddress(a.pool),
      getAddress(a.token),
      getAddress(a.recipient),
      getAddress(a.feeRecipient),
      a.fee,
      BigInt(a.withdrawFeeBps),
      a.deadline,
      keccak256(a.encryptedChange),
    ],
  );
}

export type PreparedInput = { amount: bigint; blinding: bigint; leafIndex: number; path: bigint[]; nullifier: bigint };

/** Checks the input notes against the local tree and pads to two inputs with a zero note. */
export function prepareInputs(c: Common): PreparedInput[] {
  if (c.inputs.length < 1 || c.inputs.length > 2) throw new Error("an action spends one or two notes");
  if (c.fee < 0n || c.fee > MAX_AMOUNT) throw new Error("fee out of range");
  if (c.fee > 0n && getAddress(c.feeRecipient) === zeroAddress) throw new Error("a fee needs a fee recipient");
  const ownerKey = ownerKeyOf(c.spendingKey);
  const root = c.tree.root();
  const out: PreparedInput[] = [];
  const seen = new Set<number>();
  for (const n of c.inputs) {
    if (n.resource !== c.resource) throw new Error("all notes in one action must hold the same asset");
    if (n.amount <= 0n) throw new Error("input notes must hold value");
    if (seen.has(n.leafIndex)) throw new Error("the same note cannot be spent twice");
    seen.add(n.leafIndex);
    const cm = commitment({ resource: n.resource, amount: n.amount, ownerKey, blinding: n.blinding }, c.domain);
    if (c.tree.leaf(n.leafIndex) !== cm) throw new Error(`note ${n.leafIndex} does not match the tree; resync and try again`);
    const path = c.tree.path(n.leafIndex);
    if (rootFromPath(cm, n.leafIndex, path) !== root) throw new Error("local tree is inconsistent");
    out.push({ amount: n.amount, blinding: n.blinding, leafIndex: n.leafIndex, path, nullifier: nullifier(c.spendingKey, cm, n.leafIndex) });
  }
  while (out.length < 2) {
    // Zero-value padding note: never in the tree, skips the membership check, unique nullifier.
    const blinding = randomField();
    const cm = commitment({ resource: c.resource, amount: 0n, ownerKey, blinding }, c.domain);
    out.push({ amount: 0n, blinding, leafIndex: 0, path: ZEROS.slice(0, c.tree.levels) as bigint[], nullifier: nullifier(c.spendingKey, cm, 0) });
  }
  return out;
}

const dec = (x: bigint | number) => x.toString();

export function inputSignals(ins: PreparedInput[]) {
  return {
    inAmount: ins.map((i) => dec(i.amount)),
    inBlinding: ins.map((i) => dec(i.blinding)),
    inLeafIndex: ins.map((i) => dec(i.leafIndex)),
    inPath: ins.map((i) => i.path.map(dec)),
  };
}

export type TransferPlan = {
  circuitInput: Record<string, unknown>;
  publicSignals: bigint[];
  args: {
    root: bigint;
    nullifiers: [bigint, bigint];
    commitments: [bigint, bigint];
    fee: bigint;
    feeResource: bigint;
    feeRecipient: Address;
    deadline: bigint;
    /** Field names and order match ShieldedPool.TransferArgs, so `args` can be passed as-is. */
    encryptedNote0: Hex;
    encryptedNote1: Hex;
  };
  /** Notes this action creates, in output order: [recipient, change]. */
  outputs: [Note, Note];
};

/**
 * Private transfer: pays `amount` to `to` and returns the change to `changeTo` (normally
 * the sender's own address). Output 0 is the recipient note, output 1 the change note.
 */
export function planTransfer(c: Common & { to: Recipient; amount: bigint; changeTo: Recipient }): TransferPlan {
  const ins = prepareInputs(c);
  const total = ins.reduce((s, i) => s + i.amount, 0n);
  if (c.amount <= 0n) throw new Error("amount must be positive");
  if (total < c.amount + c.fee) throw new Error("selected notes do not cover the amount and fee");
  const change = total - c.amount - c.fee;
  const outputs: [Note, Note] = [
    { resource: c.resource, amount: c.amount, ownerKey: c.to.ownerKey, blinding: randomField() },
    { resource: c.resource, amount: change, ownerKey: c.changeTo.ownerKey, blinding: randomField() },
  ];
  const encryptedNotes: [Hex, Hex] = [
    bytesToHex(encryptNote(outputs[0], c.to.viewingPublic)),
    bytesToHex(encryptNote(outputs[1], c.changeTo.viewingPublic)),
  ];
  const commitments: [bigint, bigint] = [commitment(outputs[0], c.domain), commitment(outputs[1], c.domain)];
  const feeResource = c.fee > 0n ? c.resource : 0n;
  const feeRecipient = c.fee > 0n ? getAddress(c.feeRecipient) : zeroAddress;
  const context = transferContext({ chainId: c.chainId, pool: c.pool, feeRecipient, fee: c.fee, feeResource, deadline: c.deadline, encryptedNotes });
  const root = c.tree.root();
  const nullifiers: [bigint, bigint] = [ins[0]!.nullifier, ins[1]!.nullifier];
  return {
    circuitInput: {
      root: dec(root),
      domain: dec(c.domain),
      context: dec(context),
      fee: dec(c.fee),
      feeResource: dec(feeResource),
      nullifier: nullifiers.map(dec),
      outCommitment: commitments.map(dec),
      resource: dec(c.resource),
      spendingKey: dec(c.spendingKey),
      ...inputSignals(ins),
      outAmount: outputs.map((o) => dec(o.amount)),
      outOwnerKey: outputs.map((o) => dec(o.ownerKey)),
      outBlinding: outputs.map((o) => dec(o.blinding)),
    },
    publicSignals: [root, c.domain, context, c.fee, feeResource, ...nullifiers, ...commitments],
    args: { root, nullifiers, commitments, fee: c.fee, feeResource, feeRecipient, deadline: c.deadline, encryptedNote0: encryptedNotes[0], encryptedNote1: encryptedNotes[1] },
    outputs,
  };
}

export type WithdrawPlan = {
  circuitInput: Record<string, unknown>;
  publicSignals: bigint[];
  args: {
    root: bigint;
    nullifiers: [bigint, bigint];
    commitment: bigint;
    token: Address;
    amount: bigint;
    fee: bigint;
    recipient: Address;
    feeRecipient: Address;
    deadline: bigint;
    encryptedChange: Hex;
  };
  change: Note;
  /** Protocol withdrawal fee the contract will take from `amount` (rounded up). */
  protocolFee: bigint;
  /** What the recipient receives. */
  netToRecipient: bigint;
};

export function protocolWithdrawFee(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps) + 9999n) / 10000n;
}

/** Withdrawal of `amount` (gross, before the protocol fee) to a public `recipient`. */
export function planWithdraw(
  c: Common & { token: Address; amount: bigint; recipient: Address; withdrawFeeBps: number; changeTo: Recipient },
): WithdrawPlan {
  const ins = prepareInputs(c);
  const total = ins.reduce((s, i) => s + i.amount, 0n);
  if (c.amount <= 0n || c.amount > MAX_AMOUNT) throw new Error("amount out of range");
  if (getAddress(c.recipient) === zeroAddress) throw new Error("withdrawal needs a recipient");
  if (total < c.amount + c.fee) throw new Error("selected notes do not cover the amount and fee");
  const protocolFee = protocolWithdrawFee(c.amount, c.withdrawFeeBps);
  const change: Note = { resource: c.resource, amount: total - c.amount - c.fee, ownerKey: c.changeTo.ownerKey, blinding: randomField() };
  const encryptedChange = bytesToHex(encryptNote(change, c.changeTo.viewingPublic));
  const cm = commitment(change, c.domain);
  const feeRecipient = c.fee > 0n ? getAddress(c.feeRecipient) : zeroAddress;
  const context = withdrawContext({
    chainId: c.chainId,
    pool: c.pool,
    token: c.token,
    recipient: c.recipient,
    feeRecipient,
    fee: c.fee,
    withdrawFeeBps: c.withdrawFeeBps,
    deadline: c.deadline,
    encryptedChange,
  });
  const root = c.tree.root();
  const nullifiers: [bigint, bigint] = [ins[0]!.nullifier, ins[1]!.nullifier];
  return {
    circuitInput: {
      root: dec(root),
      domain: dec(c.domain),
      context: dec(context),
      resource: dec(c.resource),
      amount: dec(c.amount),
      fee: dec(c.fee),
      nullifier: nullifiers.map(dec),
      outCommitment: dec(cm),
      spendingKey: dec(c.spendingKey),
      ...inputSignals(ins),
      outAmount: dec(change.amount),
      outOwnerKey: dec(change.ownerKey),
      outBlinding: dec(change.blinding),
    },
    publicSignals: [root, c.domain, context, c.resource, c.amount, c.fee, ...nullifiers, cm],
    args: {
      root,
      nullifiers,
      commitment: cm,
      token: getAddress(c.token),
      amount: c.amount,
      fee: c.fee,
      recipient: getAddress(c.recipient),
      feeRecipient,
      deadline: c.deadline,
      encryptedChange,
    },
    change,
    protocolFee,
    netToRecipient: c.amount - protocolFee,
  };
}
