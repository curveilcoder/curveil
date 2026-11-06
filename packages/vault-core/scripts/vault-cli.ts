/**
 * Curveil vault alternative client. Works with only your recovery phrase and a public RPC
 * endpoint: it does not use the Curveil website, API or broadcaster. It rebuilds the note
 * tree from the pool's own events, checks the rebuilt root against the contract, finds your
 * notes, proves locally and submits from any wallet (or prints the calldata for one).
 *
 *   pnpm --filter @curveil/vault-core vault <command>
 *
 * Commands:
 *   address                                  print your shielded address
 *   balance                                  scan the chain and list balances, notes and
 *                                            shielded liquidity positions
 *   withdraw <SYMBOL> <amount> <0xrecipient> exit to a public address
 *   transfer <SYMBOL> <amount> <cvl1…>       private transfer to a shielded address
 *   exit <position> <percent> [0xrecipient]  exit a shielded liquidity position (its number
 *                                            from `balance`, or its full id) back to your
 *                                            notes, or to a public address (withdrawal fee)
 *
 * Environment:
 *   CURVEIL_PHRASE      your 24 words; if unset, they are read from standard input
 *   NETWORK             testnet (default) or mainnet; selects the bundled manifest
 *   RPC_URL             any RPC for that chain (default: the manifest's public RPC)
 *   POOL                "legacy" to use the previous pool (still open for withdrawals and
 *                       transfers), or a pool address; default: the current pool
 *   WALLET_PRIVATE_KEY  if set, the transaction is sent from this key; otherwise the
 *                       contract address and calldata are printed for any wallet to send
 *
 * Never pass the phrase as a command-line argument: shells keep a history.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as snarkjs from "snarkjs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  NoteTree,
  decodeAddress,
  deriveKeys,
  encodeAddress,
  encodeExit,
  fungibleResource,
  noteDomain,
  phraseToEntropy,
  planExecute,
  planTransfer,
  planWithdraw,
  scanCommitments,
  selectNotes,
  shareResource,
  toSolidityProof,
  withProofs,
  type OwnedNote,
} from "../src";

const ROOT = join(import.meta.dirname, "..", "..");
const NETWORK = process.env.NETWORK ?? "testnet";
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest", "manifests", `${NETWORK}.json`), "utf8"));
const readAbi = (name: string) => {
  const j = JSON.parse(readFileSync(join(ROOT, "manifest", "abis", `${name}.json`), "utf8"));
  return (Array.isArray(j) ? j : j.abi) as Abi;
};
// POOL=legacy selects the previous pool; POOL=0x… any pool deployment listed in the manifest.
const poolChoice = process.env.POOL ?? "current";
const poolName =
  poolChoice === "legacy"
    ? "ShieldedPoolV1"
    : poolChoice === "current"
      ? "ShieldedPool"
      : Object.keys(manifest.contracts).find((k) => k.startsWith("ShieldedPool") && isAddress(poolChoice) && getAddress(manifest.contracts[k].address) === getAddress(poolChoice));
if (!poolName || !manifest.contracts[poolName]) throw new Error(`No pool ${poolChoice} in the ${NETWORK} manifest.`);
const poolEntry = manifest.contracts[poolName];
const abi = readAbi(poolName);
const POOL = getAddress(poolEntry.address) as Address;
const LIQUIDITY_ADAPTER = poolName === "ShieldedPool" && manifest.contracts.ShieldedLiquidityAdapter ? (getAddress(manifest.contracts.ShieldedLiquidityAdapter.address) as Address) : null;
const adapterAbi = LIQUIDITY_ADAPTER ? readAbi("ShieldedLiquidityAdapter") : [];
const marketAbi = parseAbi(["function tokens() view returns (address, address)"]);
const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const RPC_URL = process.env.RPC_URL ?? manifest.rpc.public[0];
const chain = defineChain({ id: manifest.chainId, name: NETWORK, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const client = createPublicClient({ chain, transport: http(RPC_URL) });
const LOG_CHUNK = 10_000n;
const DEADLINE_SECONDS = 20n * 60n;

type Asset = { symbol: string; address: Address; decimals: number; resource: bigint };
const assets: Asset[] = manifest.assets.map((a: { symbol: string; address: string; decimals: number }) => ({
  symbol: a.symbol,
  address: getAddress(a.address),
  decimals: a.decimals,
  resource: fungibleResource(getAddress(a.address)),
}));

async function readPhrase(): Promise<string> {
  if (process.env.CURVEIL_PHRASE) return process.env.CURVEIL_PHRASE;
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  process.stderr.write("Recovery phrase (24 words): ");
  for await (const line of rl) {
    rl.close();
    return line;
  }
  throw new Error("No recovery phrase given.");
}

/** Every NoteCommitted and NullifierSpent event since the pool was deployed, in chunks. */
async function readEvents() {
  const head = await client.getBlockNumber();
  const commitments = new Map<number, { commitment: bigint; encryptedNote: Uint8Array }>();
  const nullifiers = new Set<bigint>();
  const shares = new Map<bigint, { adapter: Address; shareId: bigint }>();
  for (let from = BigInt(poolEntry.deployBlock); from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const logs = await client.getContractEvents({ address: POOL, abi, fromBlock: from, toBlock: to });
    for (const log of logs as unknown as { eventName: string; args: Record<string, unknown> }[]) {
      if (log.eventName === "NoteCommitted") {
        commitments.set(Number(log.args.leafIndex), { commitment: log.args.commitment as bigint, encryptedNote: toBytes(log.args.encryptedNote as Hex) });
      } else if (log.eventName === "NullifierSpent") {
        nullifiers.add(log.args.nullifier as bigint);
      } else if (log.eventName === "ShareRegistered") {
        shares.set(log.args.resource as bigint, { adapter: getAddress(log.args.adapter as string), shareId: log.args.shareId as bigint });
      }
    }
    process.stderr.write(`\rScanned blocks up to ${to} of ${head}`);
  }
  process.stderr.write("\n");
  const leaves: bigint[] = [];
  for (let i = 0; commitments.has(i); i++) leaves.push(commitments.get(i)!.commitment);
  if (leaves.length !== commitments.size) throw new Error("The RPC returned a gap in the note events. Try another RPC endpoint.");
  return { commitments, leaves, nullifiers, shares };
}

