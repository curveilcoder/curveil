/**
 * Connects $CURVEIL to Curveil once the token exists and has a USDG pool on Curveil's DAMM.
 *
 *   1. Checks the token (an ERC-20).
 *   2. Writes the token address into networks.json, so the next manifest build (and so the site's
 *      contract-address chip and the API) carries it. Then finds the token's DAMM pool against
 *      USDG; without one that has liquidity it stops here, and linking the burner waits.
 *   3. Writes deployments/<network>.bind-token.json: a Safe Transaction Builder file that schedules
 *      BuybackBurner.bind(token, pool) in the timelock now and executes it after the delay. bind()
 *      can be called once only, so the batch is checked against the chain before it is written.
 *   4. Writes the same two transactions for the site's /safe page (apps/web/src/data), with the
 *      Safe nonces they will use: after every action already on that page. Redeploy the site.
 *
 * Usage: NETWORK=mainnet pnpm --filter @curveil/manifest bind-token <token address>
 *        NETWORK=testnet ... bind-token <token> --send      testnet only: schedule with the deployer
 *        NETWORK=testnet ... bind-token <token> --execute   testnet only: execute after the delay
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, keccak256, toBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, parseManifest, type NetworkName } from "../src/index";

const network = (process.env.NETWORK ?? "testnet") as NetworkName;
const chainId = NETWORKS[network];
const here = import.meta.dirname;
const contractsDir = resolve(here, "../../contracts");
const netsPath = resolve(here, "../networks.json");
const nets = JSON.parse(readFileSync(netsPath, "utf8"));
const rpc = (network === "mainnet" ? process.env.MAINNET_RPC_URL : process.env.RPC_TESTNET) ?? nets[network].rpc[0];
const client = createPublicClient({ transport: http(rpc) });

const args = process.argv.slice(2).filter((a) => a !== "--");
const tokenArg = args.find((a) => isAddress(a));
const send = args.includes("--send");
const execute = args.includes("--execute");

const erc20 = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
const factoryAbi = [{ type: "function", name: "getPool", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }], stateMutability: "view" }] as const;
const poolAbi = [{ type: "function", name: "getReserves", inputs: [], outputs: [{ type: "uint128" }, { type: "uint128" }], stateMutability: "view" }] as const;
const burnerAbi = [
  { type: "function", name: "token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "bind", inputs: [{ type: "address" }, { type: "address" }], outputs: [], stateMutability: "nonpayable" },
] as const;
const timelockAbi = [
  { type: "function", name: "getMinDelay", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "isOperationReady", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isOperation", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  {
    type: "function",
    name: "hashOperation",
    inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "schedule",
    inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execute",
    inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

const safeNonceAbi = [{ type: "function", name: "nonce", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;

function fail(msg: string): never {
  console.error(`Stopped: ${msg}`);
  process.exit(1);
}

async function main() {
  if (!tokenArg) fail("give the $CURVEIL token address");
  if ((send || execute) && network !== "testnet") fail("--send and --execute are for testnet; on mainnet the Safe signs the batch");
  const token = getAddress(tokenArg);
  const manifest = parseManifest(JSON.parse(readFileSync(resolve(here, `../manifests/${network}.json`), "utf8")));
  const need = (name: string) => getAddress(manifest.contracts[name]?.address ?? fail(`the ${network} manifest has no ${name}`));
  const burner = need("BuybackBurner");
  const timelock = need("CurveilTimelock");
  const factory = need("DammFactory");
  const usdg = getAddress(manifest.assets.find((a) => a.label === "USDG")?.address ?? fail("no USDG in the manifest"));

  const [symbol, decimals, supply] = await Promise.all([
    client.readContract({ address: token, abi: erc20, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20, functionName: "totalSupply" }),
  ]).catch(() => fail("no ERC-20 at that address on this network"));
  console.log(`Token ${symbol} (${decimals} decimals), supply ${supply}`);

  // 2. The token goes into the next manifest.
  if (nets[network].token.address !== token) {
    // Change only this network's token line, keeping the file's layout.
    const text = readFileSync(netsPath, "utf8");
    const at = text.indexOf(`"${network}"`);
    const line = /"token": \{ "symbol": "CURVEIL", "address": (null|"0x[0-9a-fA-F]{40}") \}/g;
    line.lastIndex = at;
    const m = line.exec(text);
    if (!m) fail("could not find the token line in networks.json");
    writeFileSync(netsPath, text.slice(0, m.index) + `"token": { "symbol": "CURVEIL", "address": "${token}" }` + text.slice(m.index + m[0].length));
    console.log(`Wrote the token into networks.json (${network}). Rebuild the manifest to publish it.`);
  }
  const pool = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getPool", args: [token, usdg] });
  // Without a funded USDG pool the address still goes on the site; linking the burner waits.
  const later = (why: string) => {
    console.log(`Not linking the buyback burner yet: ${why}. Run this again once that is done.`);
    process.exit(0);
  };
  if (pool === zeroAddress) later(`no DAMM ${symbol}/USDG pool yet (a USDG launch creates it at graduation; otherwise create one and add liquidity)`);
  const [r0, r1] = await client.readContract({ address: pool, abi: poolAbi, functionName: "getReserves" });
  if (r0 === 0n || r1 === 0n) later(`the pool ${pool} has no liquidity yet`);
  console.log(`Pool ${pool}, reserves ${r0} / ${r1}`);

  const [bound, owner] = await Promise.all([
    client.readContract({ address: burner, abi: burnerAbi, functionName: "token" }),
    client.readContract({ address: burner, abi: burnerAbi, functionName: "owner" }),
  ]);
  if (bound !== zeroAddress && getAddress(bound) !== token) fail(`the burner is already bound to ${bound}; bind() works once only`);
  if (getAddress(owner) !== timelock) fail(`the burner's owner is ${owner}, not the timelock`);

  if (bound !== zeroAddress) return console.log("The burner is already bound to this token. Nothing to schedule.");

  // 3. The timelock batch.
  const delay = await client.readContract({ address: timelock, abi: timelockAbi, functionName: "getMinDelay" });
  const data = encodeFunctionData({ abi: burnerAbi, functionName: "bind", args: [token, pool] });
  const salt = keccak256(toBytes(`curveil.bind-token.${network}.${token}`));
  const schedule = encodeFunctionData({ abi: timelockAbi, functionName: "schedule", args: [burner, 0n, data, zeroHash, salt, delay] });
  const exec = encodeFunctionData({ abi: timelockAbi, functionName: "execute", args: [burner, 0n, data, zeroHash, salt] });
  const id = await client.readContract({ address: timelock, abi: timelockAbi, functionName: "hashOperation", args: [burner, 0n, data, zeroHash, salt] });
  const out = {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name: `Curveil ${network}: bind ${symbol} to the buyback burner`, description: `BuybackBurner.bind(${token}, ${pool}). Send "schedule" now and "execute" after ${delay} seconds. Operation ${id}.` },
    transactions: [
      { to: timelock, value: "0", data: schedule, label: "schedule" },
      { to: timelock, value: "0", data: exec, label: "execute (after the delay)" },
    ],
  };
  const path = resolve(contractsDir, `deployments/${network}.bind-token.json`);
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(`Operation ${id}, delay ${delay}s. Wrote ${path}`);

  // 4. The same two transactions for the /safe page, numbered after what is already there.
  const safe = manifest.admin?.safe;
  if (safe) {
    const webData = resolve(here, "../../../apps/web/src/data");
    const webFile = `bind-token-${network}.json`;
    const safeNonce = await client.readContract({ address: getAddress(safe), abi: safeNonceAbi, functionName: "nonce" });
    let next = safeNonce;
    for (const f of readdirSync(webData).filter((f) => f.endsWith(".json") && f !== webFile)) {
      const p = JSON.parse(readFileSync(resolve(webData, f), "utf8"));
      if (p.chainId !== chainId || !Array.isArray(p.steps)) continue;
      for (const st of p.steps) if (BigInt(st.nonce) + 1n > next) next = BigInt(st.nonce) + 1n;
    }
    const plan = {
      chainId,
      name: `Curveil ${network}: link ${symbol} to the buyback burner`,
      summary: `Lets the buyback burner buy ${symbol} through its USDG pool ${pool} and burn it. This can be done once only.`,
      steps: [
        { key: "bind-schedule", label: "Step 1: schedule it", to: timelock, value: "0", data: schedule, nonce: String(next) },
        { key: "bind-execute", label: "Step 2: carry it out", to: timelock, value: "0", data: exec, nonce: String(next + 1n) },
      ],
    };
    writeFileSync(resolve(webData, webFile), JSON.stringify(plan, null, 2) + "\n");
    console.log(`Wrote apps/web/src/data/${webFile} (Safe nonces ${next} and ${next + 1n}). Redeploy the site for /safe.`);
  }

  if (send || execute) {
    const key = process.env.DEPLOYER_PRIVATE_KEY;
    if (!key) fail("DEPLOYER_PRIVATE_KEY is not set");
    const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
    const wallet = createWalletClient({ account, transport: http(rpc), chain: { id: chainId, name: network, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } });
    const exists = await client.readContract({ address: timelock, abi: timelockAbi, functionName: "isOperation", args: [id] });
    let hash: Hex;
    if (send) {
      if (exists) return console.log("Already scheduled.");
      hash = await wallet.sendTransaction({ to: timelock as Address, data: schedule });
    } else {
      if (!(await client.readContract({ address: timelock, abi: timelockAbi, functionName: "isOperationReady", args: [id] }))) fail("not ready yet: the delay has not passed, or it was never scheduled");
      hash = await wallet.sendTransaction({ to: timelock as Address, data: exec });
    }
    const r = await client.waitForTransactionReceipt({ hash });
    console.log(`${send ? "Scheduled" : "Executed"}: ${r.status} ${hash}`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
