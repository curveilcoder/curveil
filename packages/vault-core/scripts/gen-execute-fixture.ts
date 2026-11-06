/**
 * Generates real Groth16 proofs for the Foundry shielded-execution tests
 * (packages/contracts/test/fixtures/execute.json). The test deploys every contract from fixed
 * addresses at nonce 0, and the markets come from CREATE2 in their factories, so every address,
 * the note domain and every context hash are known here in advance.
 *
 * Run `forge build` in packages/contracts first (market addresses depend on the bytecode),
 * then: pnpm --filter @curveil/vault-core exec tsx scripts/gen-execute-fixture.ts
 *
 * Scenario (leaf indices in brackets). Every proof uses a root whose leaves are all known
 * here; outputs whose amounts depend on market state come after every leaf a later proof needs.
 *   [0] Alice shields 1,000 USDG   [1] Alice shields 1 WETH   [2] Alice shields 500 USDG
 *   dammEntry   200 USDG + 0.1 WETH into the DAMM pool at its exact ratio (no refunds)
 *               -> [3] USDG change, [4] WETH change, [5] share note P1 (1e18 units)
 *   transfer    Alice sends 0.6 units of P1 to Bob privately -> [6] Bob, [7] Alice change
 *   dlmmEntry   100 USDG (+0.25 fee to the broadcaster) + 0.05 WETH into three DLMM bins
 *               -> [8] USDG change, [9] WETH change, [10] share note P2, then any refunds
 *   swap        100 USDG -> WETH through the DAMM pool, 0.5 USDG broadcaster fee (root after [10])
 *   dammExit    Alice exits 0.25 of her 0.4 units of P1 into notes, 0.3 USDG fee from the output
 *   bobExit     Bob exits all 0.6 units of P1 to a public address (protocol withdrawal fee)
 *   dlmmExit    Alice exits all of P2 into notes (last holder takes everything)
 *   mockFungible, mockShare   proofs bound to a test adapter (backing check, share namespace)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { encodeAbiParameters, getContractAddress, hexToBytes, keccak256, concat, type Address, type Hex } from "viem";
import {
  NoteTree,
  POSITION_UNITS,
  commitment,
  deriveKeys,
  encodeDammEntry,
  encodeDlmmEntry,
  encodeExit,
  encodeSwapParams,
  fungibleResource,
  newEntropy,
  noteDomain,
  planExecute,
  planShield,
  planTransfer,
  scanCommitments,
  shareResource,
  toSolidityProof,
  withProofs,
  type ExecuteArgs,
  type ExecutePlan,
  type OwnedNote,
  type SolidityProof,
} from "../src";

const CONTRACTS = join(import.meta.dirname, "..", "..", "contracts");
const CIRCUITS = join(import.meta.dirname, "..", "..", "circuits");
const OUT = join(CONTRACTS, "test", "fixtures", "execute.json");
const wasm = (n: string) => join(CIRCUITS, "build", n, `${n}_js`, `${n}.wasm`);
const zkey = (n: string) => join(CIRCUITS, "artifacts", process.env.SETUP_NETWORK ?? "testnet", `${n}.zkey`);
const bytecode = (n: string) => JSON.parse(readFileSync(join(CONTRACTS, "out", `${n}.sol`, `${n}.json`), "utf8")).bytecode.object as Hex;

const CHAIN_ID = 31337;
const D = (n: number) => `0x000000000000000000000000000000000000Da${n.toString(16).padStart(2, "0")}` as Address;
const DEPLOYERS = { usdg: D(0x11), weth: D(0x12), damm: D(0x13), dlmm: D(0x14), router: D(0x15), pool: D(0x16), swap: D(0x17), liquidity: D(0x18), mock: D(0x19) };
const BROADCASTER: Address = "0x000000000000000000000000000000000000B0B0";
const RECIPIENT: Address = "0x000000000000000000000000000000000000Ca5e";
const DEADLINE = 4_000_000_000n;
const FEE_BPS = 10;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

// The test's market setup (keep in step with ShieldedExecute.t.sol).
const DAMM_TIER = { baseFeeBps: 30, maxFeeBps: 100, protocolShareBps: 2000, variableFeeControl: 2000, filterPeriod: 30, decayPeriod: 600, reductionBps: 5000, maxVolatilityBps: 5000 };
const DLMM_BIN_STEP = 25;
const DLMM_BASE_FEE_BPS = 30;
const DLMM_PROTOCOL_SHARE_BPS = 2000;
const CENTER = 1 << 23;

const at = (from: Address) => getContractAddress({ from, nonce: 0n });
const usdg = at(DEPLOYERS.usdg);
const weth = at(DEPLOYERS.weth);
const dammFactory = at(DEPLOYERS.damm);
const dlmmFactory = at(DEPLOYERS.dlmm);
const pool = at(DEPLOYERS.pool);
const swapAdapter = at(DEPLOYERS.swap);
const liquidityAdapter = at(DEPLOYERS.liquidity);
const mockAdapter = at(DEPLOYERS.mock);
const [t0, t1] = usdg.toLowerCase() < weth.toLowerCase() ? [usdg, weth] : [weth, usdg];

const dammPool = getContractAddress({
  opcode: "CREATE2",
  from: dammFactory,
  salt: keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }], [t0, t1])),
  bytecode: concat([
    bytecode("DammPool"),
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        {
          type: "tuple",
          components: [
            { name: "baseFeeBps", type: "uint16" },
            { name: "maxFeeBps", type: "uint16" },
            { name: "protocolShareBps", type: "uint16" },
            { name: "variableFeeControl", type: "uint16" },
            { name: "filterPeriod", type: "uint32" },
            { name: "decayPeriod", type: "uint32" },
            { name: "reductionBps", type: "uint16" },
            { name: "maxVolatilityBps", type: "uint32" },
          ],
        },
      ],
      [t0, t1, DAMM_TIER],
    ),
  ]),
});
const dlmmPair = getContractAddress({
  opcode: "CREATE2",
  from: dlmmFactory,
  salt: keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint16" }], [t0, t1, DLMM_BIN_STEP])),
  bytecode: concat([
    bytecode("DlmmPair"),
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint24" }],
      [t0, t1, DLMM_BIN_STEP, DLMM_BASE_FEE_BPS, DLMM_PROTOCOL_SHARE_BPS, CENTER],
    ),
  ]),
});

const domain = noteDomain(CHAIN_ID, pool);
const USDG = fungibleResource(usdg);
const WETH = fungibleResource(weth);
const resourceOf = (t: Address) => (t === usdg ? USDG : WETH);

const s = (x: bigint) => x.toString();
const proofJson = (p: SolidityProof) => ({ a: p.a.map(s), b: p.b.map((r) => r.map(s)), c: p.c.map(s) });

async function prove(name: string, input: Record<string, unknown>, expected: bigint[]): Promise<SolidityProof> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, wasm(name), zkey(name));
  if (publicSignals.map(BigInt).join() !== expected.join()) throw new Error(`${name}: public signals differ from the plan`);
  return toSolidityProof(proof);
}

async function proveExecute(plan: ExecutePlan): Promise<ExecuteArgs> {
  const proofs: SolidityProof[] = [];
  for (const leg of plan.legs) proofs.push(await prove("withdraw", leg.circuitInput, leg.publicSignals));
  return withProofs(plan, proofs);
}

const executeJson = (a: ExecuteArgs) => ({
  adapter: a.adapter,
  params: a.params,
  legs: a.legs.map((l) => ({
    proof: proofJson(l.proof),
    root: s(l.root),
    nullifiers: l.nullifiers.map(s),
    resource: s(l.resource),
    amount: s(l.amount),
    fee: s(l.fee),
    change: s(l.change),
    encryptedChange: l.encryptedChange,
  })),
  outputs: a.outputs.map((o) => ({ ownerHash: s(o.ownerHash), recipient: o.recipient, fee: s(o.fee), encryptedNote: o.encryptedNote })),
  feeRecipient: a.feeRecipient,
  deadline: s(a.deadline),
});

const alice = deriveKeys(newEntropy());
const bob = deriveKeys(newEntropy());
const tree = new NoteTree();
const roots: Record<string, string> = {};
const common = { tree, chainId: CHAIN_ID, pool, domain, withdrawFeeBps: FEE_BPS, deadline: DEADLINE };

/** Finds `keys`' note at `leafIndex` from a commitment and its published payload. */
function own(keys: typeof alice, leafIndex: number, cm: bigint, payload: Hex): OwnedNote {
  const found = scanCommitments(keys, domain, [{ leafIndex, commitment: cm, encryptedNote: hexToBytes(payload) }]);
  if (found.length !== 1) throw new Error(`leaf ${leafIndex}: note not found by scan`);
  return found[0]!;
}