async function load() {
  const keys = deriveKeys(phraseToEntropy(await readPhrase()));
  const [onchainDomain, lastRoot, withdrawFeeBps] = (await Promise.all([
    client.readContract({ address: POOL, abi, functionName: "noteDomain" }),
    client.readContract({ address: POOL, abi, functionName: "getLastRoot" }),
    client.readContract({ address: POOL, abi, functionName: "withdrawFeeBps" }),
  ])) as [bigint, bigint, number];
  const domain = noteDomain(manifest.chainId, POOL);
  if (domain !== onchainDomain) throw new Error("The pool's note domain does not match this manifest. Stopped.");
  const events = await readEvents();
  const tree = new NoteTree(events.leaves);
  // The rebuilt tree must reproduce a root the contract knows; otherwise the events are incomplete.
  const root = tree.root();
  if (root !== lastRoot && !(await client.readContract({ address: POOL, abi, functionName: "isKnownRoot", args: [root] }))) {
    throw new Error("The rebuilt tree root is not known to the contract. The RPC may be behind; try again or use another RPC.");
  }
  const items = [...events.commitments.entries()].map(([leafIndex, c]) => ({ leafIndex, ...c }));
  const notes = scanCommitments(keys, domain, items).filter((n) => !events.nullifiers.has(n.nullifier) && n.amount > 0n);
  return { keys, domain, tree, notes, withdrawFeeBps: Number(withdrawFeeBps), positions: await positionsOf(notes, events.shares) };
}

type Token = { address: Address; symbol: string; decimals: number };
type Position = { n: number; id: bigint; resource: bigint; kind: string; market: Address; tokens: [Token, Token]; units: bigint; total: bigint };

async function tokenInfo(address: Address): Promise<Token> {
  const known = assets.find((a) => a.address === address);
  if (known) return known;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address, symbol, decimals };
}

/** Share notes grouped by liquidity position, from the pool's own ShareRegistered events. */
async function positionsOf(notes: OwnedNote[], shares: Map<bigint, { adapter: Address; shareId: bigint }>): Promise<Position[]> {
  const out: Position[] = [];
  const byResource = new Map<bigint, bigint>();
  for (const n of notes) if (shares.has(n.resource)) byResource.set(n.resource, (byResource.get(n.resource) ?? 0n) + n.amount);
  for (const [resource, units] of byResource) {
    const s = shares.get(resource)!;
    if (!LIQUIDITY_ADAPTER || s.adapter !== LIQUIDITY_ADAPTER) continue;
    const p = (await client.readContract({ address: LIQUIDITY_ADAPTER, abi: adapterAbi, functionName: "positionOf", args: [s.shareId] })) as {
      kind: number;
      market: Address;
      units: bigint;
    };
    const [t0, t1] = (await client.readContract({ address: p.market, abi: marketAbi, functionName: "tokens" })) as [Address, Address];
    out.push({
      n: out.length + 1,
      id: s.shareId,
      resource,
      kind: p.kind === 1 ? "DAMM" : "DLMM",
      market: getAddress(p.market),
      tokens: [await tokenInfo(getAddress(t0)), await tokenInfo(getAddress(t1))],
      units,
      total: p.units,
    });
  }
  return out;
}

