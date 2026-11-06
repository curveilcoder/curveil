/**
 * Vault sync API (plan: "deliberately dumb"). Returns every commitment with its ciphertext in
 * leaf order and every spent nullifier, so each browser finds its own notes locally. Nothing
 * here takes an account, a key or a note as input.
 */
import { Hono } from "hono";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Hex } from "viem";
import { loadManifest, type Env } from "./lib";
import { multicall } from "./indexer/rpc";
import { shieldedPoolAbi } from "./indexer/vault";

export const vault = new Hono<{ Bindings: Env }>();

const MAX_COMMITMENTS = 2000;
const MAX_NULLIFIERS = 5000;

async function poolOf(env: Env) {
  const { manifest } = await loadManifest(env);
  const pool = manifest.contracts.ShieldedPool;
  return pool ? { manifest, pool } : null;
}

const notDeployed = { error: "not_deployed", message: "The shielded vault is not deployed on this network yet." } as const;

async function indexedThrough(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT indexed_block FROM indexer_state WHERE id = 1").first<{ indexed_block: number | null }>();
  return row?.indexed_block ?? null;
}

/** Live pool state plus what the indexer has, so a client can tell "still syncing" from "done". */
vault.get("/vault/status", async (c) => {
  const found = await poolOf(c.env);
  if (!found) return c.json(notDeployed, 404);
  const { manifest, pool } = found;
  const call = (functionName: string, args: unknown[] = []) => ({
    target: pool.address,
    data: encodeFunctionData({ abi: shieldedPoolAbi, functionName, args } as never),
  });
  const read = <T>(data: Hex, functionName: string) => decodeFunctionResult({ abi: shieldedPoolAbi, functionName, data } as never) as T;
  const scalar = ["getLastRoot", "nextLeafIndex", "withdrawFeeBps", "shieldPaused", "spendPaused", "noteDomain", "protocolFeeRecipient"];
  const calls = [
    ...scalar.map((f) => call(f)),
    ...manifest.assets.flatMap((a) => [call("assetConfig", [a.address]), call("shieldedBalance", [a.address]), call("protocolFeesAccrued", [a.address])]),
  ];
  const adapterNames = ["ShieldedSwapAdapter", "ShieldedLiquidityAdapter", "ShieldedPerpsAdapter"].filter((n) => manifest.contracts[n]);
  calls.push(...adapterNames.map((n) => call("adapterStatus", [manifest.contracts[n]!.address])));
  const [results, counts, through] = await Promise.all([
    multicall(c.env.RPC_URL, calls),
    c.env.DB.prepare("SELECT COUNT(*) AS leaves, MAX(leaf_index) AS last FROM vault_commitments").first<{ leaves: number; last: number | null }>(),
    indexedThrough(c.env),
  ]);
  const s = scalar.map((f, i) => read<unknown>(results[i]!, f));
  const assets = manifest.assets.map((a, i) => {
    const base = scalar.length + i * 3;
    const cfg = read<{ shieldingEnabled: boolean; maxDeposit: bigint; resource: bigint }>(results[base]!, "assetConfig");
    return {
      address: a.address,
      symbol: a.symbol,
      label: a.label,
      decimals: a.decimals,
      resource: cfg.resource.toString(),
      shieldingEnabled: cfg.shieldingEnabled,
      maxDeposit: cfg.maxDeposit.toString(),
      shieldedBalance: read<bigint>(results[base + 1]!, "shieldedBalance").toString(),
      protocolFeesAccrued: read<bigint>(results[base + 2]!, "protocolFeesAccrued").toString(),
    };
  });
  const statusNames = ["none", "active", "exit_only"] as const;
  const adapterBase = scalar.length + manifest.assets.length * 3;
  const adapters = adapterNames.map((name, i) => ({
    name,
    address: manifest.contracts[name]!.address,
    status: statusNames[Number(read<number>(results[adapterBase + i]!, "adapterStatus"))] ?? "none",
  }));
  c.header("Cache-Control", "no-store");
  return c.json({
    network: c.env.NETWORK,
    chainId: manifest.chainId,
    pool: pool.address,
    version: 2,
    legacyPool: manifest.contracts.ShieldedPoolV1?.address ?? null,
    deployBlock: pool.deployBlock,
    adapters,
    levels: 24,
    root: String(s[0]),
    leafCount: Number(s[1]),
    withdrawFeeBps: Number(s[2]),
    shieldPaused: Boolean(s[3]),
    spendPaused: Boolean(s[4]),
    noteDomain: String(s[5]),
    protocolFeeRecipient: String(s[6]),
    indexed: { leaves: counts?.leaves ?? 0, lastLeaf: counts?.last ?? null, block: through },
    assets,
    circuits: manifest.circuits,
    setup:
      c.env.NETWORK === "mainnet"
        ? "a two-party setup by the Curveil team, sealed with the hash of Ethereum block 26,340,800; a public multi-party ceremony is planned"
        : "testnet single-party setup (not for mainnet)",
  });
});

/** Latest on-chain root and leaf count (what a proof must be built against). */
vault.get("/vault/roots", async (c) => {
  const found = await poolOf(c.env);
  if (!found) return c.json(notDeployed, 404);
  const calls = ["getLastRoot", "nextLeafIndex"].map((functionName) => ({
    target: found.pool.address,
    data: encodeFunctionData({ abi: shieldedPoolAbi, functionName } as never),
  }));
  const [root, count] = await multicall(c.env.RPC_URL, calls);
  c.header("Cache-Control", "no-store");
  return c.json({
    root: (decodeFunctionResult({ abi: shieldedPoolAbi, functionName: "getLastRoot", data: root! } as never) as bigint).toString(),
    leafCount: Number(decodeFunctionResult({ abi: shieldedPoolAbi, functionName: "nextLeafIndex", data: count! } as never)),
    rootHistory: 100,
  });
});