/** The published payload of an open-amount output: the client ciphertext plus uint128 amount. */
const openPayload = (ct: Hex, amount: bigint) => concat([ct, `0x${amount.toString(16).padStart(32, "0")}`]);

// ---------------------------------------------------------------- shields [0..2]
const shields = [
  [USDG, 1_000_000_000n],
  [WETH, 10n ** 18n],
  [USDG, 500_000_000n],
].map(([resource, amount], i) => {
  const p = planShield(alice, resource!, amount!);
  const cm = commitment(p.note, domain);
  tree.append([cm]);
  return { token: resource === USDG ? usdg : weth, amount: s(amount!), ownerHash: s(p.ownerHash), encryptedNote: p.encryptedNote, commitment: s(cm), leaf: i };
});
const aliceShields = shields.map((x) => own(alice, x.leaf, BigInt(x.commitment), x.encryptedNote));
roots.afterShields = s(tree.root());

// ---------------------------------------------------------------- dammEntry
const P1 = 0x5eed01n;
const shareP1 = shareResource(liquidityAdapter, P1);
const refundOrder = [t0, t1];
const dammEntryPlan = planExecute({
  ...common,
  spendingKey: alice.spendingKey,
  adapter: liquidityAdapter,
  params: encodeDammEntry({ positionId: P1, market: dammPool, min0: 0n, min1: 0n, minLiquidity: 1n }),
  legs: [
    { resource: USDG, inputs: [aliceShields[0]!], amount: 200_000_000n, fee: 0n },
    { resource: WETH, inputs: [aliceShields[1]!], amount: 10n ** 17n, fee: 0n },
  ],
  outputs: [
    { kind: "note", to: alice, resource: shareP1 },
    ...refundOrder.map((t) => ({ kind: "note" as const, to: alice, resource: resourceOf(t) })),
  ],
  changeTo: alice,
  feeRecipient: ZERO,
});
const dammEntry = await proveExecute(dammEntryPlan);
const p1Pending = dammEntryPlan.outputNotes[0]!;
const p1Cm = commitment({ resource: shareP1, amount: POSITION_UNITS, ownerKey: alice.ownerKey, blinding: p1Pending.blinding }, domain);
tree.append([dammEntry.legs[0]!.change, dammEntry.legs[1]!.change, p1Cm]);
const usdgChange3 = own(alice, 3, dammEntry.legs[0]!.change, dammEntry.legs[0]!.encryptedChange);
const wethChange4 = own(alice, 4, dammEntry.legs[1]!.change, dammEntry.legs[1]!.encryptedChange);
const aliceP1 = own(alice, 5, p1Cm, openPayload(dammEntry.outputs[0]!.encryptedNote, POSITION_UNITS));
if (aliceP1.amount !== POSITION_UNITS || aliceP1.resource !== shareP1) throw new Error("share note scan");
roots.afterDammEntry = s(tree.root());