const previewExit = async (p: Position, units: bigint) =>
  (await client.readContract({ address: LIQUIDITY_ADAPTER!, abi: adapterAbi, functionName: "previewExit", args: [p.id, units] })) as [bigint, bigint];

function assetBySymbol(symbol: string): Asset {
  const a = assets.find((x) => x.symbol.toLowerCase() === symbol.toLowerCase());
  if (!a) throw new Error(`Unknown asset ${symbol}. Known: ${assets.map((x) => x.symbol).join(", ")}`);
  return a;
}

function pick(notes: OwnedNote[], asset: { symbol: string; decimals: number; resource: bigint }, needed: bigint) {
  const mine = notes.filter((n) => n.resource === asset.resource);
  const sel = selectNotes(mine, needed);
  if (sel) return sel;
  const total = mine.reduce((s, n) => s + n.amount, 0n);
  if (total < needed) throw new Error(`Spendable ${asset.symbol} is ${formatUnits(total, asset.decimals)}, less than ${formatUnits(needed, asset.decimals)}.`);
  throw new Error("This needs more than two notes. Combine notes first with a transfer to your own address.");
}

const sha256File = (path: string) => `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

async function prove(name: "transfer" | "withdraw", input: Record<string, unknown>, expected: bigint[]) {
  const c = (manifest.circuits as { name: string; wasmHash: string; zkeyHash: string }[]).find((x) => x.name === name);
  if (!c) throw new Error(`The ${name} circuit is not in the manifest.`);
  const dir = join(ROOT, "circuits", "artifacts", NETWORK);
  const wasm = join(dir, `${name}.wasm`);
  const zkey = join(dir, `${name}.zkey`);
  if (sha256File(wasm) !== c.wasmHash || sha256File(zkey) !== c.zkeyHash) throw new Error("Circuit files do not match the manifest hashes. Stopped.");
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  if ((publicSignals as string[]).join() !== expected.map(String).join()) throw new Error("Proof public inputs differ from the plan. Stopped.");
  console.error(`Proof generated in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  return toSolidityProof(proof);
}

async function submit(functionName: "transfer" | "withdraw" | "execute", args: readonly unknown[]) {
  const key = process.env.WALLET_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    console.log(JSON.stringify({ to: POOL, chainId: manifest.chainId, data: encodeFunctionData({ abi, functionName, args }) }, null, 2));
    console.error("No WALLET_PRIVATE_KEY set: send the calldata above to the pool from any wallet before the deadline (20 minutes).");
    return;
  }
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const { request } = await client.simulateContract({ account, address: POOL, abi, functionName, args });
  const hash = await wallet.writeContract(request);
  console.error(`Sent ${hash}, waiting for confirmation…`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({ status: receipt.status, txHash: hash, block: Number(receipt.blockNumber) }));
  if (receipt.status !== "success") process.exitCode = 1;
}

