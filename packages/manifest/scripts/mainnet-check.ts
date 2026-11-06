/**
 * Checks the mainnet inputs listed in mainnet.env.example.
 *
 * Reads them from the environment (the project's cloud environment settings) and, if it
 * exists, from a local `.env.mainnet` at the repository root (gitignored). Secret values are
 * never printed: only whether they are set and whether they work.
 *
 * Usage: pnpm mainnet:check            report only
 *        pnpm mainnet:check --write    also write the Safe into config/mainnet.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, formatEther, getAddress, http, isAddress, type Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";

const root = resolve(import.meta.dirname, "../../..");
const MAINNET = 4663;
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const TESTNET_DEPLOYER = "0x37376BC0181A818Bc3EE5Ff487aE4598a7fD26B4";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = resolve(root, ".env.mainnet");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m?.[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v) out[k] = v;
  return out;
}

type Row = { name: string; secret: boolean; state: "ok" | "missing" | "problem" | "later"; note: string };
const rows: Row[] = [];
const add = (name: string, secret: boolean, state: Row["state"], note = "") => rows.push({ name, secret, state, note });

const safeAbi = [
  { type: "function", name: "getThreshold", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getOwners", inputs: [], outputs: [{ type: "address[]" }], stateMutability: "view" },
] as const;
const erc20Abi = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

async function main() {
  const env = loadEnv();
  const write = process.argv.includes("--write");

  // RPC first: everything else is checked through it (or the public RPC if it is missing).
  let rpc = PUBLIC_RPC;
  if (!env.MAINNET_RPC_URL) add("MAINNET_RPC_URL", true, "missing", "using the public RPC for these checks");
  else {
    try {
      const c = createPublicClient({ transport: http(env.MAINNET_RPC_URL) });
      const id = await c.getChainId();
      if (id !== MAINNET) add("MAINNET_RPC_URL", true, "problem", `reports chain ${id}, expected ${MAINNET}`);
      else {
        const block = await c.getBlockNumber();
        add("MAINNET_RPC_URL", true, "ok", `chain ${id}, block ${block}`);
        rpc = env.MAINNET_RPC_URL;
      }
    } catch {
      add("MAINNET_RPC_URL", true, "problem", "does not answer");
    }
  }
  const client = createPublicClient({ transport: http(rpc) });

  // Safe.
  let safe: Address | null = null;
  const v = env.MAINNET_SAFE;
  if (!v) add("MAINNET_SAFE", false, "missing");
  else if (!isAddress(v)) add("MAINNET_SAFE", false, "problem", "not an address");
  else {
    safe = getAddress(v);
    const code = await client.getCode({ address: safe });
    if (!code || code === "0x") add("MAINNET_SAFE", false, "problem", "no contract at this address on mainnet");
    else {
      try {
        const [threshold, owners] = await Promise.all([
          client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
          client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
        ]);
        const agreed = threshold >= 3n && owners.length >= 3 && threshold <= BigInt(owners.length);
        add("MAINNET_SAFE", false, agreed ? "ok" : "problem", `${threshold} of ${owners.length} signers${agreed ? "" : " (agreed: at least 3 signers, 3 required)"}`);
        const listed = (env.MAINNET_SAFE_SIGNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!listed.length) add("MAINNET_SAFE_SIGNERS", false, "missing");
        else {
          const onchain = new Set(owners.map((o) => o.toLowerCase()));
          const bad = listed.filter((s) => !isAddress(s) || !onchain.has(s.toLowerCase()));
          add("MAINNET_SAFE_SIGNERS", false, bad.length ? "problem" : "ok", bad.length ? `${bad.length} listed signer(s) are not on the Safe` : `all ${listed.length} match the Safe`);
        }
      } catch {
        add("MAINNET_SAFE", false, "problem", "contract is not a Safe");
      }
    }
  }
  if (!safe && !env.MAINNET_SAFE_SIGNERS) add("MAINNET_SAFE_SIGNERS", false, "missing");

  // Deployer: a fresh wallet with gas, never the testnet one.
  if (!env.MAINNET_DEPLOYER_KEY) add("MAINNET_DEPLOYER_KEY", true, "missing");
  else {
    try {
      const key = env.MAINNET_DEPLOYER_KEY.startsWith("0x") ? env.MAINNET_DEPLOYER_KEY : `0x${env.MAINNET_DEPLOYER_KEY}`;
      const addr = privateKeyToAddress(key as `0x${string}`);
      if (addr.toLowerCase() === TESTNET_DEPLOYER.toLowerCase()) add("MAINNET_DEPLOYER_KEY", true, "problem", "this is the testnet deployer; use a new wallet");
      else {
        const [bal, nonce] = await Promise.all([client.getBalance({ address: addr }), client.getTransactionCount({ address: addr })]);
        // The first launch (governance, markets, launches, launchpads) is about 32M gas; the vault
        // and perps about 35M more. At the gas price now, with a 3x margin for spikes.
        const gasPrice = await client.getGasPrice();
        const margin = 32_000_000n * gasPrice * 3n;
        const need = margin > 2_000_000_000_000_000n ? margin : 2_000_000_000_000_000n; // at least 0.002 ETH
        const enough = bal >= need;
        add("MAINNET_DEPLOYER_KEY", true, enough ? "ok" : "problem", `${addr}, ${formatEther(bal)} ETH${enough ? "" : ` (needs about ${formatEther(need)} at today's gas price)`}${nonce > 0 ? `, already sent ${nonce} transactions` : ", fresh"}`);
      }
    } catch {
      add("MAINNET_DEPLOYER_KEY", true, "problem", "not a valid private key");
    }
  }

  add("CLOUDFLARE_API_TOKEN", true, env.CLOUDFLARE_API_TOKEN ? "ok" : "missing", env.CLOUDFLARE_API_TOKEN ? "set" : "");
  for (const k of ["MAINNET_BROADCASTER_KEY", "MAINNET_KEEPER_KEY"]) {
    add(k, true, env[k] ? "ok" : "later", env[k] ? "set" : "optional: generated at deploy if empty");
  }

  const url = (k: string, secret: boolean) => {
    const s = env[k];
    if (!s) return add(k, secret, "missing");
    try {
      const u = new URL(s);
      add(k, secret, u.protocol === "https:" ? "ok" : "problem", u.protocol === "https:" ? (secret ? "set" : u.host) : "must be https");
    } catch {
      add(k, secret, "problem", "not a URL");
    }
  };
  url("ALERT_WEBHOOK_URL", true);
  url("SECOND_BROADCASTER_URL", false);
  url("BUG_BOUNTY_URL", false);
  url("CURVEIL_X_URL", false);

  if (!env.CURVEIL_TOKEN) add("CURVEIL_TOKEN", false, "missing");
  else if (!isAddress(env.CURVEIL_TOKEN)) add("CURVEIL_TOKEN", false, "problem", "not an address");
  else {
    try {
      const t = getAddress(env.CURVEIL_TOKEN);
      const sym = await client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" });
      add("CURVEIL_TOKEN", false, "ok", `symbol ${sym}`);
    } catch {
      add("CURVEIL_TOKEN", false, "problem", "no token at this address on mainnet");
    }
  }

  // Perps prices: Pyth's contract on mainnet must know every market's price id.
  {
    const cfg = JSON.parse(readFileSync(resolve(root, "packages/contracts/config/mainnet.json"), "utf8"));
    const pyth = cfg.perps?.priceSource === "pyth" ? (cfg.perps.pyth?.address as string | undefined) : undefined;
    if (!pyth) add("perps.pyth", false, "later", `price source ${cfg.perps?.priceSource ?? "unset"}`);
    else {
      try {
        const pythAbi = [{ type: "function", name: "priceFeedExists", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" }] as const;
        const ids = ((cfg.perps.markets ?? []) as { feed: string; pythId?: `0x${string}` }[]).map((m) => [m.feed, m.pythId] as const);
        const missing: string[] = [];
        for (const [feed, id] of ids) {
          if (!id || !(await client.readContract({ address: getAddress(pyth), abi: pythAbi, functionName: "priceFeedExists", args: [id] }))) missing.push(feed);
        }
        add("perps.pyth", false, missing.length ? "problem" : "ok", missing.length ? `Pyth has no price for ${missing.join(", ")}` : `Pyth at ${pyth}, ${ids.length} feeds`);
      } catch {
        add("perps.pyth", false, "problem", "Pyth does not answer at the configured address");
      }
    }
    add("HERMES_URL", false, "ok", env.HERMES_URL ? "set" : "Pyth's public Hermes");
    add("PYTH_API_KEY", true, env.PYTH_API_KEY ? "ok" : "missing", env.PYTH_API_KEY ? "set" : "Hermes refuses requests without a Pyth API key");
  }

  // Fee recipients. Left at zero, the deploy scripts send fees to the module treasuries and LP
  // locks to the timelock (script/FeeRecipients.sol), so nothing leaves without a Safe vote and
  // the delay. Any other address could spend fees on its own.
  {
    const cfg = JSON.parse(readFileSync(resolve(root, "packages/contracts/config/mainnet.json"), "utf8"));
    const keys: [string, string][] = [
      ["markets.feeTo", cfg.markets?.feeTo],
      ["launch.protocolFeeRecipient", cfg.launch?.protocolFeeRecipient],
      ["launch.protocolLpRecipient", cfg.launch?.protocolLpRecipient],
      ["vault.protocolFeeRecipient", cfg.vault?.protocolFeeRecipient],
      ["perps.feeRecipient", cfg.perps?.feeRecipient],
    ];
    const zero = /^0x0{40}$/i;
    // A missing key belongs to a module whose config is not written yet; it defaults the same way.
    const other = keys.filter(([, a]) => a && !(zero.test(a) || (safe && isAddress(a) && getAddress(a) === safe)));
    const toSafe = keys.filter(([, a]) => safe && a && isAddress(a) && getAddress(a) === safe).length;
    add(
      "Fee recipients",
      false,
      other.length ? "problem" : "ok",
      other.length
        ? `${other.map(([k]) => k).join(", ")} ${other.length === 1 ? "is" : "are"} not the Safe or a treasury (leave at zero for the treasury)`
        : toSafe
          ? `${toSafe} go to the Safe, ${keys.length - toSafe} to the treasuries; every payout needs a Safe vote`
          : "all go to the module treasuries, LP locks to the timelock; every payout needs a Safe vote and the delay",
    );
  }

  const mark = { ok: "✓", missing: "·", problem: "✗", later: "○" } as const;
  for (const r of rows) console.log(`${mark[r.state]} ${r.name.padEnd(28)} ${r.secret ? "secret " : "public "} ${r.note}`);
  const missing = rows.filter((r) => r.state === "missing").length;
  const problems = rows.filter((r) => r.state === "problem").length;
  console.log(`\n${rows.filter((r) => r.state === "ok").length} ready, ${missing} missing, ${problems} with a problem.`);

  if (write && safe && rows.find((r) => r.name === "MAINNET_SAFE")?.state === "ok") {
    const path = resolve(root, "packages/contracts/config/mainnet.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    cfg.governance.safe = safe;
    cfg.perps.guardian = safe;
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`Wrote the Safe into ${path}.`);
  }
  if (problems) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
