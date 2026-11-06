/**
 * Pure decoding of perps events (PerpEngine, OrderManager, OracleAdapter, PerpLiquidityVault,
 * ShieldedPerpsAdapter) into database rows. No I/O; see perps.test.ts. All public chain data.
 */
import { decodeEventLog, getAddress, type Abi, type Hex } from "viem";
import engineAbiJson from "@curveil/manifest/abis/PerpEngine.json";
import ordersAbiJson from "@curveil/manifest/abis/OrderManager.json";
import oracleAbiJson from "@curveil/manifest/abis/OracleAdapter.json";
import perpVaultAbiJson from "@curveil/manifest/abis/PerpLiquidityVault.json";
import perpsAdapterAbiJson from "@curveil/manifest/abis/ShieldedPerpsAdapter.json";
import type { RpcLog } from "./rpc";

export const perpEngineAbi = engineAbiJson as Abi;
export const orderManagerAbi = ordersAbiJson as Abi;
export const oracleAdapterAbi = oracleAbiJson as Abi;
export const perpVaultAbi = perpVaultAbiJson as Abi;
export const perpsAdapterAbi = perpsAdapterAbiJson as Abi;

export type PerpsAddresses = { engine: string; orders: string; oracle: string; vault: string; adapter: string | null };

export const REASONS = ["none", "timeout", "price", "market_closed", "leverage", "min_collateral", "open_interest", "capacity", "not_open", "liquidatable"] as const;
export const ORDER_KINDS = ["none", "take_profit", "stop_loss"] as const;
export const ORDER_CANCEL_REASONS = ["none", "owner", "expired", "position_gone"] as const;

type Meta = { txHash: string; logIndex: number; blockNumber: number; blockHash: string; timestamp: number };
type Row = Meta & Record<string, string | number | null>;

export type PerpsRows = {
  markets: Row[];
  requests: Row[];
  positions: Row[];
  liquidations: Row[];
  orders: Row[];
  funding: Row[];
  prices: Row[];
  vault: Row[];
  claims: Row[];
};

const s = (v: unknown) => (v === undefined || v === null ? null : String(v));
const addr = (v: unknown) => getAddress(v as string);
const flag = (v: unknown) => (v ? 1 : 0);

function meta(log: RpcLog, timestamps: Map<number, number>): Meta {
  const blockNumber = Number(BigInt(log.blockNumber));
  return { txHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), blockNumber, blockHash: log.blockHash, timestamp: timestamps.get(blockNumber) ?? 0 };
}