// ---------------------------------------------------------------- private share transfer
const t = planTransfer({
  spendingKey: alice.spendingKey,
  tree,
  chainId: CHAIN_ID,
  pool,
  domain,
  resource: shareP1,
  inputs: [aliceP1],
  fee: 0n,
  feeRecipient: ZERO,
  deadline: DEADLINE,
  to: bob,
  amount: 6n * 10n ** 17n,
  changeTo: alice,
});
const transferProof = await prove("transfer", t.circuitInput, t.publicSignals);
tree.append(t.args.commitments);
const bobP1 = own(bob, 6, t.args.commitments[0], t.args.encryptedNote0);
const aliceP1Rest = own(alice, 7, t.args.commitments[1], t.args.encryptedNote1);
roots.afterTransfer = s(tree.root());

// ---------------------------------------------------------------- dlmmEntry (broadcaster fee on the USDG leg)
const P2 = 0x5eed02n;
const shareP2 = shareResource(liquidityAdapter, P2);
const dlmmEntryPlan = planExecute({
  ...common,
  spendingKey: alice.spendingKey,
  adapter: liquidityAdapter,
  params: encodeDlmmEntry({
    positionId: P2,
    market: dlmmPair,
    activeIdExpected: CENTER,
    idSlippage: 5,
    deltaIds: [-1n, 0n, 1n],
    distributionX: [0n, 5n * 10n ** 17n, 5n * 10n ** 17n],
    distributionY: [5n * 10n ** 17n, 5n * 10n ** 17n, 0n],
  }),
  legs: [
    { resource: USDG, inputs: [aliceShields[2]!], amount: 100_000_000n, fee: 250_000n },
    { resource: WETH, inputs: [wethChange4], amount: 5n * 10n ** 16n, fee: 0n },
  ],
  outputs: [
    { kind: "note", to: alice, resource: shareP2 },
    ...refundOrder.map((tk) => ({ kind: "note" as const, to: alice, resource: resourceOf(tk) })),
  ],
  changeTo: alice,
  feeRecipient: BROADCASTER,
});
const dlmmEntry = await proveExecute(dlmmEntryPlan);
const p2Cm = commitment({ resource: shareP2, amount: POSITION_UNITS, ownerKey: alice.ownerKey, blinding: dlmmEntryPlan.outputNotes[0]!.blinding }, domain);
tree.append([dlmmEntry.legs[0]!.change, dlmmEntry.legs[1]!.change, p2Cm]);
const aliceP2 = own(alice, 10, p2Cm, openPayload(dlmmEntry.outputs[0]!.encryptedNote, POSITION_UNITS));
roots.afterDlmmEntry = s(tree.root());
// From here on, leaves depend on market state; later proofs use the roots above.

