/**
 * Governance (Phase 7): the timelock queue, the protocol treasuries and the buyback burner, for
 * the Transparency page. Events come from the indexer; balances are read live.
 */
import { Hono } from "hono";
import { decodeFunctionResult, encodeFunctionData, getAddress, type Abi } from "viem";
import { loadManifest, type Env } from "./lib";
import { multicallSettled, type Call } from "./indexer/rpc";
import { burnerAbi, timelockQueue } from "./indexer/governance";

export const governance = new Hono<{ Bindings: Env }>();

const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const satisfies Abi;

type Row = { tx_hash: string; timestamp: number; kind: string; op_id: string | null; data: string; block_number: number; log_index: number; contract: string };

governance.get("/governance", async (c) => {
  const { manifest } = await loadManifest(c.env);
  const named = (prefix: string) => Object.entries(manifest.contracts).filter(([n]) => n.startsWith(prefix));
  const treasuries = named("Treasury").map(([name, t]) => ({ name, address: getAddress(t.address) }));
  const burner = manifest.contracts.BuybackBurner ?? null;
  const usdg = manifest.assets.find((a) => a.label === "USDG") ?? null;

  const [timelockRows, releaseRows, burnRows] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM governance_events WHERE contract = 'CurveilTimelock' AND kind IN ('CallScheduled', 'CallExecuted', 'Cancelled')").all<Row>(),
    c.env.DB.prepare("SELECT * FROM governance_events WHERE contract LIKE 'Treasury%' AND kind = 'Released' ORDER BY block_number DESC, log_index DESC LIMIT 20").all<Row>(),
    c.env.DB.prepare("SELECT * FROM governance_events WHERE contract = 'BuybackBurner' AND kind IN ('Burned', 'Returned') ORDER BY block_number DESC, log_index DESC LIMIT 20").all<Row>(),
  ]);

  // Live balances: every admitted asset in every treasury and in the burner, plus the burned supply.
  const holders = [...treasuries.map((t) => t.address), ...(burner ? [getAddress(burner.address)] : [])];
  const calls: Call[] = holders.flatMap((h) =>
    manifest.assets.map((a) => ({ target: a.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [h] }) })),
  );
  if (burner) calls.push({ target: burner.address, data: encodeFunctionData({ abi: burnerAbi, functionName: "burnedSupply" }) });
  let raw: (`0x${string}` | null)[] = [];
  try {
    raw = await multicallSettled(c.env.RPC_URL, calls);
  } catch {
    raw = calls.map(() => null);
  }
  const balanceAt = (i: number) => (raw[i] ? (decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: raw[i]! }) as bigint).toString() : null);
  const balancesOf = (h: number) => Object.fromEntries(manifest.assets.map((a, j) => [a.symbol, balanceAt(h * manifest.assets.length + j)]));
  const burnedRaw = burner ? raw[calls.length - 1] : null;

  const parse = (r: Row) => ({ ...(JSON.parse(r.data) as Record<string, string>), contract: r.contract, timestamp: r.timestamp, txHash: r.tx_hash, kind: r.kind });
  const now = Math.floor(Date.now() / 1000);
  c.header("Cache-Control", "public, max-age=15");
  return c.json({
    network: manifest.network,
    safe: manifest.admin.safe,
    owner: manifest.admin.owner,
    timelock: manifest.admin.timelock ? { address: manifest.admin.timelock, delaySeconds: manifest.admin.timelockDelaySeconds } : null,
    queue: timelockQueue(timelockRows.results, now).slice(0, 50),
    treasuries: treasuries.map((t, i) => ({ ...t, balances: balancesOf(i) })),
    releases: releaseRows.results.map(parse),
    buyback: burner
      ? {
          address: getAddress(burner.address),
          usdg: usdg ? balancesOf(treasuries.length)[usdg.symbol] ?? null : null,
          burnedSupply: burnedRaw ? (decodeFunctionResult({ abi: burnerAbi, functionName: "burnedSupply", data: burnedRaw }) as bigint).toString() : null,
          recent: burnRows.results.map(parse),
        }
      : null,
  });
});