const deadline = async () => (await client.getBlock()).timestamp + DEADLINE_SECONDS;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "address") {
    const keys = deriveKeys(phraseToEntropy(await readPhrase()));
    console.log(encodeAddress(keys));
    return;
  }
  if (cmd === "balance") {
    const { notes, positions } = await load();
    console.log(`Pool ${POOL} (${poolName})`);
    for (const a of assets) {
      const mine = notes.filter((n) => n.resource === a.resource);
      console.log(`${a.symbol}: ${formatUnits(mine.reduce((s, n) => s + n.amount, 0n), a.decimals)} in ${mine.length} note(s)`);
      for (const n of mine) console.log(`  note #${n.leafIndex}: ${formatUnits(n.amount, a.decimals)}`);
    }
    for (const p of positions) {
      const [a0, a1] = await previewExit(p, p.units);
      console.log(
        `Position ${p.n}: ${p.kind} ${p.tokens[0].symbol}/${p.tokens[1].symbol} market ${p.market}, ${formatUnits((p.units * 10n ** 20n) / p.total, 18)}% of it, ` +
          `worth ${formatUnits(a0, p.tokens[0].decimals)} ${p.tokens[0].symbol} + ${formatUnits(a1, p.tokens[1].decimals)} ${p.tokens[1].symbol} with fees`,
      );
      console.log(`  id ${p.id}`);
    }
    return;
  }
  if (cmd === "exit") {
    const [which, pctText, recipient] = args;
    const pct = Number(pctText);
    if (!which || !Number.isInteger(pct) || pct < 1 || pct > 100 || (recipient && !isAddress(recipient))) throw new Error("Usage: exit <position> <percent 1-100> [0xrecipient]");
    if (!LIQUIDITY_ADAPTER) throw new Error("This pool has no liquidity adapter.");
    const s = await load();
    const p = s.positions.find((x) => String(x.n) === which || x.id.toString() === which || `0x${x.id.toString(16)}` === which.toLowerCase());
    if (!p) throw new Error(`No position ${which}. Run balance to list them.`);
    const units = (p.units * BigInt(pct)) / 100n;
    const [out0, out1] = await previewExit(p, units);
    const min = (x: bigint) => (x * 99n) / 100n; // 1% slippage
    const resource = shareResource(LIQUIDITY_ADAPTER, p.id);
    const plan = planExecute({
      spendingKey: s.keys.spendingKey,
      tree: s.tree,
      chainId: manifest.chainId,
      pool: POOL,
      domain: s.domain,
      adapter: LIQUIDITY_ADAPTER,
      params: encodeExit({ positionId: p.id, min0: min(out0), min1: min(out1) }),
      legs: [{ resource, amount: units, fee: 0n, inputs: pick(s.notes, { symbol: `position ${p.n} shares`, decimals: 18, resource }, units) }],
      outputs: p.tokens.map((t) =>
        recipient ? { kind: "public" as const, recipient: getAddress(recipient) } : { kind: "note" as const, to: s.keys, resource: fungibleResource(t.address) },
      ),
      changeTo: s.keys,
      feeRecipient: "0x0000000000000000000000000000000000000000",
      withdrawFeeBps: s.withdrawFeeBps,
      deadline: await deadline(),
    });
    console.error(
      `Exiting ${pct}% of position ${p.n}: about ${formatUnits(out0, p.tokens[0].decimals)} ${p.tokens[0].symbol} + ${formatUnits(out1, p.tokens[1].decimals)} ${p.tokens[1].symbol}` +
        (recipient ? ` to ${recipient}, less the ${s.withdrawFeeBps / 100}% withdrawal fee.` : " back to your notes."),
    );
    const proofs = [];
    for (const leg of plan.legs) proofs.push(await prove("withdraw", leg.circuitInput, leg.publicSignals));
    await submit("execute", [withProofs(plan, proofs)]);
    return;
  }
  if (cmd === "withdraw") {
    const [symbol, amountText, recipient] = args;
    if (!symbol || !amountText || !recipient || !isAddress(recipient)) throw new Error("Usage: withdraw <SYMBOL> <amount> <0xrecipient>");
    const asset = assetBySymbol(symbol);
    const amount = parseUnits(amountText, asset.decimals);
    const s = await load();
    const plan = planWithdraw({
      spendingKey: s.keys.spendingKey,
      tree: s.tree,
      chainId: manifest.chainId,
      pool: POOL,
      domain: s.domain,
      resource: asset.resource,
      inputs: pick(s.notes, asset, amount),
      fee: 0n,
      feeRecipient: "0x0000000000000000000000000000000000000000",
      deadline: await deadline(),
      token: asset.address,
      amount,
      recipient: getAddress(recipient),
      withdrawFeeBps: s.withdrawFeeBps,
      changeTo: s.keys,
    });
    console.error(`Withdrawing ${amountText} ${asset.symbol}; the recipient receives ${formatUnits(plan.netToRecipient, asset.decimals)} after the ${s.withdrawFeeBps / 100}% fee.`);
    const proof = await prove("withdraw", plan.circuitInput, plan.publicSignals);
    await submit("withdraw", [proof, plan.args]);
    return;
  }
  if (cmd === "transfer") {
    const [symbol, amountText, to] = args;
    if (!symbol || !amountText || !to) throw new Error("Usage: transfer <SYMBOL> <amount> <cvl1…>");
    const asset = assetBySymbol(symbol);
    const amount = parseUnits(amountText, asset.decimals);
    const recipient = decodeAddress(to);
    const s = await load();
    const plan = planTransfer({
      spendingKey: s.keys.spendingKey,
      tree: s.tree,
      chainId: manifest.chainId,
      pool: POOL,
      domain: s.domain,
      resource: asset.resource,
      inputs: pick(s.notes, asset, amount),
      fee: 0n,
      feeRecipient: "0x0000000000000000000000000000000000000000",
      deadline: await deadline(),
      to: recipient,
      amount,
      changeTo: s.keys,
    });
    const proof = await prove("transfer", plan.circuitInput, plan.publicSignals);
    await submit("transfer", [proof, plan.args]);
    return;
  }
  console.error(readFileSync(import.meta.filename, "utf8").split("*/")[0]);
  process.exitCode = 2;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