// ---------------------------------------------------------------- swap (broadcaster fee on the leg)
const swap = await proveExecute(
  planExecute({
    ...common,
    spendingKey: alice.spendingKey,
    adapter: swapAdapter,
    params: encodeSwapParams([{ pool: dammPool, tokenIn: usdg, tokenOut: weth }], 1n),
    legs: [{ resource: USDG, inputs: [usdgChange3], amount: 100_000_000n, fee: 500_000n }],
    outputs: [{ kind: "note", to: alice, resource: WETH }],
    changeTo: alice,
    feeRecipient: BROADCASTER,
  }),
);

// ---------------------------------------------------------------- dammExit (fee from the USDG output)
const usdgIndex = refundOrder.indexOf(usdg);
const dammExit = await proveExecute(
  planExecute({
    ...common,
    spendingKey: alice.spendingKey,
    adapter: liquidityAdapter,
    params: encodeExit({ positionId: P1, min0: 1n, min1: 1n }),
    legs: [{ resource: shareP1, inputs: [aliceP1Rest], amount: 25n * 10n ** 16n, fee: 0n }],
    outputs: refundOrder.map((tk, i) => ({ kind: "note" as const, to: alice, resource: resourceOf(tk), fee: i === usdgIndex ? 300_000n : 0n })),
    changeTo: alice,
    feeRecipient: BROADCASTER,
  }),
);

// ---------------------------------------------------------------- bobExit (public, self-submitted)
const bobExit = await proveExecute(
  planExecute({
    ...common,
    spendingKey: bob.spendingKey,
    adapter: liquidityAdapter,
    params: encodeExit({ positionId: P1, min0: 0n, min1: 0n }),
    legs: [{ resource: shareP1, inputs: [bobP1], amount: bobP1.amount, fee: 0n }],
    outputs: refundOrder.map(() => ({ kind: "public" as const, recipient: RECIPIENT })),
    changeTo: bob,
    feeRecipient: ZERO,
  }),
);

