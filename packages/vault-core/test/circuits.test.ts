/**
 * Runs the compiled circuits against inputs built by this library. The witness calculator
 * enforces every constraint, so an invalid action fails here before any proof exists.
 * With the testnet setup present, it also proves and verifies a real Groth16 proof.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { decodeFunctionData, encodeFunctionData, type Abi } from "viem";
import { describe, expect, it } from "vitest";
import {
  FIELD,
  NoteTree,
  commitment,
  deriveKeys,
  fungibleResource,
  newEntropy,
  noteDomain,
  planShield,
  planTransfer,
  planWithdraw,
  type SpendableNote,
} from "../src";

const CIRCUITS = join(__dirname, "..", "..", "circuits");
const wasm = (name: string) => join(CIRCUITS, "build", name, `${name}_js`, `${name}.wasm`);
// CIRCUIT_ARTIFACTS points the tests at another setup, for example a ceremony rehearsal.
const ARTIFACTS = process.env.CIRCUIT_ARTIFACTS ?? join(CIRCUITS, "artifacts", "testnet");
const zkey = (name: string) => join(ARTIFACTS, `${name}.zkey`);
const vkey = (name: string) => join(ARTIFACTS, `${name}.vkey.json`);
const built = existsSync(wasm("transfer")) && existsSync(wasm("withdraw"));

const CHAIN = 46630;
const POOL = "0x00000000000000000000000000000000000000a1" as const;
const TOKEN = "0xB80877C55B95A3998412cb0ddf40E643EDa3F102" as const;
const OTHER_TOKEN = "0x229A9d59D5E3dff37b83E42Bc4899AfC1aE691CD" as const;
const BROADCASTER = "0x00000000000000000000000000000000000000b2" as const;
const domain = noteDomain(CHAIN, POOL);
const resource = fungibleResource(TOKEN);

async function witness(name: string, input: Record<string, unknown>) {
  const out = { type: "mem" } as { type: "mem"; data?: Uint8Array };
  await snarkjs.wtns.calculate(input, wasm(name), out);
  return out;
}

/** A tree holding my deposits plus some unrelated leaves. */
function setup(amounts: bigint[]) {
  const me = deriveKeys(newEntropy());
  const leaves: bigint[] = [11n, 22n];
  const mine: SpendableNote[] = [];
  for (const amount of amounts) {
    const s = planShield(me, resource, amount);
    mine.push({ leafIndex: leaves.length, resource, amount, blinding: s.note.blinding });
    leaves.push(commitment(s.note, domain));
    leaves.push(BigInt(leaves.length) * 7919n);
  }
  return { me, tree: new NoteTree(leaves), mine };
}

const base = { chainId: CHAIN, pool: POOL, domain, resource, deadline: 2_000_000_000n } as const;

describe.skipIf(!built)("transfer circuit", () => {
  it("accepts a valid two-note transfer with a broadcaster fee", async () => {
    const { me, tree, mine } = setup([600n, 500n]);
    const bob = deriveKeys(newEntropy());
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 25n, feeRecipient: BROADCASTER, to: bob, amount: 1000n, changeTo: me });
    expect(plan.outputs[1].amount).toBe(75n);
    await witness("transfer", plan.circuitInput);
  });

  it("accepts a single note padded with a zero note and no fee", async () => {
    const { me, tree, mine } = setup([600n]);
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 0n, feeRecipient: BROADCASTER, to: me, amount: 600n, changeTo: me });
    expect(plan.args.feeResource).toBe(0n);
    await witness("transfer", plan.circuitInput);
  });

  it("rejects value creation", async () => {
    const { me, tree, mine } = setup([600n]);
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 0n, feeRecipient: BROADCASTER, to: me, amount: 100n, changeTo: me });
    const input = { ...plan.circuitInput, outAmount: ["100", "501"] };
    await expect(witness("transfer", input)).rejects.toThrow();
  });

  it("rejects a negative (wrapped) output amount", async () => {
    const { me, tree, mine } = setup([600n]);
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 0n, feeRecipient: BROADCASTER, to: me, amount: 100n, changeTo: me });
    const input = { ...plan.circuitInput, outAmount: ["700", (FIELD - 100n).toString()] };
    await expect(witness("transfer", input)).rejects.toThrow();
  });

  it("rejects spending with someone else's key", async () => {
    const { tree, mine } = setup([600n]);
    const thief = deriveKeys(newEntropy());
    // Build with the right key's structure but the thief's spending key: the commitment no longer opens.
    expect(() =>
      planTransfer({ ...base, spendingKey: thief.spendingKey, tree, inputs: mine, fee: 0n, feeRecipient: BROADCASTER, to: thief, amount: 600n, changeTo: thief }),
    ).toThrow(/does not match the tree/);
    const { me, tree: t2, mine: m2 } = setup([600n]);
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree: t2, inputs: m2, fee: 0n, feeRecipient: BROADCASTER, to: thief, amount: 600n, changeTo: thief });
    await expect(witness("transfer", { ...plan.circuitInput, spendingKey: thief.spendingKey.toString() })).rejects.toThrow();
  });

  it("rejects a wrong nullifier, a duplicated input and a non-member input", async () => {
    const { me, tree, mine } = setup([600n, 500n]);
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 0n, feeRecipient: BROADCASTER, to: me, amount: 1100n, changeTo: me });
    const i = plan.circuitInput as Record<string, string[] | string[][]>;
    await expect(witness("transfer", { ...plan.circuitInput, nullifier: [i.nullifier![1], i.nullifier![0]] })).rejects.toThrow();
    // Same note twice: identical nullifiers.
    const dup = {
      ...plan.circuitInput,
      inAmount: [i.inAmount![0], i.inAmount![0]],
      inBlinding: [i.inBlinding![0], i.inBlinding![0]],
      inLeafIndex: [i.inLeafIndex![0], i.inLeafIndex![0]],
      inPath: [i.inPath![0], i.inPath![0]],
      nullifier: [i.nullifier![0], i.nullifier![0]],
      outAmount: ["1200", "0"],
    };
    await expect(witness("transfer", dup)).rejects.toThrow();
    // A different root (the note is not in that tree).
    await expect(witness("transfer", { ...plan.circuitInput, root: "12345" })).rejects.toThrow();
  });

  it("rejects a fee paid in a different asset", async () => {
    const { me, tree, mine } = setup([600n]);
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 10n, feeRecipient: BROADCASTER, to: me, amount: 100n, changeTo: me });
    await expect(witness("transfer", { ...plan.circuitInput, feeResource: fungibleResource(OTHER_TOKEN).toString() })).rejects.toThrow();
  });
});

