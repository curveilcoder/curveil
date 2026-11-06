/**
 * Webhook events from indexed rows. Pure: the indexer passes in what it decoded for a range and
 * the context the events need; see events.test.ts. Each event id is derived from the chain event
 * (type, transaction, log index), so re-indexing a range produces the same ids and a subscriber
 * never gets the same event twice under different ids.
 */
import { keccak256, toBytes } from "viem";
import type { WebhookEvent, WebhookEventType } from "@curveil/sdk/webhooks";
import type { LiquidityRow, PoolInfo, SwapRow } from "./process";
import type { CurveTradeRow, LaunchEventRow, LaunchRow } from "./launch";
import type { FeeDistributionRow } from "./factory";

/** An event before it is addressed to a network, plus the addresses a subscription can filter on. */
export type ChainEvent = Omit<WebhookEvent, "network" | "chainId"> & { type: WebhookEventType; addresses: string[] };

export const eventId = (type: string, key: string) => `evt_${keccak256(toBytes(`${type}:${key}`)).slice(2, 34)}`;
export const deliveryId = (subscription: string, event: string) => `dlv_${keccak256(toBytes(`${subscription}:${event}`)).slice(2, 34)}`;

type Meta = { txHash: string; logIndex: number; blockNumber: number; blockHash: string; timestamp: number };