// ---------------------------------------------------------------- dlmmExit (all of P2)
const dlmmExit = await proveExecute(
  planExecute({
    ...common,
    spendingKey: alice.spendingKey,
    adapter: liquidityAdapter,
    params: encodeExit({ positionId: P2, min0: 0n, min1: 0n }),
    legs: [{ resource: shareP2, inputs: [aliceP2], amount: POSITION_UNITS, fee: 0n }],
    outputs: refundOrder.map((tk) => ({ kind: "note" as const, to: alice, resource: resourceOf(tk) })),
    changeTo: alice,
    feeRecipient: ZERO,
  }),
);

// ---------------------------------------------------------------- test adapter proofs
// Bound to the test adapter. Built on throwaway trees: mockFungible spends leaf 2 against the
// root right after the shields; mockShare spends Alice's P1 rest against the root after the transfer.
const shieldTree = new NoteTree(shields.map((x) => BigInt(x.commitment)));
const mockFungible = await proveExecute(
  planExecute({
    ...common,
    tree: shieldTree,
    spendingKey: alice.spendingKey,
    adapter: mockAdapter,
    params: "0x",
    legs: [{ resource: USDG, inputs: [aliceShields[2]!], amount: 100_000_000n, fee: 0n }],
    outputs: [{ kind: "note", to: alice, resource: USDG }],
    changeTo: alice,
    feeRecipient: ZERO,
  }),
);
const transferTree = new NoteTree([...shields.map((x) => BigInt(x.commitment)), dammEntry.legs[0]!.change, dammEntry.legs[1]!.change, p1Cm, ...t.args.commitments]);
const mockShare = await proveExecute(
  planExecute({
    ...common,
    tree: transferTree,
    spendingKey: alice.spendingKey,
    adapter: mockAdapter,
    params: "0x",
    legs: [{ resource: shareP1, inputs: [aliceP1Rest], amount: aliceP1Rest.amount, fee: 0n }],
    outputs: [],
    changeTo: alice,
    feeRecipient: ZERO,
  }),
);

const fixture = {
  note: "Generated by packages/vault-core/scripts/gen-execute-fixture.ts. Do not edit.",
  chainId: CHAIN_ID,
  deployers: DEPLOYERS,
  usdg,
  weth,
  token0: t0,
  token1: t1,
  dammFactory,
  dlmmFactory,
  dammPool,
  dlmmPair,
  pool,
  swapAdapter,
  liquidityAdapter,
  mockAdapter,
  broadcaster: BROADCASTER,
  recipient: RECIPIENT,
  withdrawFeeBps: FEE_BPS,
  domain: s(domain),
  positions: { p1: s(P1), p2: s(P2), shareP1: s(shareP1), shareP2: s(shareP2) },
  roots,
  contexts: { dammEntry: s(dammEntryPlan.context), dlmmEntry: s(dlmmEntryPlan.context) },
  shields,
  dammEntry: executeJson(dammEntry),
  transfer: {
    proof: proofJson(transferProof),
    root: s(t.args.root),
    nullifiers: t.args.nullifiers.map(s),
    commitments: t.args.commitments.map(s),
    fee: s(t.args.fee),
    feeResource: s(t.args.feeResource),
    feeRecipient: t.args.feeRecipient,
    deadline: s(t.args.deadline),
    encryptedNote0: t.args.encryptedNote0,
    encryptedNote1: t.args.encryptedNote1,
  },
  dlmmEntry: executeJson(dlmmEntry),
  swap: executeJson(swap),
  dammExit: executeJson(dammExit),
  bobExit: executeJson(bobExit),
  dlmmExit: executeJson(dlmmExit),
  mockFungible: executeJson(mockFungible),
  mockShare: executeJson(mockShare),
};
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${OUT}`);
process.exit(0);