export function decodePerpsLogs(logs: RpcLog[], at: PerpsAddresses, timestamps: Map<number, number>): PerpsRows {
  const out: PerpsRows = { markets: [], requests: [], positions: [], liquidations: [], orders: [], funding: [], prices: [], vault: [], claims: [] };
  const abiOf = new Map<string, Abi>([
    [getAddress(at.engine), perpEngineAbi],
    [getAddress(at.orders), orderManagerAbi],
    [getAddress(at.oracle), oracleAdapterAbi],
    [getAddress(at.vault), perpVaultAbi],
  ]);
  if (at.adapter) abiOf.set(getAddress(at.adapter), perpsAdapterAbi);
  for (const log of logs) {
    if (log.removed) continue;
    const abi = abiOf.get(getAddress(log.address));
    if (!abi) continue;
    let ev: { eventName: string; args: unknown };
    try {
      ev = decodeEventLog({ abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as Record<string, any>;
    const m = meta(log, timestamps);
    switch (ev.eventName) {
      case "MarketSet": {
        const c = a.config as Record<string, unknown>;
        const config = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
        out.markets.push({ ...m, market_id: Number(a.market), event: "set", feed_id: s(c.feedId), enabled: flag(c.enabled), config: JSON.stringify(config) });
        break;
      }
      case "MarketEnabled":
        out.markets.push({ ...m, market_id: Number(a.market), event: "enabled", feed_id: null, enabled: flag(a.enabled), config: null });
        break;
      case "RequestCreated":
        out.requests.push({
          ...m,
          event: "created",
          request_id: s(a.requestId),
          position_id: s(a.positionId),
          owner: addr(a.owner),
          kind: Number(a.kind) === 1 ? "open" : "close",
          market_id: Number(a.market),
          is_long: flag(a.isLong),
          size: s(a.size),
          collateral: s(a.collateral),
          acceptable_price: s(a.acceptablePrice),
          execution_fee: s(a.executionFee),
          price: null,
          reason: null,
          fee_charged: null,
          executor: null,
        });
        break;
      case "RequestExecuted":
        out.requests.push({ ...m, ...emptyRequest, event: "executed", request_id: s(a.requestId), position_id: s(a.positionId), price: s(a.price), executor: addr(a.executor) });
        break;
      case "RequestCancelled": {
        const executor = addr(a.executor);
        out.requests.push({
          ...m,
          ...emptyRequest,
          event: "cancelled",
          request_id: s(a.requestId),
          position_id: s(a.positionId),
          reason: REASONS[Number(a.reason)] ?? String(a.reason),
          price: s(a.price),
          fee_charged: s(a.feeCharged),
          executor: executor === ZERO ? null : executor,
        });
        break;
      }
      case "PositionOpened": {
        const o = a.o as Record<string, bigint>;
        out.positions.push({
          ...m,
          ...emptyPosition,
          event: "opened",
          position_id: s(a.positionId),
          owner: addr(a.owner),
          market_id: Number(a.market),
          is_long: flag(a.isLong),
          version: Number(a.version),
          price: s(o.price),
          size: s(o.size),
          collateral: s(o.collateral),
          fee: s(o.openFee),
          detail: JSON.stringify({ reserve: s(o.reserve), tokens: s(o.tokens) }),
        });
        break;
      }
      case "PositionDecreased": {
        const x = a.s as Record<string, bigint>;
        out.positions.push({
          ...m,
          ...emptyPosition,
          event: "decreased",
          position_id: s(a.positionId),
          executor: addr(a.executor),
          version: Number(a.version),
          price: s(x.price),
          size_delta: s(x.sizeDelta),
          size: s(x.size),
          collateral: s(x.collateral),
          pnl: s(x.pnl),
          funding: s(x.funding),
          gain: s(x.gain),
          fee: s(x.closeFee),
          execution_fee: s(x.executionFee),
          amount: s(x.payout),
        });
        break;
      }
      case "CollateralAdded":
        out.positions.push({ ...m, ...emptyPosition, event: "collateral", position_id: s(a.positionId), amount: s(a.amount), collateral: s(a.collateral), version: Number(a.version) });
        break;
      case "Payout":
        out.positions.push({ ...m, ...emptyPosition, event: "payout", position_id: s(a.positionId), owner: addr(a.owner), amount: s(a.amount) });
        break;
      case "PositionLiquidated": {
        const l = a.l as Record<string, bigint>;
        out.liquidations.push({
          ...m,
          position_id: s(a.positionId),
          liquidator: addr(a.liquidator),
          price: s(l.price),
          pnl: s(l.pnl),
          funding: s(l.funding),
          fee: s(l.fee),
          to_vault: s(l.toVault),
          version: Number(a.version),
        });
        break;
      }
      case "FundingUpdated":
        out.funding.push({
          ...m,
          market_id: Number(a.market),
          rate: s(a.rate),
          funding_long: s(a.fundingLong),
          funding_short: s(a.fundingShort),
          oi_long: s(a.oiLong),
          oi_short: s(a.oiShort),
        });
        break;
      case "OrderPlaced":
        out.orders.push({
          ...m,
          ...emptyOrder,
          event: "placed",
          order_id: s(a.orderId),
          position_id: s(a.positionId),
          owner: addr(a.owner),
          kind: ORDER_KINDS[Number(a.kind)] ?? String(a.kind),
          trigger_price: s(a.triggerPrice),
          size: s(a.size),
          acceptable_price: s(a.acceptablePrice),
          execution_fee: s(a.executionFee),
          expires_at: Number(a.expiresAt),
        });
        break;
      case "OrderExecuted":
        out.orders.push({ ...m, ...emptyOrder, event: "executed", order_id: s(a.orderId), position_id: s(a.positionId), price: s(a.price), size_closed: s(a.sizeClosed), executor: addr(a.executor) });
        break;
      case "OrderCancelled":
        out.orders.push({ ...m, ...emptyOrder, event: "cancelled", order_id: s(a.orderId), position_id: s(a.positionId), reason: ORDER_CANCEL_REASONS[Number(a.reason)] ?? String(a.reason) });
        break;
      case "PriceRecorded":
        out.prices.push({ ...m, feed_id: s(a.feedId), price: s(a.price), report_timestamp: Number(a.timestamp) });
        break;
      case "Deposited":
        out.vault.push({ ...m, event: "deposit", account: addr(a.account), receiver: null, assets: s(a.assets), shares: s(a.shares), nav_before: s(a.navBefore) });
        break;
      case "Redeemed":
        out.vault.push({ ...m, event: "redeem", account: addr(a.owner), receiver: addr(a.receiver), assets: s(a.assets), shares: s(a.shares), nav_before: s(a.navBefore) });
        break;
      case "ClaimOpened":
        out.claims.push({ ...m, event: "opened", claim_id: s(a.claimId), position_id: s(a.positionId), request_id: s(a.requestId), amount: null, kept: null });
        break;
      case "ClaimCollected":
        out.claims.push({ ...m, event: "collected", claim_id: s(a.claimId), position_id: s(a.positionId), request_id: null, amount: s(a.amount), kept: flag(a.kept) });
        break;
    }
  }
  return out;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const emptyRequest = {
  owner: null, kind: null, market_id: null, is_long: null, size: null, collateral: null, acceptable_price: null, execution_fee: null,
  price: null, reason: null, fee_charged: null, executor: null,
};
const emptyPosition = {
  owner: null, market_id: null, is_long: null, version: null, price: null, size_delta: null, size: null, collateral: null, pnl: null,
  funding: null, gain: null, fee: null, execution_fee: null, amount: null, executor: null, detail: null,
};
const emptyOrder = {
  owner: null, kind: null, trigger_price: null, size: null, acceptable_price: null, execution_fee: null, expires_at: null, price: null,
  size_closed: null, executor: null, reason: null,
};

export const PERPS_TABLES = {
  markets: "perp_markets",
  requests: "perp_requests",
  positions: "perp_positions",
  liquidations: "liquidations",
  orders: "perp_orders",
  funding: "funding_updates",
  prices: "oracle_prices",
  vault: "perp_vault_events",
  claims: "perp_claims",
} as const satisfies Record<keyof PerpsRows, string>;

const META_COLUMNS = { txHash: "tx_hash", logIndex: "log_index", blockNumber: "block_number", blockHash: "block_hash", timestamp: "timestamp" } as const;

export function perpsStatements(db: D1Database, rows: PerpsRows): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const [key, table] of Object.entries(PERPS_TABLES) as [keyof PerpsRows, string][]) {
    for (const r of rows[key]) {
      const cols = Object.keys(r).map((k) => META_COLUMNS[k as keyof typeof META_COLUMNS] ?? k);
      stmts.push(db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(r)));
    }
  }
  return stmts;
}