/** Commitments with ciphertexts, in leaf order, from `fromLeaf`. */
vault.get("/vault/commitments", async (c) => {
  if (!(await poolOf(c.env))) return c.json(notDeployed, 404);
  const fromLeaf = Math.max(0, Number(c.req.query("fromLeaf") ?? 0) | 0);
  const limit = Math.min(MAX_COMMITMENTS, Math.max(1, Number(c.req.query("limit") ?? MAX_COMMITMENTS) | 0));
  const { results } = await c.env.DB.prepare(
    `SELECT leaf_index, commitment, encrypted_note, block_number, tx_hash, timestamp FROM vault_commitments
     WHERE leaf_index >= ? ORDER BY leaf_index LIMIT ?`,
  )
    .bind(fromLeaf, limit)
    .all<{ leaf_index: number; commitment: string; encrypted_note: string; block_number: number; tx_hash: string; timestamp: number }>();
  // Only hand out a contiguous run: a gap means the indexer is mid-range, so stop before it.
  const items = [];
  let expect = fromLeaf;
  for (const r of results) {
    if (r.leaf_index !== expect) break;
    items.push({ leafIndex: r.leaf_index, commitment: r.commitment, encryptedNote: r.encrypted_note, blockNumber: r.block_number, txHash: r.tx_hash, timestamp: r.timestamp });
    expect++;
  }
  c.header("Cache-Control", "public, max-age=2");
  return c.json({ fromLeaf, items, nextLeaf: expect, done: items.length < limit, indexedBlock: await indexedThrough(c.env) });
});

/** Spent nullifiers from `fromBlock` (inclusive), oldest first. Clients de-duplicate. */
vault.get("/vault/nullifiers", async (c) => {
  if (!(await poolOf(c.env))) return c.json(notDeployed, 404);
  const fromBlock = Math.max(0, Number(c.req.query("fromBlock") ?? 0) || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT nullifier, block_number, tx_hash FROM vault_nullifiers WHERE block_number >= ? ORDER BY block_number, log_index LIMIT ?`,
  )
    .bind(fromBlock, MAX_NULLIFIERS)
    .all<{ nullifier: string; block_number: number; tx_hash: string }>();
  const last = results.at(-1)?.block_number ?? null;
  c.header("Cache-Control", "public, max-age=2");
  return c.json({
    fromBlock,
    items: results.map((r) => ({ nullifier: r.nullifier, blockNumber: r.block_number, txHash: r.tx_hash })),
    done: results.length < MAX_NULLIFIERS,
    nextBlock: results.length < MAX_NULLIFIERS ? null : last,
    indexedBlock: await indexedThrough(c.env),
  });
});

/** Public footprint of vault actions (what any observer can already see on-chain). */
vault.get("/vault/activity", async (c) => {
  if (!(await poolOf(c.env))) return c.json(notDeployed, 404);
  const account = c.req.query("account");
  if (account && !isAddress(account)) return c.json({ error: "bad_address", message: "That is not a valid address." }, 400);
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) | 0));
  const stmt = account
    ? c.env.DB.prepare(
        `SELECT * FROM vault_activity WHERE account = ? ORDER BY block_number DESC, log_index DESC LIMIT ?`,
      ).bind(getAddress(account), limit)
    : c.env.DB.prepare(`SELECT * FROM vault_activity ORDER BY block_number DESC, log_index DESC LIMIT ?`).bind(limit);
  const { results } = await stmt.all<Record<string, string | number | null>>();
  c.header("Cache-Control", "public, max-age=3");
  return c.json({
    items: results.map((r) => ({
      kind: r.kind,
      token: r.token,
      account: r.account,
      amount: r.amount,
      fee: r.fee,
      protocolFee: r.protocol_fee,
      feeRecipient: r.fee_recipient,
      leafIndex: r.leaf_index,
      adapter: r.adapter,
      detail: r.detail ? JSON.parse(String(r.detail)) : null,
      blockNumber: r.block_number,
      txHash: r.tx_hash,
      timestamp: r.timestamp,
    })),
  });
});

/**
 * Every shielded liquidity position with its remaining units and exits. Positions are public
 * (market, holder contract, amounts); who owns their units is not. Clients fetch the whole
 * list and match their own position ids locally, so the server never learns which they hold.
 */
vault.get("/vault/positions", async (c) => {
  if (!(await poolOf(c.env))) return c.json(notDeployed, 404);
  const fromBlock = Math.max(0, Number(c.req.query("fromBlock") ?? 0) || 0);
  const limit = 1000;
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, (SELECT remaining_units FROM vault_position_events e WHERE e.position_id = p.position_id
       ORDER BY e.block_number DESC, e.log_index DESC LIMIT 1) AS remaining
     FROM vault_positions p WHERE p.block_number >= ? ORDER BY p.block_number, p.log_index LIMIT ?`,
  )
    .bind(fromBlock, limit)
    .all<Record<string, string | number | null>>();
  c.header("Cache-Control", "public, max-age=3");
  return c.json({
    items: results.map((r) => ({
      positionId: r.position_id,
      adapter: r.adapter,
      kind: r.kind,
      market: r.market,
      holder: r.holder,
      used0: r.used0,
      used1: r.used1,
      remainingUnits: r.remaining ?? "1000000000000000000",
      blockNumber: r.block_number,
      txHash: r.tx_hash,
      timestamp: r.timestamp,
    })),
    done: results.length < limit,
    indexedBlock: await indexedThrough(c.env),
  });
});