function base(type: WebhookEventType, m: Meta, data: Record<string, unknown>, addresses: (string | null | undefined)[]): ChainEvent {
  return {
    id: eventId(type, `${m.txHash}:${m.logIndex}`),
    type,
    createdAt: new Date(m.timestamp * 1000).toISOString(),
    block: { number: m.blockNumber, hash: m.blockHash, timestamp: m.timestamp },
    transactionHash: m.txHash,
    logIndex: m.logIndex,
    finality: "sequencer",
    data,
    addresses: [...new Set(addresses.filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase()))],
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";

export type LaunchContext = { curve: string; operator: string | null; threshold: bigint; prevReserve: bigint };
export type LockUnlock = { lockId: number; lpToken: string | null; beneficiary: string; unlockAt: number };
export type Liquidation = Meta & Record<string, string | number | null>;

export type EventInput = {
  swaps?: SwapRow[];
  pools?: Map<string, PoolInfo>;
  liquidity?: LiquidityRow[];
  launches?: (LaunchRow & { operator?: string | null; operatorShareBps?: number | null })[];
  trades?: CurveTradeRow[];
  /** By token: the launch's curve, operator, graduation threshold and reserve before this range. */
  launchContext?: Map<string, LaunchContext>;
  launchEvents?: LaunchEventRow[];
  liquidations?: Liquidation[];
  /** By position id: owner and market, where known. */
  positions?: Map<string, { owner: string; marketId: number; isLong: boolean }>;
  distributions?: FeeDistributionRow[];
  unlocks?: LockUnlock[];
  /** The block where time-based events (unlocks) were seen. */
  at?: { number: number; hash: string; timestamp: number };
};

/** 0, 10, ..., 100: the last 10% step of the graduation threshold the reserve has reached. */
export function progressStep(reserve: bigint, threshold: bigint): number {
  if (threshold <= 0n) return 0;
  const step = Number((reserve * 10n) / threshold) * 10;
  return Math.min(100, Math.max(0, step));
}

export function chainEvents(i: EventInput): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const s of i.swaps ?? []) {
    const pool = i.pools?.get(s.pool);
    out.push(
      base(
        "swap",
        s,
        {
          venue: pool?.kind ?? "pool",
          pool: s.pool,
          sender: s.sender,
          recipient: s.recipient,
          tokenIn: s.tokenIn,
          tokenOut: s.tokenOut,
          amountIn: s.amountIn,
          amountOut: s.amountOut,
          fee: s.fee,
          feeBps: s.feeBps,
        },
        [s.pool, s.tokenIn, s.tokenOut, s.sender, s.recipient],
      ),
    );
  }
  for (const l of i.liquidity ?? []) {
    out.push(
      base(
        "liquidity.changed",
        l,
        { pool: l.pool, kind: l.kind, owner: l.owner, counterparty: l.counterparty, amount0: l.amount0, amount1: l.amount1, shares: l.shares, bins: l.bins },
        [l.pool, l.owner, l.counterparty],
      ),
    );
  }
  for (const l of i.launches ?? []) {
    const operator = l.operator && l.operator !== ZERO ? l.operator : null;
    out.push(
      base(
        "launch.created",
        { txHash: l.createdTx, logIndex: -1, blockNumber: l.createdBlock, blockHash: l.blockHash, timestamp: l.timestamp },
        {
          token: l.token,
          curve: l.curve,
          creator: l.creator,
          creatorRecipient: l.creatorRecipient,
          templateId: l.templateId,
          name: l.name,
          symbol: l.symbol,
          metadataURI: l.metadataUri,
          operator,
          operatorShareBps: operator ? (l.operatorShareBps ?? null) : null,
        },
        [l.token, l.curve, l.creator, operator],
      ),
    );
    // The factory log index is not kept on LaunchRow; the token makes the id unique.
    const last = out[out.length - 1]!;
    last.id = eventId("launch.created", l.token);
    last.logIndex = null;
  }
  // Trades are swaps too (venue "curve"), and each one may move the launch to its next step.
  const reserves = new Map<string, bigint>();
  const trades = [...(i.trades ?? [])].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const t of trades) {
    const ctx = i.launchContext?.get(t.token);
    out.push(
      base(
        "swap",
        t,
        {
          venue: "curve",
          pool: ctx?.curve ?? null,
          token: t.token,
          sender: t.trader,
          recipient: t.recipient,
          side: t.isBuy ? "buy" : "sell",
          quoteAmount: t.quoteAmount,
          tokenAmount: t.tokenAmount,
          fee: t.fee,
        },
        [ctx?.curve, t.token, t.trader, t.recipient, ctx?.operator],
      ),
    );
    if (!ctx) continue;
    const before = reserves.get(t.token) ?? ctx.prevReserve;
    const after = BigInt(t.reserveAfter);
    reserves.set(t.token, after);
    const from = progressStep(before, ctx.threshold);
    const to = progressStep(after, ctx.threshold);
    if (to > from) {
      out.push(
        base(
          "launch.progress",
          t,
          {
            token: t.token,
            curve: ctx.curve,
            operator: ctx.operator,
            progressPercent: to,
            previousPercent: from,
            reserve: t.reserveAfter,
            graduationThreshold: ctx.threshold.toString(),
          },
          [t.token, ctx.curve, ctx.operator],
        ),
      );
    }
  }
  for (const e of i.launchEvents ?? []) {
    if (e.kind !== "graduated") continue;
    const ctx = i.launchContext?.get(e.token);
    out.push(base("launch.graduated", e, { token: e.token, curve: ctx?.curve ?? null, operator: ctx?.operator ?? null, ...e.data }, [e.token, ctx?.curve, ctx?.operator, String(e.data.pool ?? "")]));
  }
  for (const l of i.liquidations ?? []) {
    const p = i.positions?.get(String(l.position_id));
    out.push(
      base(
        "perps.liquidation",
        l,
        {
          positionId: l.position_id,
          owner: p?.owner ?? null,
          marketId: p?.marketId ?? null,
          isLong: p?.isLong ?? null,
          liquidator: l.liquidator,
          price: l.price,
          pnl: l.pnl,
          funding: l.funding,
          fee: l.fee,
          toVault: l.to_vault,
        },
        [String(l.liquidator), p?.owner],
      ),
    );
  }
  for (const d of i.distributions ?? []) {
    if (d.kind !== "released") continue;
    out.push(base("operator.fee_paid", d, { operator: d.operator, token: d.token, recipient: d.recipient, amount: d.amount }, [d.operator, d.recipient, d.token]));
  }
  for (const u of i.unlocks ?? []) {
    const at = i.at ?? { number: 0, hash: "", timestamp: u.unlockAt };
    out.push({
      id: eventId("escrow.unlocked", String(u.lockId)),
      type: "escrow.unlocked",
      createdAt: new Date(u.unlockAt * 1000).toISOString(),
      block: at,
      transactionHash: null,
      logIndex: null,
      finality: "sequencer",
      data: { lockId: u.lockId, lpToken: u.lpToken, beneficiary: u.beneficiary, unlockAt: u.unlockAt },
      addresses: [u.lpToken, u.beneficiary].filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase()),
    });
  }
  return out;
}

export type Subscription = { id: string; events: string[]; addresses: string[] | null; createdTs: number };

/** Which subscriptions get an event: the type is subscribed, the event is not older than the
 *  subscription, and, if the subscription filters on addresses, one of them is involved. */
export function matches(sub: Subscription, e: ChainEvent): boolean {
  if (!sub.events.includes(e.type) && !sub.events.includes("*")) return false;
  const when = e.type === "escrow.unlocked" ? Number(e.data.unlockAt) : (e.block?.timestamp ?? 0);
  if (when < sub.createdTs) return false;
  if (sub.addresses && sub.addresses.length > 0) return e.addresses.some((a) => sub.addresses!.includes(a));
  return true;
}

/** The exact JSON body delivered for an event. */
export function payload(e: ChainEvent, network: "testnet" | "mainnet", chainId: number, test = false): string {
  const body: WebhookEvent = {
    id: e.id,
    type: e.type,
    network,
    chainId,
    createdAt: e.createdAt,
    block: e.block,
    transactionHash: e.transactionHash,
    logIndex: e.logIndex,
    finality: e.finality,
    data: e.data,
  };
  if (test) body.test = true;
  return JSON.stringify(body);
}