describe.skipIf(!built)("withdraw circuit", () => {
  it("accepts a valid withdrawal and rejects over-withdrawal", async () => {
    const { me, tree, mine } = setup([1_000_000n]);
    const plan = planWithdraw({
      ...base,
      spendingKey: me.spendingKey,
      tree,
      inputs: mine,
      fee: 2_000n,
      feeRecipient: BROADCASTER,
      token: TOKEN,
      amount: 900_000n,
      recipient: "0x00000000000000000000000000000000000000c3",
      withdrawFeeBps: 10,
      changeTo: me,
    });
    expect(plan.change.amount).toBe(98_000n);
    expect(plan.protocolFee).toBe(900n);
    await witness("withdraw", plan.circuitInput);
    await expect(witness("withdraw", { ...plan.circuitInput, amount: "990000" })).rejects.toThrow();
    await expect(witness("withdraw", { ...plan.circuitInput, resource: fungibleResource(OTHER_TOKEN).toString() })).rejects.toThrow();
  });
});

const setupDone = built && existsSync(zkey("transfer")) && existsSync(zkey("withdraw"));

describe.skipIf(!setupDone)("Groth16 proofs with the testnet setup", () => {
  it("proves and verifies a transfer and a withdrawal; public signals match the plan", async () => {
    const { me, tree, mine } = setup([700n, 300n]);
    const bob = deriveKeys(newEntropy());
    const t = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 5n, feeRecipient: BROADCASTER, to: bob, amount: 900n, changeTo: me });
    const tp = await snarkjs.groth16.fullProve(t.circuitInput as never, wasm("transfer"), zkey("transfer"));
    expect(tp.publicSignals.map(BigInt)).toEqual(t.publicSignals);
    expect(await snarkjs.groth16.verify(JSON.parse(readFileSync(vkey("transfer"), "utf8")), tp.publicSignals, tp.proof)).toBe(true);
    // Changing any public signal breaks verification (context binding included).
    const tampered = [...tp.publicSignals];
    tampered[2] = (BigInt(tampered[2]!) + 1n).toString();
    expect(await snarkjs.groth16.verify(JSON.parse(readFileSync(vkey("transfer"), "utf8")), tampered, tp.proof)).toBe(false);

    const w = planWithdraw({
      ...base,
      spendingKey: me.spendingKey,
      tree,
      inputs: [mine[0]!],
      fee: 0n,
      feeRecipient: BROADCASTER,
      token: TOKEN,
      amount: 700n,
      recipient: "0x00000000000000000000000000000000000000c3",
      withdrawFeeBps: 10,
      changeTo: me,
    });
    const wp = await snarkjs.groth16.fullProve(w.circuitInput as never, wasm("withdraw"), zkey("withdraw"));
    expect(wp.publicSignals.map(BigInt)).toEqual(w.publicSignals);
    expect(await snarkjs.groth16.verify(JSON.parse(readFileSync(vkey("withdraw"), "utf8")), wp.publicSignals, wp.proof)).toBe(true);
  }, 180_000);
});

describe("contract calldata", () => {
  // The plans' `args` are passed to the contract unchanged by the website and the broadcaster,
  // so their field names must match ShieldedPool's structs exactly.
  const abi = JSON.parse(readFileSync(join(__dirname, "..", "..", "manifest", "abis", "ShieldedPool.json"), "utf8")) as Abi;
  const proof = { a: [1n, 2n], b: [[3n, 4n], [5n, 6n]], c: [7n, 8n] } as const;

  it("encodes a transfer plan against the ShieldedPool ABI", () => {
    const { me, tree, mine } = setup([600n, 500n]);
    const plan = planTransfer({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 25n, feeRecipient: BROADCASTER, to: deriveKeys(newEntropy()), amount: 1000n, changeTo: me });
    const data = encodeFunctionData({ abi, functionName: "transfer", args: [proof, plan.args] });
    const decoded = decodeFunctionData({ abi, data });
    expect((decoded.args![1] as { encryptedNote1: string }).encryptedNote1).toBe(plan.args.encryptedNote1);
  });

  it("encodes a withdraw plan against the ShieldedPool ABI", () => {
    const { me, tree, mine } = setup([600n]);
    const plan = planWithdraw({ ...base, spendingKey: me.spendingKey, tree, inputs: mine, fee: 0n, feeRecipient: BROADCASTER, token: TOKEN, amount: 100n, recipient: BROADCASTER, withdrawFeeBps: 10, changeTo: me });
    const data = encodeFunctionData({ abi, functionName: "withdraw", args: [proof, plan.args] });
    expect((decodeFunctionData({ abi, data }).args![1] as { amount: bigint }).amount).toBe(100n);
  });
});
