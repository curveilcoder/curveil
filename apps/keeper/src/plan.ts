/**
 * What the keeper should do this tick, decided from chain state and current prices. Pure, so the
 * rules are tested without a chain. Every action is an ordinary public call: anyone may make it.
 *
 * Order of importance: liquidations (they protect the vault), request executions, cancelling
 * timed-out requests (refunds), take-profit and stop-loss fills, clearing dead orders, then
 * upkeep (recording a price so the vault's NAV stays fresh, accruing funding).
 */
import type { Hex } from "viem";

export const REQUEST_KIND = { Open: 1, Close: 2 } as const;
export const ORDER_KIND = { TakeProfit: 1, StopLoss: 2 } as const;

export type MarketView = {
  id: number;
  feedId: Hex;
  oiLong: bigint;
  oiShort: bigint;
  fundingUpdatedAt: number;
  /** Timestamp of the newest price the oracle adapter has recorded for this feed. */
  priceAt: number;
};
export type RequestView = { id: bigint; positionId: bigint; market: number; createdAt: number; kind: number };
export type PositionView = { id: bigint; market: number; isLong: boolean; liquidatable: boolean };
export type OrderView = {
  id: bigint;
  positionId: bigint;
  market: number;
  kind: number;
  isLong: boolean;
  createdAt: number;
  expiresAt: number;
  triggerPrice: bigint;
  acceptablePrice: bigint;
  /** The position is open and still owned by whoever placed the order. */
  positionLive: boolean;
};
export type SignedPrice = { price: bigint; timestamp: number; report: Hex };

export type Action =
  | { kind: "liquidate"; key: string; market: number; positionId: bigint }
  | { kind: "execute"; key: string; market: number; requestId: bigint }
  | { kind: "cancel"; key: string; requestId: bigint }
  | { kind: "fill"; key: string; market: number; orderId: bigint }
  | { kind: "expire"; key: string; orderId: bigint }
  | { kind: "submit"; key: string; market: number }
  | { kind: "funding"; key: string; market: number };

export type PlanInput = {
  now: number;
  requestTimeout: number;
  markets: MarketView[];
  prices: Map<number, SignedPrice>;
  requests: RequestView[];
  positions: PositionView[];
  orders: OrderView[];
  /** Action keys sent recently and maybe not mined yet. */
  inflight: Set<string>;
};

export type PlanOptions = { submitAfter: number; fundingEvery: number; maxActions: number; maxExpires: number };
export const DEFAULT_PLAN: PlanOptions = { submitAfter: 600, fundingEvery: 3600, maxActions: 8, maxExpires: 2 };

/** OrderManager.triggered: take-profit when the price moves in the position's favour, stop-loss when against. */
export function triggered(kind: number, isLong: boolean, price: bigint, trigger: bigint): boolean {
  const up = price >= trigger;
  const down = price <= trigger;
  if (kind === ORDER_KIND.TakeProfit) return isLong ? up : down;
  if (kind === ORDER_KIND.StopLoss) return isLong ? down : up;
  return false;
}

export function acceptable(isLong: boolean, price: bigint, limit: bigint): boolean {
  return isLong ? price >= limit : price <= limit;
}

export function plan(input: PlanInput, opts: PlanOptions = DEFAULT_PLAN): Action[] {
  const out: Action[] = [];
  const usesPrice = new Set<number>();
  const push = (a: Action) => {
    if (input.inflight.has(a.key)) return;
    out.push(a);
    if ("market" in a && a.kind !== "funding") usesPrice.add(a.market);
  };

  const liquidating = new Set<bigint>();
  for (const p of input.positions) {
    if (!p.liquidatable || !input.prices.has(p.market)) continue;
    liquidating.add(p.id);
    push({ kind: "liquidate", key: `liq:${p.id}`, market: p.market, positionId: p.id });
  }

  for (const r of input.requests) {
    const deadline = r.createdAt + input.requestTimeout;
    if (input.now > deadline) {
      push({ kind: "cancel", key: `cancel:${r.id}`, requestId: r.id });
      continue;
    }
    const price = input.prices.get(r.market);
    if (!price || price.timestamp <= r.createdAt || price.timestamp > deadline) continue;
    push({ kind: "execute", key: `req:${r.id}`, market: r.market, requestId: r.id });
  }

  let expires = 0;
  for (const o of input.orders) {
    const expired = o.expiresAt !== 0 && input.now > o.expiresAt;
    if (!o.positionLive || expired) {
      if (expires < opts.maxExpires) {
        expires++;
        push({ kind: "expire", key: `expire:${o.id}`, orderId: o.id });
      }
      continue;
    }
    if (liquidating.has(o.positionId)) continue;
    const price = input.prices.get(o.market);
    if (!price || price.timestamp <= o.createdAt) continue;
    if (!triggered(o.kind, o.isLong, price.price, o.triggerPrice)) continue;
    if (!acceptable(o.isLong, price.price, o.acceptablePrice)) continue;
    push({ kind: "fill", key: `order:${o.id}`, market: o.market, orderId: o.id });
  }

  for (const m of input.markets) {
    const hasInterest = m.oiLong + m.oiShort > 0n;
    if (!hasInterest) continue;
    // Any execution or liquidation above records a price too.
    if (!usesPrice.has(m.id) && input.prices.has(m.id) && input.now - m.priceAt >= opts.submitAfter) {
      push({ kind: "submit", key: `submit:${m.id}`, market: m.id });
    }
    if (input.now - m.fundingUpdatedAt >= opts.fundingEvery) push({ kind: "funding", key: `funding:${m.id}`, market: m.id });
  }

  return out.slice(0, opts.maxActions);
}
