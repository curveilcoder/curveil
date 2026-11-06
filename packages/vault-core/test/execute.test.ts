/**
 * Shielded execution in the client library: open-amount note encryption, share resources,
 * adapter parameters, the execute context and leg witnesses. The Foundry suite
 * (ShieldedExecute.t.sol) checks the same fixture against the contract, which closes the loop:
 * the client and the pool compute identical contexts and resources.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { bytesToHex, concat, getAddress, decodeFunctionData, encodeFunctionData, hexToBytes, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  NoteTree,
  POSITION_UNITS,
  commitment,
  decodeLiquidityParams,
  decodeSwapParams,
  deriveKeys,
  encodeDammEntry,
  encodeDlmmEntry,
  encodeExit,
  encodeSwapParams,
  encryptNote,
  encryptOpenNote,
  executeAbi,
  executeContext,
  fungibleResource,
  newEntropy,
  newPositionId,
  noteDomain,
  ownerHash,
  planExecute,
  randomField,
  scanCommitments,
  shareResource,
  tryDecryptNote,
  withProofs,
  type SpendableNote,
} from "../src";

const FIXTURE = join(__dirname, "..", "..", "contracts", "test", "fixtures", "execute.json");
const fx = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
const CIRCUITS = join(__dirname, "..", "..", "circuits");
const wasm = join(CIRCUITS, "build", "withdraw", "withdraw_js", "withdraw.wasm");

const POOL: Address = getAddress("0x00000000000000000000000000000000000000a1");
const ADAPTER: Address = getAddress("0x00000000000000000000000000000000000000a2");
const TOKEN: Address = getAddress("0x00000000000000000000000000000000000000a3");
const OTHER: Address = getAddress("0x00000000000000000000000000000000000000a4");
const BROADCASTER: Address = getAddress("0x00000000000000000000000000000000000000b0");
const CHAIN_ID = 46630;
const domain = noteDomain(CHAIN_ID, POOL);
const RES = fungibleResource(TOKEN);
const amountBytes = (x: bigint) => `0x${x.toString(16).padStart(32, "0")}` as Hex;

function setup(amounts: bigint[], resource = RES) {
  const me = deriveKeys(newEntropy());
  const tree = new NoteTree();
  const mine: SpendableNote[] = amounts.map((amount, leafIndex) => {
    const blinding = randomField();
    tree.append([commitment({ resource, amount, ownerKey: me.ownerKey, blinding }, domain)]);
    return { leafIndex, resource, amount, blinding };
  });
  return { me, tree, mine };
}

const base = { chainId: CHAIN_ID, pool: POOL, domain, adapter: ADAPTER, withdrawFeeBps: 10, deadline: 4_000_000_000n };

describe("open-amount notes", () => {
  it("decrypts with the amount the pool appended and only re-opens with that amount", () => {
    const me = deriveKeys(newEntropy());
    const blinding = randomField();
    const ct = encryptOpenNote({ resource: RES, blinding }, me.viewingPublic);
    expect(ct.length).toBe(129);
    expect(ct[0]).toBe(2);
    const payload = hexToBytes(concat([bytesToHex(ct), amountBytes(1234n)]));
    expect(tryDecryptNote(payload, me.viewingPrivate, me.viewingPublic)).toEqual({ resource: RES, amount: 1234n, blinding });
    // Without the appended amount, or as a 129-byte version 2 payload, it is not a note.
    expect(tryDecryptNote(ct, me.viewingPrivate, me.viewingPublic)).toBeNull();
    // A version 1 ciphertext with 16 extra bytes is rejected.
    const v1 = encryptNote({ resource: RES, amount: 5n, blinding }, me.viewingPublic);
    expect(tryDecryptNote(hexToBytes(concat([bytesToHex(v1), amountBytes(5n)])), me.viewingPrivate, me.viewingPublic)).toBeNull();

    const cm = commitment({ resource: RES, amount: 1234n, ownerKey: me.ownerKey, blinding }, domain);
    const found = scanCommitments(me, domain, [{ leafIndex: 7, commitment: cm, encryptedNote: payload }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toBe(1234n);
    // A wrong amount in the published bytes does not re-open the commitment, so it is ignored.
    const forged = hexToBytes(concat([bytesToHex(ct), amountBytes(9999n)]));
    expect(scanCommitments(me, domain, [{ leafIndex: 7, commitment: cm, encryptedNote: forged }])).toHaveLength(0);
  });

  it("is not readable by anyone else", () => {
    const me = deriveKeys(newEntropy());
    const other = deriveKeys(newEntropy());
    const ct = encryptOpenNote({ resource: RES, blinding: randomField() }, me.viewingPublic);
    const payload = hexToBytes(concat([bytesToHex(ct), amountBytes(1n)]));
    expect(tryDecryptNote(payload, other.viewingPrivate, other.viewingPublic)).toBeNull();
  });
});

describe("adapter parameters", () => {
  it("round-trips swap, DAMM entry, DLMM entry and exit parameters", () => {
    const hops = [{ pool: POOL, tokenIn: TOKEN, tokenOut: OTHER }];
    expect(decodeSwapParams(encodeSwapParams(hops, 77n))).toEqual({ hops, minOut: 77n });
    const id = newPositionId();
    expect(id).toBeGreaterThan(0n);
    const damm = { positionId: id, market: POOL, min0: 1n, min1: 2n, minLiquidity: 3n };
    expect(decodeLiquidityParams(encodeDammEntry(damm))).toEqual({ op: 1, entry: damm });
    const dlmm = { positionId: id, market: POOL, activeIdExpected: 8388608, idSlippage: 3, deltaIds: [-1n, 0n, 1n], distributionX: [0n, 1n, 2n], distributionY: [2n, 1n, 0n] };
    expect(decodeLiquidityParams(encodeDlmmEntry(dlmm))).toEqual({ op: 2, entry: dlmm });
    expect(decodeLiquidityParams(encodeExit({ positionId: id, min0: 4n, min1: 5n }))).toEqual({ op: 3, exit: { positionId: id, min0: 4n, min1: 5n } });
  });
});

describe.skipIf(!fx)("agreement with the contract fixture", () => {
  it("derives the same share resources the pool derives", () => {
    expect(shareResource(fx.liquidityAdapter, BigInt(fx.positions.p1))).toBe(BigInt(fx.positions.shareP1));
    expect(shareResource(fx.liquidityAdapter, BigInt(fx.positions.p2))).toBe(BigInt(fx.positions.shareP2));
  });

  it("recomputes the execute context of a fixture action", () => {
    const a = fx.dammEntry;
    const ctx = executeContext({
      chainId: fx.chainId,
      pool: fx.pool,
      adapter: a.adapter,
      params: a.params,
      legs: a.legs.map((l: Record<string, unknown>) => ({
        root: BigInt(l.root as string),
        nullifiers: (l.nullifiers as string[]).map(BigInt) as [bigint, bigint],
        resource: BigInt(l.resource as string),
        amount: BigInt(l.amount as string),
        fee: BigInt(l.fee as string),
        change: BigInt(l.change as string),
        encryptedChange: l.encryptedChange as Hex,
      })),
      outputs: a.outputs.map((o: Record<string, string>) => ({ ownerHash: BigInt(o.ownerHash!), recipient: o.recipient as Address, fee: BigInt(o.fee!), encryptedNote: o.encryptedNote as Hex })),
      feeRecipient: a.feeRecipient,
      withdrawFeeBps: fx.withdrawFeeBps,
      deadline: BigInt(a.deadline),
    });
    expect(ctx).toBe(BigInt(fx.contexts.dammEntry));
  });
});

describe("planExecute", () => {
  const swapParams = encodeSwapParams([{ pool: POOL, tokenIn: TOKEN, tokenOut: OTHER }], 1n);

  it("binds every leg into one context and builds valid leg witnesses", async () => {
    const { me, tree, mine } = setup([600n, 500n, 50n]);
    const plan = planExecute({
      ...base,
      spendingKey: me.spendingKey,
      tree,
      params: swapParams,
      legs: [
        { resource: RES, inputs: [mine[0]!, mine[1]!], amount: 1000n, fee: 3n },
        { resource: RES, inputs: [mine[2]!], amount: 40n, fee: 0n },
      ],
      outputs: [{ kind: "note", to: me, resource: fungibleResource(OTHER) }, { kind: "public", recipient: OTHER, fee: 1n }],
      changeTo: me,
      feeRecipient: BROADCASTER,
    });
    expect(plan.args.feeRecipient).toBe(BROADCASTER);
    expect(plan.changes.map((c) => c.amount)).toEqual([97n, 10n]);
    expect(plan.args.outputs[1]).toMatchObject({ ownerHash: 0n, recipient: OTHER, fee: 1n, encryptedNote: "0x" });
    const pending = plan.outputNotes[0]!;
    expect(plan.args.outputs[0]!.ownerHash).toBe(ownerHash(me.ownerKey, pending.blinding));
    for (const leg of plan.legs) expect(leg.publicSignals[2]).toBe(plan.context);

    // The ABI the website and the broadcaster encode with.
    const args = withProofs(plan, plan.legs.map(() => ({ a: [1n, 2n], b: [[3n, 4n], [5n, 6n]], c: [7n, 8n] })));
    const data = encodeFunctionData({ abi: executeAbi, functionName: "execute", args: [args] });
    expect(decodeFunctionData({ abi: executeAbi, data }).args[0].legs[1]!.amount).toBe(40n);

    if (existsSync(wasm)) {
      for (const leg of plan.legs) await snarkjs.wtns.calculate(leg.circuitInput as never, wasm, { type: "mem" });
      // A leg moved to another action (different context) no longer satisfies the circuit's binding.
      const tampered = { ...plan.legs[0]!.circuitInput, amount: "999" };
      await expect(snarkjs.wtns.calculate(tampered as never, wasm, { type: "mem" })).rejects.toThrow();
    }
  }, 60_000);

  it("uses the canonical zero fee recipient when nothing pays a fee", () => {
    const { me, tree, mine } = setup([100n]);
    const plan = planExecute({ ...base, spendingKey: me.spendingKey, tree, params: swapParams, legs: [{ resource: RES, inputs: mine, amount: 100n, fee: 0n }], outputs: [], changeTo: me, feeRecipient: BROADCASTER });
    expect(plan.args.feeRecipient).toBe("0x0000000000000000000000000000000000000000");
  });

  it("refuses malformed actions", () => {
    const { me, tree, mine } = setup([100n, 100n]);
    const leg = { resource: RES, inputs: [mine[0]!], amount: 10n, fee: 0n };
    const common = { ...base, spendingKey: me.spendingKey, tree, params: swapParams, changeTo: me, outputs: [] };
    expect(() => planExecute({ ...common, legs: [], feeRecipient: BROADCASTER })).toThrow();
    expect(() => planExecute({ ...common, legs: [leg, leg], feeRecipient: BROADCASTER })).toThrow(/two legs/);
    expect(() => planExecute({ ...common, legs: [leg, leg, leg], feeRecipient: BROADCASTER })).toThrow();
    expect(() => planExecute({ ...common, legs: [{ ...leg, fee: 1n }], feeRecipient: "0x0000000000000000000000000000000000000000" })).toThrow(/fee recipient/);
    expect(() => planExecute({ ...common, legs: [{ ...leg, amount: 101n }], feeRecipient: BROADCASTER })).toThrow(/cover/);
  });

  it("spends share notes like any other resource", () => {
    const share = shareResource(ADAPTER, 42n);
    const { me, tree, mine } = setup([POSITION_UNITS], share);
    const plan = planExecute({
      ...base,
      spendingKey: me.spendingKey,
      tree,
      params: encodeExit({ positionId: 42n, min0: 0n, min1: 0n }),
      legs: [{ resource: share, inputs: mine, amount: POSITION_UNITS / 4n, fee: 0n }],
      outputs: [{ kind: "note", to: me, resource: RES }, { kind: "note", to: me, resource: fungibleResource(OTHER) }],
      changeTo: me,
      feeRecipient: BROADCASTER,
    });
    expect(plan.changes[0]!.amount).toBe((POSITION_UNITS * 3n) / 4n);
    expect(plan.changes[0]!.resource).toBe(share);
  });
});

describe("ABI agreement", () => {
  const abiPath = join(__dirname, "..", "..", "manifest", "abis", "ShieldedPool.json");
  const abi = JSON.parse(readFileSync(abiPath, "utf8")) as Abi;
  const hasExecute = abi.some((x) => x.type === "function" && x.name === "execute");
  it.skipIf(!hasExecute)("execute matches the deployed ShieldedPool ABI", () => {
    const fromManifest = abi.find((x) => x.type === "function" && x.name === "execute")!;
    const ours = executeAbi.find((x) => x.type === "function" && x.name === "execute")!;
    expect(toFunctionSelector(ours)).toBe(toFunctionSelector(fromManifest as never));
  });
});
