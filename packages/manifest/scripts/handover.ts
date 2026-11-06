/**
 * Builds the batch that hands every Curveil admin role to the timelock.
 *
 * Deploy scripts hand ownership to `.admin` (the timelock) with Ownable2Step, so each contract
 * waits in `pendingOwner` until the timelock calls `acceptOwnership()`. This script finds every
 * deployed contract whose pending owner is the timelock and writes:
 *   - deployments/<network>.handover.json: a Safe Transaction Builder file with two transactions,
 *     timelock.scheduleBatch(...) now and timelock.executeBatch(...) after the delay;
 *   - a summary of who owns what, so nothing is missed.
 *
 * Usage: NETWORK=mainnet pnpm --filter @curveil/manifest handover
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, toBytes, zeroHash, type Address } from "viem";
import { NETWORKS, type NetworkName } from "../src/index";

const network = (process.env.NETWORK ?? "testnet") as NetworkName;
const chainId = NETWORKS[network];
const contractsDir = resolve(import.meta.dirname, "../../contracts");
const nets = JSON.parse(readFileSync(resolve(import.meta.dirname, "../networks.json"), "utf8"));
const client = createPublicClient({ transport: http(nets[network].rpc[0]) });

const ownable = [
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "pendingOwner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "acceptOwnership", inputs: [], outputs: [], stateMutability: "nonpayable" },
] as const;
const timelockAbi = [
  { type: "function", name: "getMinDelay", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "scheduleBatch",
    inputs: [
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "payloads", type: "bytes[]" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
      { name: "delay", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeBatch",
    inputs: [
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "payloads", type: "bytes[]" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

async function main() {
  const live = await client.getChainId();
  if (live !== chainId) throw new Error(`RPC reports chain ${live}, expected ${chainId}`);
  const gov = JSON.parse(readFileSync(resolve(contractsDir, `deployments/${network}.governance.json`), "utf8"));
  const timelock = getAddress(gov.timelock) as Address;
  const delay = await client.readContract({ address: timelock, abi: timelockAbi, functionName: "getMinDelay" });

  // Every address in every deployment file of this network, by name.
  const seen = new Map<Address, string>();
  for (const f of readdirSync(resolve(contractsDir, "deployments"))) {
    if (!f.startsWith(`${network}.`) || f.endsWith(".handover.json") || f.endsWith(".governance.json")) continue;
    const d = JSON.parse(readFileSync(resolve(contractsDir, "deployments", f), "utf8"));
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) seen.set(getAddress(v) as Address, `${f.split(".")[1]}.${k}`);
    }
  }

  const accept: { name: string; address: Address }[] = [];
  const report: string[] = [];
  for (const [address, name] of seen) {
    const code = await client.getCode({ address });
    if (!code || code === "0x") continue;
    const owner = await client.readContract({ address, abi: ownable, functionName: "owner" }).catch(() => null);
    if (owner === null) {
      report.push(`  ${name.padEnd(40)} no owner (immutable)`);
      continue;
    }
    const pending = await client.readContract({ address, abi: ownable, functionName: "pendingOwner" }).catch(() => null);
    const state = getAddress(owner) === timelock ? "owned by the timelock" : pending && getAddress(pending) === timelock ? "pending: will be accepted" : `OWNED BY ${owner}`;
    if (state.startsWith("pending")) accept.push({ name, address });
    report.push(`  ${name.padEnd(40)} ${state}`);
  }

  const targets = accept.map((a) => a.address);
  const values = targets.map(() => 0n);
  const payloads = targets.map(() => encodeFunctionData({ abi: ownable, functionName: "acceptOwnership" }));
  const salt = keccak256(toBytes(`curveil.handover.${network}.${targets.join(",")}`));
  const schedule = encodeFunctionData({ abi: timelockAbi, functionName: "scheduleBatch", args: [targets, values, payloads, zeroHash, salt, delay] });
  const execute = encodeFunctionData({ abi: timelockAbi, functionName: "executeBatch", args: [targets, values, payloads, zeroHash, salt] });

  const out = {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name: `Curveil ${network}: hand admin roles to the timelock`, description: `Accepts ownership of ${targets.length} contracts. Send "schedule" now and "execute" after ${delay} seconds.` },
    contracts: accept,
    transactions: [
      { to: timelock, value: "0", data: schedule, label: "schedule" },
      { to: timelock, value: "0", data: execute, label: "execute (after the delay)" },
    ],
  };
  const path = resolve(contractsDir, `deployments/${network}.handover.json`);
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(`Timelock ${timelock}, delay ${delay}s`);
  console.log(report.sort().join("\n"));
  console.log(`\n${targets.length} contracts to accept. Wrote ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
