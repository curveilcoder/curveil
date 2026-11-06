/**
 * Market indexer. A single Durable Object walks the chain from the factories' deploy block,
 * decodes factory and pool events into D1, and keeps pool state fresh. A cron kick every
 * minute makes sure its alarm loop is running.
 *
 * Reorgs: each processed range stores the header of its last block (and of every block with
 * events). On each tick the stored cursor hash is compared with the chain; on a mismatch the
 * indexer finds the highest stored block that still matches, deletes every row above it and
 * re-indexes from there.
 *
 * Launches ride the same loop: the launch factory, LP escrow and template registry are read
 * with the market factories, and every bonding curve with the pools.
 */
import { DurableObject } from "cloudflare:workers";
import { decodeFunctionResult, encodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import { indexerName, loadManifest, type Env } from "../lib";
import { multicall, rpcBatch, hex, type Call, type RpcBlock, type RpcCall, type RpcLog } from "./rpc";
import {
  dammPoolAbi,
  dlmmPairAbi,
  dammPrice,
  dlmmPrice,
  decodeFactoryLogs,
  decodePoolLogs,
  type NewPool,
  type PoolInfo,
  type TokenInfo,
} from "./process";
import {
  decodeCurveLogs,
  decodeEscrowLogs,
  decodeLaunchCreated,
  templateRegistryAbi,
  touchesTemplates,
  type CurveInfo,
} from "./launch";
import { decodeVaultLogs, vaultStatements } from "./vault";
import { PERPS_TABLES, decodePerpsLogs, perpsStatements, type PerpsAddresses } from "./perps";
import {
  ZERO_ADDRESS,
  decodeLaunchpadLogs,
  factoryStatements,
  operatorStatements,
  readCurveOperators,
  readOperators,
  type FactoryRows,
} from "./factory";
import { chainEvents, type EventInput, type LaunchContext } from "./events";
import { WebhookProducer } from "./webhooks";
import { decodeGovernanceLogs, governanceContracts, governanceStatements } from "./governance";

const MAX_RANGE = 20_000; // blocks per tick; the RPC accepts large log ranges
// Idle cadence is a trade-off with D1's free-tier write budget: each idle tick writes ~2 rows.
const IDLE_MS = 8_000;
const BUSY_MS = 250;
const ERROR_MS = 15_000;
const CHECKPOINTS_KEPT = 500;
const STATE_REFRESH_EVERY = 8; // ticks; DAMM fees decay with time even without swaps
const PRUNE_EVERY = 50; // ticks
/** Bumped when indexing logic changes, so a deploy can be confirmed from /v1/indexer. */
const INDEXER_CODE = "governance-1";
const TEMPLATE_REFRESH_EVERY = 900; // ticks (~2h idle); also refreshed on any registry event

export type Cursor = { number: number; hash: string | null };

/**
 * Highest stored checkpoint whose hash the chain still has at that height. `stored` is ordered
 * newest first and `chain[i]` is the chain's block at `stored[i].number`. With no match, the
 * indexer restarts from the beginning (rows are upserted, so this is safe, only slower).
 */
export function commonAncestor(
  stored: { number: number; hash: string }[],
  chain: ({ hash: string } | null | undefined)[],
  startBlock: number,
): Cursor {
  const match = stored.find((r, i) => chain[i]?.hash === r.hash);
  return match ? { number: match.number, hash: match.hash } : { number: startBlock - 1, hash: null };
}

const erc20Abi = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const satisfies Abi;

/** The perps contracts the indexer reads, and the earliest of their deploy blocks. */
export function perpsContracts(c: Record<string, { address: string; deployBlock: number }>): { at: PerpsAddresses; deployBlock: number } | null {
  const engine = c.PerpEngine;
  const orders = c.OrderManager;
  const oracle = c.OracleAdapter;
  const vault = c.PerpLiquidityVault;
  if (!engine || !orders || !oracle || !vault) return null;
  const adapter = c.ShieldedPerpsAdapter ?? null;
  return {
    at: { engine: engine.address, orders: orders.address, oracle: oracle.address, vault: vault.address, adapter: adapter?.address ?? null },
    deployBlock: Math.min(...[engine, orders, oracle, vault, adapter].filter(Boolean).map((x) => x!.deployBlock)),
  };
}

export class Indexer extends DurableObject<Env> {
  private ticks = 0;
  private lastError: string | null = null;
  private lastFinalized: number | null = null;
  private webhooks = new WebhookProducer(this.env);

  /** The API calls this when a webhook subscription is created or changed. */
  async webhooksChanged(): Promise<void> {
    this.webhooks.invalidate();
  }

  private current(): boolean {
    return this.ctx.id.equals(this.env.INDEXER.idFromName(indexerName(this.env)));
  }

  /**
   * Stops this object's loop if it belongs to an earlier generation. The API calls it on old
   * generations: a request can bring a busy object onto new code where its own alarm does not.
   */
  async retire(): Promise<boolean> {
    if (this.current()) return false;
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  /** Ensures the alarm loop is scheduled. Called by the cron trigger and on demand. */
  async kick(): Promise<{ scheduled: boolean }> {
    if (!this.current()) return { scheduled: false };
    const at = await this.ctx.storage.getAlarm();
    // An alarm a minute overdue is stuck (for example after the platform refused it when the
    // account ran out of its daily Durable Object quota): replace it rather than wait forever.
    if (at === null || at < Date.now() - 60_000) {
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return { scheduled: true };
    }
    return { scheduled: false };
  }

  /** What this instance is doing, for /v1/indexer. Also proves which code version is running. */
  async info(): Promise<{ code: string; ticks: number; lastError: string | null; rpcHost: string | null; logsHost: string | null; cursor: Cursor | null; launchFrom: number | null; vaultFrom: number | null; templates: number | null; alarmAt: number | null }> {
    return {
      code: INDEXER_CODE,
      ticks: this.ticks,
      lastError: this.lastError,
      // Host only: a provider URL can carry a key in its path.
      rpcHost: (() => { try { return new URL(this.env.RPC_URL).hostname; } catch { return null; } })(),
      logsHost: (() => { try { return new URL(this.env.LOGS_RPC_URL || this.env.RPC_URL).hostname; } catch { return null; } })(),
      cursor: (await this.ctx.storage.get<Cursor>("cursor")) ?? null,
      launchFrom: (await this.ctx.storage.get<number>("launchFrom")) ?? null,
      vaultFrom: (await this.ctx.storage.get<number>("vaultFrom")) ?? null,
      templates: this.templateDecimals?.size ?? null,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  /** Clears the cursor so the next tick re-indexes from the start block (rows are upserted). */
  async reset(): Promise<void> {
    await this.ctx.storage.delete("cursor");
    await this.kick();
  }

  async alarm(): Promise<void> {
    if (!this.current()) {
      // An object from an earlier generation: stop its loop so only one indexer writes.
      await this.ctx.storage.deleteAlarm();
      console.warn("retired an indexer object from an earlier generation");
      return;
    }
    let next = IDLE_MS;
    try {
      next = await this.tick();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("indexer tick failed", message);
      this.lastError = message.slice(0, 500);
      // Upsert, so an error before the first indexed range is recorded too (indexed_block -1
      // until a range succeeds).
      await this.env.DB.prepare(
        `INSERT INTO indexer_state (id, start_block, indexed_block, head_block, last_error, updated_at) VALUES (1, -1, -1, -1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
        .bind(this.lastError, new Date().toISOString())
        .run()
        .catch((err) => console.error("could not record the indexer error", err));
      next = ERROR_MS;
    }
    await this.ctx.storage.setAlarm(Date.now() + next);
  }

  /** Processes one range. Returns the delay before the next tick. */
  async tick(): Promise<number> {
    this.ticks++;
    const env = this.env;
    const db = env.DB;
    const { manifest } = await loadManifest(env);
    const damm = manifest.contracts.DammFactory;
    const dlmm = manifest.contracts.DlmmFactory;
    if (!damm || !dlmm) return 60_000; // markets not deployed on this network yet
    const startBlock = Math.min(damm.deployBlock, dlmm.deployBlock);
    const launch = launchContracts(manifest.contracts);

    let cursor = (await this.ctx.storage.get<Cursor>("cursor")) ?? { number: startBlock - 1, hash: null };
    // Launch contracts deployed (or redeployed) after the cursor passed them: walk back once to
    // their deploy block. Rows are upserted, so the market range is simply re-read.
    if (launch && (await this.ctx.storage.get<number>("launchFrom")) !== launch.deployBlock) {
      if (cursor.number >= launch.deployBlock) cursor = { number: launch.deployBlock - 1, hash: null };
      await this.ctx.storage.put("launchFrom", launch.deployBlock);
      await this.ctx.storage.put("cursor", cursor);
    }
    // Same for the shielded pool. The vault tables hold one pool's data: when the manifest
    // names a different pool (a new version), clear them and read the new pool from its start.
    const vault = manifest.contracts.ShieldedPool ?? null;
    const liquidityAdapter = vault ? (manifest.contracts.ShieldedLiquidityAdapter ?? null) : null;
    if (vault && (await this.ctx.storage.get<string>("vaultPool")) !== vault.address) {
      await db.batch(
        ["vault_commitments", "vault_nullifiers", "vault_activity", "vault_positions", "vault_position_events"].map((t) => db.prepare(`DELETE FROM ${t}`)),
      );
      await this.ctx.storage.put("vaultPool", vault.address);
      await this.ctx.storage.delete("vaultFrom");
    }
    if (vault && (await this.ctx.storage.get<number>("vaultFrom")) !== vault.deployBlock) {
      if (cursor.number >= vault.deployBlock) cursor = { number: vault.deployBlock - 1, hash: null };
      await this.ctx.storage.put("vaultFrom", vault.deployBlock);
      await this.ctx.storage.put("cursor", cursor);
    }
    // Perps (Phase 5): same walk-back, and a fresh start if the engine is replaced.
    const perps = perpsContracts(manifest.contracts);
    if (perps && (await this.ctx.storage.get<string>("perpsEngine")) !== perps.at.engine) {
      await db.batch(Object.values(PERPS_TABLES).map((t) => db.prepare(`DELETE FROM ${t}`)));
      await this.ctx.storage.put("perpsEngine", perps.at.engine);
      await this.ctx.storage.delete("perpsFrom");
    }
    if (perps && (await this.ctx.storage.get<number>("perpsFrom")) !== perps.deployBlock) {
      if (cursor.number >= perps.deployBlock) cursor = { number: perps.deployBlock - 1, hash: null };
      await this.ctx.storage.put("perpsFrom", perps.deployBlock);
      await this.ctx.storage.put("cursor", cursor);
    }
    // Launchpad operators (Phase 6): same walk-back.
    const pads = manifest.contracts.LaunchpadRegistry ?? null;
    if (pads && (await this.ctx.storage.get<number>("factoryFrom")) !== pads.deployBlock) {
      if (cursor.number >= pads.deployBlock) cursor = { number: pads.deployBlock - 1, hash: null };
      await this.ctx.storage.put("factoryFrom", pads.deployBlock);
      await this.ctx.storage.put("cursor", cursor);
    }
    // Governance records (Phase 7): same walk-back.
    const gov = governanceContracts(manifest.contracts);
    if (gov && (await this.ctx.storage.get<number>("governanceFrom")) !== gov.deployBlock) {
      if (cursor.number >= gov.deployBlock) cursor = { number: gov.deployBlock - 1, hash: null };
      await this.ctx.storage.put("governanceFrom", gov.deployBlock);
      await this.ctx.storage.put("cursor", cursor);
    }
    const calls: RpcCall[] = [
      { method: "eth_blockNumber", params: [] },
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
    ];
    if (cursor.hash) calls.push({ method: "eth_getBlockByNumber", params: [hex(cursor.number), false] });
    const [headHex, finalized, atCursor] = await rpcBatch<any>(env.RPC_URL, calls);
    const head = Number(BigInt(headHex as string));
    const finalizedBlock = finalized ? Number(BigInt((finalized as RpcBlock).number)) : null;

    if (cursor.hash && (atCursor as RpcBlock | null)?.hash !== cursor.hash) {
      cursor = await this.rewind(cursor, startBlock);
      await this.ctx.storage.put("cursor", cursor);
      return BUSY_MS;
    }

    const idleMs = Number(env.INDEXER_IDLE_MS) || IDLE_MS;
    if (head <= cursor.number) {
      await this.saveState(startBlock, cursor.number, head, finalizedBlock);
      return idleMs;
    }

    const logsRpc = env.LOGS_RPC_URL || env.RPC_URL;
    const from = cursor.number + 1;
    const to = Math.min(head, cursor.number + (Number(env.MAX_LOG_RANGE) || MAX_RANGE));

    // 1. New pools from both factories; new launches, escrow and template changes.
    const singletons = [damm.address, dlmm.address];
    if (launch) singletons.push(launch.factory, launch.escrow, launch.registry);
    if (vault) singletons.push(vault.address);
    if (liquidityAdapter) singletons.push(liquidityAdapter.address);
    if (perps) singletons.push(...(Object.values(perps.at).filter(Boolean) as string[]));
    if (pads) singletons.push(pads.address);
    if (gov) singletons.push(...gov.byAddress.keys());
    // Known pools, curves and splitters are read in the same call as the singletons, so a
    // quiet range costs one eth_getLogs (free RPC plans count every call).
    const pools = await this.loadPools();
    const curves = launch ? await this.loadCurves() : new Map<string, CurveInfo>();
    const splitters = new Set<string>();
    if (pads) {
      const { results } = await db.prepare("SELECT address FROM operators").all<{ address: string }>();
      for (const r of results) splitters.add(r.address);
    }
    const known = [...pools.keys(), ...curves.keys(), ...splitters];
    const getLogs = async (addresses: string[]) => {
      const out: RpcLog[] = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const [logs] = await rpcBatch<RpcLog[]>(logsRpc, [
          { method: "eth_getLogs", params: [{ address: addresses.slice(i, i + 100), fromBlock: hex(from), toBlock: hex(to) }] },
        ]);
        out.push(...logs!);
      }
      return out;
    };
    const single = new Set(singletons.map((a) => a.toLowerCase()));
    const firstLogs = await getLogs([...singletons, ...known]);
    const factoryLogs = firstLogs.filter((l) => single.has(l.address.toLowerCase()));
    const poolLogs: RpcLog[] = firstLogs.filter((l) => !single.has(l.address.toLowerCase()));
    const created = decodeFactoryLogs(factoryLogs, { damm: damm.address, dlmm: dlmm.address });
    const launches = launch ? decodeLaunchCreated(factoryLogs, launch.factory, new Map()) : [];
    let templateStmts: D1PreparedStatement[] = [];
    if (
      launch &&
      (this.templateDecimals === null ||
        this.ticks % TEMPLATE_REFRESH_EVERY === 0 ||
        touchesTemplates(factoryLogs, launch.registry) ||
        launches.some((l) => !this.templateDecimals!.has(l.templateId)))
    ) {
      templateStmts = await this.readTemplates(launch.registry);
    }

    const tokens = await this.loadTokens(manifest.assets.find((a) => a.label === "USDG")?.address ?? null);
    const fresh = await this.describeNewPools(created, tokens);
    for (const p of fresh.pools) pools.set(p.address, p);
    for (const t of fresh.tokens) tokens.set(t.address, t);

    // 2. Pool and curve events in the same range: known ones came with the first call; read
    // the pools, curves and splitters created inside this range now.
    const knownSet = new Set(known.map((a) => a.toLowerCase()));
    for (const l of launches) curves.set(l.curve, { token: l.token, quoteDecimals: this.templateDecimals?.get(l.templateId) ?? 6 });
    if (pads) for (const r of decodeLaunchpadLogs(factoryLogs, pads.address, splitters, new Map()).registered) splitters.add(r.operator);
    const added = [...pools.keys(), ...curves.keys(), ...splitters].filter((a) => !knownSet.has(a.toLowerCase()));
    if (added.length) poolLogs.push(...(await getLogs(added)));
    // Same order as the chain, as the decoders expect.
    poolLogs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));

    // 3. Headers: every block with events (timestamps) plus the range end (checkpoint).
    const blockNumbers = [...new Set([...factoryLogs, ...poolLogs].map((l) => Number(BigInt(l.blockNumber))))];
    if (!blockNumbers.includes(to)) blockNumbers.push(to);
    const headers: RpcBlock[] = [];
    for (let i = 0; i < blockNumbers.length; i += 50) {
      const chunk = blockNumbers.slice(i, i + 50);
      headers.push(
        ...(await rpcBatch<RpcBlock>(
          env.RPC_URL,
          chunk.map((n) => ({ method: "eth_getBlockByNumber", params: [hex(n), false] })),
        )),
      );
    }
    const timestamps = new Map(headers.map((h) => [Number(BigInt(h.number)), Number(BigInt(h.timestamp))]));
    const end = headers.find((h) => Number(BigInt(h.number)) === to)!;

    const { swaps, liquidity } = decodePoolLogs(poolLogs, pools, tokens, timestamps);
    for (const l of launches) l.timestamp = timestamps.get(l.createdBlock) ?? 0;
    const { trades, events } = decodeCurveLogs(poolLogs, curves, timestamps);
    const escrowRows = launch ? decodeEscrowLogs(factoryLogs, launch.escrow, timestamps) : [];
    const vaultRows = vault ? decodeVaultLogs(factoryLogs, vault.address, timestamps, liquidityAdapter?.address) : null;
    const perpsRows = perps ? decodePerpsLogs(factoryLogs, perps.at, timestamps) : null;
    const factoryRows = pads ? decodeLaunchpadLogs([...factoryLogs, ...poolLogs], pads.address, splitters, timestamps) : null;
    const governanceRows = gov ? decodeGovernanceLogs(factoryLogs, gov, timestamps) : [];
    const operatorStmts = pads && factoryRows ? await this.operatorStatements(pads.address, factoryRows, to) : [];
    // Which operator each new launch pays (and any launch not read yet): fixed in the curve.
    const curveOps = launch ? await this.curveOperators(launches.map((l) => l.curve)) : new Map<string, { operator: string; shareBps: number }>();

    // 4. Write everything for the range in one batch.
    const stmts: D1PreparedStatement[] = [...templateStmts];
    for (const t of fresh.tokens) {
      stmts.push(
        db
          .prepare("INSERT OR IGNORE INTO tokens (address, symbol, name, decimals, is_quote) VALUES (?, ?, ?, ?, ?)")
          .bind(t.address, t.symbol, t.name, t.decimals, t.isQuote ? 1 : 0),
      );
    }
    for (const p of fresh.pools) {
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO pools (address, kind, factory, token0, token1, fee_tier, base_fee_bps, max_fee_bps,
             protocol_share_bps, bin_step, created_block, created_tx, block_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            p.address,
            p.kind,
            p.factory,
            p.token0,
            p.token1,
            p.feeTier,
            p.baseFeeBps,
            p.maxFeeBps,
            p.protocolShareBps,
            p.binStep,
            p.createdBlock,
            p.createdTx,
            p.blockHash,
          ),
      );
    }
    for (const s of swaps) {
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO swaps (tx_hash, log_index, block_number, block_hash, timestamp, pool, sender, recipient,
             token_in, token_out, amount_in, amount_out, fee, protocol_fee, fee_bps, quote_value, quote_fee, active_id_after)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            s.txHash,
            s.logIndex,
            s.blockNumber,
            s.blockHash,
            s.timestamp,
            s.pool,
            s.sender,
            s.recipient,
            s.tokenIn,
            s.tokenOut,
            s.amountIn,
            s.amountOut,
            s.fee,
            s.protocolFee,
            s.feeBps,
            s.quoteValue,
            s.quoteFee,
            s.activeIdAfter,
          ),
      );
    }
    for (const l of liquidity) {
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO liquidity_events (tx_hash, log_index, block_number, block_hash, timestamp, pool, kind, owner,
             counterparty, amount0, amount1, shares, bins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            l.txHash,
            l.logIndex,
            l.blockNumber,
            l.blockHash,
            l.timestamp,
            l.pool,
            l.kind,
            l.owner,
            l.counterparty,
            l.amount0,
            l.amount1,
            l.shares,
            l.bins ? JSON.stringify(l.bins) : null,
          ),
      );
    }
    stmts.push(...launchStatements(db, launches, trades, events, escrowRows));
    if (vaultRows) stmts.push(...vaultStatements(db, vaultRows));
    if (perpsRows) stmts.push(...perpsStatements(db, perpsRows));
    if (factoryRows) stmts.push(...factoryStatements(db, factoryRows), ...operatorStmts);
    stmts.push(...governanceStatements(db, governanceRows));
    for (const [curve, o] of curveOps) {
      stmts.push(db.prepare("UPDATE launches SET operator = ?, operator_share_bps = ? WHERE curve = ?").bind(o.operator, o.shareBps, curve));
    }
    for (const h of headers) {
      stmts.push(
        db
          .prepare("INSERT OR REPLACE INTO blocks (number, hash, parent_hash, timestamp, finality) VALUES (?, ?, ?, ?, 'sequencer')")
          .bind(Number(BigInt(h.number)), h.hash, h.parentHash, Number(BigInt(h.timestamp))),
      );
    }
    if (finalizedBlock !== null && finalizedBlock !== this.lastFinalized) {
      stmts.push(db.prepare("UPDATE blocks SET finality = 'final' WHERE number <= ? AND finality != 'final'").bind(finalizedBlock));
      this.lastFinalized = finalizedBlock;
    }
    if (this.ticks % PRUNE_EVERY === 0) {
      const now = Math.floor(Date.now() / 1000);
      stmts.push(
        db.prepare(
          `DELETE FROM blocks WHERE number < (SELECT MIN(number) FROM (SELECT number FROM blocks ORDER BY number DESC LIMIT ${CHECKPOINTS_KEPT}))`,
        ),
        // Deliveries are kept for 30 days; nonces for an hour; sessions until they expire.
        db.prepare("DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE created_ts < ? AND status IN ('delivered', 'dead'))").bind(now - 30 * 86_400),
        db.prepare("DELETE FROM webhook_deliveries WHERE created_ts < ? AND status IN ('delivered', 'dead')").bind(now - 30 * 86_400),
        db.prepare("DELETE FROM auth_nonces WHERE created_ts < ?").bind(now - 3600),
        db.prepare("DELETE FROM sessions WHERE expires_ts < ?").bind(now),
      );
    }
    stmts.push(...this.stateStatements(startBlock, to, head, finalizedBlock));
    for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));

    // Who created each new pool: the sender of its creating transaction. Also catches up older rows.
    try {
      await this.fillPoolCreators();
    } catch (e) {
      console.warn("pool creators", e);
    }

    // Webhooks for what this range holds, once its rows are written.
    try {
      await this.produceWebhooks(manifest.network, manifest.chainId, {
        swaps, pools, liquidity, trades, launchEvents: events, factoryRows, perpsRows,
        launches: launches.map((l) => ({ ...l, operator: curveOps.get(l.curve)?.operator ?? null, operatorShareBps: curveOps.get(l.curve)?.shareBps ?? null })),
        from, end: { number: to, hash: end.hash, timestamp: Number(BigInt(end.timestamp)) },
      });
      if (this.ticks % PRUNE_EVERY === 0) await this.webhooks.sweep();
    } catch (e) {
      // Never let webhooks hold up indexing; missed rows are picked up by the sweep or a replay.
      console.error("webhook production failed", e instanceof Error ? e.message : e);
    }

    // 5. Refresh state of pools touched in this range, and of every pool once in a while.
    const touched = new Set<string>([...fresh.pools.map((p) => p.address), ...swaps.map((s) => s.pool), ...liquidity.map((l) => l.pool)]);
    const everything = this.ticks % STATE_REFRESH_EVERY === 1 && pools.size <= 200;
    const refresh = everything ? [...pools.values()] : [...touched].map((a) => pools.get(a)!).filter(Boolean);
    // While catching up, read state at the head: the RPC does not keep state for old blocks.
    await this.refreshPoolState(refresh, tokens, to < head ? head : to);

    cursor = { number: to, hash: end.hash };
    await this.ctx.storage.put("cursor", cursor);
    return to < head ? BUSY_MS : idleMs;
  }

  private async rewind(cursor: Cursor, startBlock: number): Promise<Cursor> {
    const db = this.env.DB;
    const { results } = await db
      .prepare("SELECT number, hash FROM blocks WHERE number <= ? ORDER BY number DESC LIMIT 64")
      .bind(cursor.number)
      .all<{ number: number; hash: string }>();
    const chain = await rpcBatch<RpcBlock | null>(
      this.env.RPC_URL,
      results.map((r) => ({ method: "eth_getBlockByNumber", params: [hex(r.number), false] })),
    );
    const ancestor = commonAncestor(results, chain, startBlock);
    console.warn(`reorg below block ${cursor.number}; rewinding to ${ancestor.number}`);
    // Operator terms are read, not replayed: read them all again after a reorg.
    await this.ctx.storage.put("refreshOperators", true);
    await db.batch([
      db.prepare("DELETE FROM swaps WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM liquidity_events WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM pools WHERE created_block > ?").bind(ancestor.number),
      db.prepare("DELETE FROM pool_state WHERE pool NOT IN (SELECT address FROM pools)"),
      db.prepare("DELETE FROM curve_trades WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM launch_events WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM escrow_events WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM launches WHERE created_block > ?").bind(ancestor.number),
      db.prepare("DELETE FROM vault_commitments WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM vault_nullifiers WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM vault_activity WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM vault_positions WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM vault_position_events WHERE block_number > ?").bind(ancestor.number),
      ...Object.values(PERPS_TABLES).map((t) => db.prepare(`DELETE FROM ${t} WHERE block_number > ?`).bind(ancestor.number)),
      db.prepare("DELETE FROM operator_events WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM fee_distributions WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM operators WHERE created_block > ?").bind(ancestor.number),
      db.prepare("DELETE FROM governance_events WHERE block_number > ?").bind(ancestor.number),
      db.prepare("DELETE FROM blocks WHERE number > ?").bind(ancestor.number),
      db.prepare("UPDATE indexer_state SET reorgs = reorgs + 1, indexed_block = ?, updated_at = ? WHERE id = 1").bind(
        ancestor.number,
        new Date().toISOString(),
      ),
    ]);
    return ancestor;
  }

  /** Reads the sender of up to 50 pool-creating transactions whose creator is not known yet. */
  private async fillPoolCreators() {
    const db = this.env.DB;
    const { results } = await db.prepare("SELECT address, created_tx FROM pools WHERE creator IS NULL LIMIT 50").all<{ address: string; created_tx: string }>();
    if (!results.length) return;
    const txs = await rpcBatch<{ from: string } | null>(
      this.env.RPC_URL,
      results.map((r) => ({ method: "eth_getTransactionByHash", params: [r.created_tx] })),
    );
    const stmts = results.flatMap((r, i) => {
      const from = txs[i]?.from;
      return from ? [db.prepare("UPDATE pools SET creator = ? WHERE address = ? AND created_tx = ?").bind(getAddress(from), r.address, r.created_tx)] : [];
    });
    if (stmts.length) await db.batch(stmts);
  }

  private stateStatements(startBlock: number, indexed: number, head: number, finalized: number | null) {
    const now = new Date().toISOString();
    return [
      this.env.DB.prepare(
        `INSERT INTO indexer_state (id, start_block, indexed_block, head_block, finalized_block, last_error, updated_at)
         VALUES (1, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET start_block = excluded.start_block, indexed_block = excluded.indexed_block,
           head_block = excluded.head_block, finalized_block = excluded.finalized_block, last_error = NULL,
           updated_at = excluded.updated_at`,
      ).bind(startBlock, indexed, head, finalized, now),
    ];
  }

  private async saveState(startBlock: number, indexed: number, head: number, finalized: number | null) {
    await this.env.DB.batch(this.stateStatements(startBlock, indexed, head, finalized));
  }

  /** Current terms of every operator an event touched (all of them after a reorg). */
  private async operatorStatements(registry: string, rows: FactoryRows, block: number): Promise<D1PreparedStatement[]> {
    const touched = new Set(rows.touched);
    if (await this.ctx.storage.get<boolean>("refreshOperators")) {
      const { results } = await this.env.DB.prepare("SELECT address FROM operators").all<{ address: string }>();
      for (const r of results) touched.add(r.address);
      await this.ctx.storage.delete("refreshOperators");
    }
    if (touched.size === 0) return [];
    const states = await readOperators(this.env.RPC_URL, registry, [...touched]);
    const created = new Map(rows.registered.map((r) => [r.operator, r]));
    return operatorStatements(this.env.DB, states, created, block);
  }

  /** Operator and share of `curves`, plus up to 100 indexed launches not read yet. */
  private async curveOperators(curves: string[]): Promise<Map<string, { operator: string; shareBps: number }>> {
    const { results } = await this.env.DB.prepare("SELECT curve FROM launches WHERE operator IS NULL LIMIT 100")
      .all<{ curve: string }>()
      .catch(() => ({ results: [] as { curve: string }[] }));
    const all = [...new Set([...curves, ...results.map((r) => r.curve)])];
    if (all.length === 0) return new Map();
    return readCurveOperators(this.env.RPC_URL, all);
  }

  /** Builds the range's webhook events, only for event types some subscription wants. */
  private async produceWebhooks(
    network: "testnet" | "mainnet",
    chainId: number,
    r: {
      swaps: EventInput["swaps"];
      pools: Map<string, PoolInfo>;
      liquidity: EventInput["liquidity"];
      trades: NonNullable<EventInput["trades"]>;
      launchEvents: NonNullable<EventInput["launchEvents"]>;
      launches: NonNullable<EventInput["launches"]>;
      factoryRows: FactoryRows | null;
      perpsRows: ReturnType<typeof decodePerpsLogs> | null;
      from: number;
      end: { number: number; hash: string; timestamp: number };
    },
  ): Promise<void> {
    const wanted = await this.webhooks.wanted();
    if (wanted.size === 0) return;
    const want = (t: string) => wanted.has(t) || wanted.has("*");
    const db = this.env.DB;
    const input: EventInput = { pools: r.pools, at: r.end };
    if (want("swap")) input.swaps = r.swaps;
    if (want("liquidity.changed")) input.liquidity = r.liquidity;
    if (want("launch.created")) input.launches = r.launches;
    if (want("operator.fee_paid")) input.distributions = r.factoryRows?.distributions ?? [];
    if (want("swap") || want("launch.progress")) input.trades = r.trades;
    if (want("launch.graduated")) input.launchEvents = r.launchEvents;
    // Launch context (curve, operator, threshold, reserve before this range) for trades and graduations.
    const tokens = [...new Set([...(input.trades ?? []).map((t) => t.token), ...(input.launchEvents ?? []).map((e) => e.token)])];
    if (tokens.length > 0) {
      const ctx = new Map<string, LaunchContext>();
      const { results } = await db
        .prepare(
          `SELECT l.token, l.curve, l.operator, t.graduation_threshold AS threshold,
             (SELECT reserve_after FROM curve_trades c WHERE c.token = l.token AND c.block_number < ?
               ORDER BY c.block_number DESC, c.log_index DESC LIMIT 1) AS prev
           FROM launches l LEFT JOIN launch_templates t ON t.id = l.template_id
           WHERE l.token IN (${tokens.map(() => "?").join(",")})`,
        )
        .bind(r.from, ...tokens)
        .all<{ token: string; curve: string; operator: string | null; threshold: string | null; prev: string | null }>();
      for (const x of results) {
        ctx.set(x.token, {
          curve: x.curve,
          operator: x.operator && x.operator !== ZERO_ADDRESS ? x.operator : null,
          threshold: BigInt(x.threshold ?? "0"),
          prevReserve: BigInt(x.prev ?? "0"),
        });
      }
      input.launchContext = ctx;
    }
    if (want("perps.liquidation") && r.perpsRows && r.perpsRows.liquidations.length > 0) {
      input.liquidations = r.perpsRows.liquidations;
      const ids = [...new Set(r.perpsRows.liquidations.map((l) => String(l.position_id)))];
      const { results } = await db
        .prepare(`SELECT position_id, owner, market_id, is_long FROM perp_positions WHERE event = 'opened' AND position_id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<{ position_id: string; owner: string; market_id: number; is_long: number }>();
      input.positions = new Map(results.map((p) => [p.position_id, { owner: p.owner, marketId: p.market_id, isLong: p.is_long === 1 }]));
    }
    if (want("escrow.unlocked")) {
      // Time-based: locks whose unlock time passed since the last check (block time).
      const since = (await this.ctx.storage.get<number>("unlockCheckedTo")) ?? r.end.timestamp;
      if (r.end.timestamp > since) {
        const { results } = await db
          .prepare(
            `SELECT lock_id, lp_token, beneficiary, unlock_at FROM escrow_events e WHERE kind = 'created' AND unlock_at > ? AND unlock_at <= ?
               AND NOT EXISTS (SELECT 1 FROM escrow_events c WHERE c.lock_id = e.lock_id AND c.kind = 'claimed')`,
          )
          .bind(since, r.end.timestamp)
          .all<{ lock_id: number; lp_token: string | null; beneficiary: string; unlock_at: number }>();
        // The current beneficiary, in case the lock changed hands.
        input.unlocks = [];
        for (const x of results) {
          const latest = await db
            .prepare("SELECT beneficiary FROM escrow_events WHERE lock_id = ? ORDER BY block_number DESC, log_index DESC LIMIT 1")
            .bind(x.lock_id)
            .first<{ beneficiary: string }>();
          input.unlocks.push({ lockId: x.lock_id, lpToken: x.lp_token, beneficiary: latest?.beneficiary ?? x.beneficiary, unlockAt: x.unlock_at });
        }
      }
      await this.ctx.storage.put("unlockCheckedTo", Math.max(since, r.end.timestamp));
    }
    const events = chainEvents(input).filter((e) => want(e.type));
    await this.webhooks.produce(events, network, chainId);
  }

  private async loadPools(): Promise<Map<string, PoolInfo>> {
    const { results } = await this.env.DB.prepare("SELECT * FROM pools").all<Record<string, any>>();
    return new Map(
      results.map((r) => [
        r.address as string,
        {
          address: r.address,
          kind: r.kind,
          factory: r.factory,
          token0: r.token0,
          token1: r.token1,
          feeTier: r.fee_tier,
          baseFeeBps: r.base_fee_bps,
          maxFeeBps: r.max_fee_bps,
          protocolShareBps: r.protocol_share_bps,
          binStep: r.bin_step,
          createdBlock: r.created_block,
          createdTx: r.created_tx,
          blockHash: r.block_hash,
        } satisfies PoolInfo,
      ]),
    );
  }

  private async loadTokens(quoteAddress: string | null): Promise<Map<string, TokenInfo>> {
    const { results } = await this.env.DB.prepare("SELECT * FROM tokens").all<Record<string, any>>();
    const m = new Map<string, TokenInfo>(
      results.map((r) => [r.address as string, { address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals, isQuote: r.is_quote === 1 }]),
    );
    this.quote = quoteAddress ? getAddress(quoteAddress) : null;
    return m;
  }

  private quote: string | null = null;
  /** Template id to quote decimals, from the last registry read. */
  private templateDecimals: Map<number, number> | null = null;

  private async loadCurves(): Promise<Map<string, CurveInfo>> {
    const { results } = await this.env.DB.prepare(
      "SELECT l.curve, l.token, t.quote_decimals FROM launches l LEFT JOIN launch_templates t ON t.id = l.template_id",
    ).all<{ curve: string; token: string; quote_decimals: number | null }>();
    return new Map(results.map((r) => [r.curve, { token: r.token, quoteDecimals: r.quote_decimals ?? 6 }]));
  }

  /**
   * Reads every template from the registry. Templates are immutable apart from the enabled
   * flag, and the registry may predate the indexer's cursor, so it is read rather than replayed.
   */
  private async readTemplates(registry: string): Promise<D1PreparedStatement[]> {
    // Latest state: the RPC does not keep old state, and templates only ever gain entries or
    // flip their enabled flag.
    const tag = "latest";
    const [countHex] = await multicall(this.env.RPC_URL, [
      { target: registry, data: encodeFunctionData({ abi: templateRegistryAbi, functionName: "count" }) },
    ], tag);
    const n = Number(decodeFunctionResult({ abi: templateRegistryAbi, functionName: "count", data: countHex! }));
    const calls: Call[] = [];
    for (let i = 0; i < n; i++) {
      calls.push({ target: registry, data: encodeFunctionData({ abi: templateRegistryAbi, functionName: "get", args: [BigInt(i)] }) });
      calls.push({ target: registry, data: encodeFunctionData({ abi: templateRegistryAbi, functionName: "enabled", args: [BigInt(i)] }) });
    }
    const res = await multicall(this.env.RPC_URL, calls, tag);
    const templates = [];
    for (let i = 0; i < n; i++) {
      const t = decodeFunctionResult({ abi: templateRegistryAbi, functionName: "get", data: res[2 * i]! }) as Record<string, any>;
      const on = decodeFunctionResult({ abi: templateRegistryAbi, functionName: "enabled", data: res[2 * i + 1]! }) as boolean;
      templates.push({ id: i, t, on });
    }
    const quotes = [...new Set(templates.map((x) => getAddress(x.t.quoteAsset as string)))];
    const qres = await multicall(
      this.env.RPC_URL,
      quotes.flatMap((q) => [
        { target: q, data: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }) },
        { target: q, data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) },
      ]),
      tag,
    );
    const quoteInfo = new Map(
      quotes.map((q, i) => [
        q,
        {
          symbol: decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: qres[2 * i]! }) as string,
          decimals: Number(decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: qres[2 * i + 1]! })),
        },
      ]),
    );
    this.templateDecimals = new Map();
    const now = new Date().toISOString();
    return templates.map(({ id, t, on }) => {
      const q = quoteInfo.get(getAddress(t.quoteAsset))!;
      this.templateDecimals!.set(id, q.decimals);
      return this.env.DB.prepare(
        `INSERT OR REPLACE INTO launch_templates (id, label, quote_asset, quote_symbol, quote_decimals, total_supply, curve_supply,
         migration_supply, graduation_threshold, virtual_quote, virtual_base, fee_bps, creator_fee_share_bps, damm_tier,
         damm_base_fee_bps, damm_max_fee_bps, price_tolerance_bps, creator_lp_bps, creator_lock_seconds, protocol_lock_seconds,
         protocol_fee_recipient, protocol_lp_recipient, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        t.label,
        getAddress(t.quoteAsset),
        q.symbol,
        q.decimals,
        String(t.totalSupply),
        String(t.curveSupply),
        String(t.migrationSupply),
        String(t.graduationThreshold),
        String(t.virtualQuote),
        String(t.virtualBase),
        Number(t.feeBps),
        Number(t.creatorFeeShareBps),
        Number(t.dammTier),
        Number(t.dammBaseFeeBps),
        Number(t.dammMaxFeeBps),
        Number(t.priceToleranceBps),
        Number(t.creatorLpBps),
        Number(t.creatorLockSeconds),
        Number(t.protocolLockSeconds),
        getAddress(t.protocolFeeRecipient),
        getAddress(t.protocolLpRecipient),
        on ? 1 : 0,
        now,
      );
    });
  }

  /** Reads token metadata for unseen tokens and fee config for new DLMM pairs. */
  private async describeNewPools(created: NewPool[], known: Map<string, TokenInfo>) {
    const unknownTokens = [...new Set(created.flatMap((p) => [p.token0, p.token1]))].filter((t) => !known.has(t));
    const calls: Call[] = [];
    for (const t of unknownTokens) {
      for (const fn of ["symbol", "name", "decimals"] as const) {
        calls.push({ target: t, data: encodeFunctionData({ abi: erc20Abi, functionName: fn }) });
      }
    }
    const dlmmNew = created.filter((p) => p.kind === "dlmm");
    for (const p of dlmmNew) {
      calls.push({ target: p.address, data: encodeFunctionData({ abi: dlmmPairAbi, functionName: "baseFeeBps" }) });
      calls.push({ target: p.address, data: encodeFunctionData({ abi: dlmmPairAbi, functionName: "protocolShareBps" }) });
    }
    const res = await multicall(this.env.RPC_URL, calls);
    let k = 0;
    const tokens: TokenInfo[] = unknownTokens.map((address) => {
      const symbol = decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: res[k++]! }) as string;
      const name = decodeFunctionResult({ abi: erc20Abi, functionName: "name", data: res[k++]! }) as string;
      const decimals = Number(decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: res[k++]! }));
      return { address, symbol, name, decimals, isQuote: address === this.quote };
    });
    const pools: PoolInfo[] = created.map((p) => {
      if (p.kind === "damm") return p as PoolInfo;
      const baseFeeBps = Number(decodeFunctionResult({ abi: dlmmPairAbi, functionName: "baseFeeBps", data: res[k++]! }));
      const protocolShareBps = Number(decodeFunctionResult({ abi: dlmmPairAbi, functionName: "protocolShareBps", data: res[k++]! }));
      return { ...p, baseFeeBps, protocolShareBps };
    });
    return { tokens, pools };
  }

  private async refreshPoolState(pools: PoolInfo[], tokens: Map<string, TokenInfo>, block: number) {
    if (pools.length === 0) return;
    const calls: Call[] = [];
    for (const p of pools) {
      if (p.kind === "damm") {
        for (const fn of ["getReserves", "currentFeeBps", "totalSupply"] as const) {
          calls.push({ target: p.address, data: encodeFunctionData({ abi: dammPoolAbi, functionName: fn }) });
        }
      } else {
        for (const fn of ["reserveX", "reserveY", "activeId"] as const) {
          calls.push({ target: p.address, data: encodeFunctionData({ abi: dlmmPairAbi, functionName: fn }) });
        }
      }
    }
    const res = await multicall(this.env.RPC_URL, calls, hex(block));
    const now = new Date().toISOString();
    const stmts: D1PreparedStatement[] = [];
    let k = 0;
    for (const p of pools) {
      const d0 = tokens.get(p.token0)?.decimals ?? 18;
      const d1 = tokens.get(p.token1)?.decimals ?? 18;
      let r0: bigint, r1: bigint, feeBps: number, activeId: number | null, supply: string | null, price: number | null;
      if (p.kind === "damm") {
        const [a, b] = decodeFunctionResult({ abi: dammPoolAbi, functionName: "getReserves", data: res[k++]! }) as [bigint, bigint];
        r0 = a;
        r1 = b;
        feeBps = Number(decodeFunctionResult({ abi: dammPoolAbi, functionName: "currentFeeBps", data: res[k++]! }));
        supply = String(decodeFunctionResult({ abi: dammPoolAbi, functionName: "totalSupply", data: res[k++]! }));
        activeId = null;
        price = dammPrice(r0, r1, d0, d1);
      } else {
        r0 = decodeFunctionResult({ abi: dlmmPairAbi, functionName: "reserveX", data: res[k++]! }) as bigint;
        r1 = decodeFunctionResult({ abi: dlmmPairAbi, functionName: "reserveY", data: res[k++]! }) as bigint;
        activeId = Number(decodeFunctionResult({ abi: dlmmPairAbi, functionName: "activeId", data: res[k++]! }));
        feeBps = p.baseFeeBps;
        supply = null;
        price = dlmmPrice(activeId, p.binStep!, d0, d1);
      }
      stmts.push(
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO pool_state (pool, reserve0, reserve1, fee_bps, active_id, total_supply, price, block_number, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(p.address, r0.toString(), r1.toString(), feeBps, activeId, supply, price, block, now),
      );
    }
    await this.env.DB.batch(stmts);
  }
}

/** Launch contract addresses from the manifest, or null where launches are not deployed. */
function launchContracts(contracts: Record<string, { address: string; deployBlock: number } | undefined>) {
  const f = contracts.LaunchFactory;
  const e = contracts.LpEscrow;
  const r = contracts.LaunchTemplateRegistry;
  if (!f || !e || !r) return null;
  return { factory: f.address, escrow: e.address, registry: r.address, deployBlock: Math.min(f.deployBlock, e.deployBlock, r.deployBlock) };
}

function launchStatements(
  db: D1Database,
  launches: ReturnType<typeof decodeLaunchCreated>,
  trades: ReturnType<typeof decodeCurveLogs>["trades"],
  events: ReturnType<typeof decodeCurveLogs>["events"],
  escrow: ReturnType<typeof decodeEscrowLogs>,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const l of launches) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO launches (token, curve, creator, creator_recipient, template_id, name, symbol, metadata_uri,
           created_block, created_tx, timestamp, block_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(l.token, l.curve, l.creator, l.creatorRecipient, l.templateId, l.name, l.symbol, l.metadataUri, l.createdBlock, l.createdTx, l.timestamp, l.blockHash),
    );
  }
  for (const t of trades) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO curve_trades (tx_hash, log_index, block_number, block_hash, timestamp, token, trader, recipient,
           is_buy, quote_amount, token_amount, fee, reserve_after, virtual_base_after, quote_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          t.txHash,
          t.logIndex,
          t.blockNumber,
          t.blockHash,
          t.timestamp,
          t.token,
          t.trader,
          t.recipient,
          t.isBuy ? 1 : 0,
          t.quoteAmount,
          t.tokenAmount,
          t.fee,
          t.reserveAfter,
          t.virtualBaseAfter,
          t.quoteValue,
        ),
    );
  }
  for (const e of events) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO launch_events (tx_hash, log_index, block_number, block_hash, timestamp, token, kind, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(e.txHash, e.logIndex, e.blockNumber, e.blockHash, e.timestamp, e.token, e.kind, JSON.stringify(e.data)),
    );
  }
  for (const r of escrow) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO escrow_events (tx_hash, log_index, block_number, block_hash, timestamp, lock_id, kind, lp_token,
           beneficiary, counterparty, amount, amount0, amount1, unlock_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          r.txHash,
          r.logIndex,
          r.blockNumber,
          r.blockHash,
          r.timestamp,
          r.lockId,
          r.kind,
          r.lpToken,
          r.beneficiary,
          r.counterparty,
          r.amount,
          r.amount0,
          r.amount1,
          r.unlockAt,
        ),
    );
  }
  return stmts;
}
