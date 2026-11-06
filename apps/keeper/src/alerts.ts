/**
 * Operational alerts. After every pass the keeper checks what it can see and posts to
 * ALERT_WEBHOOK_URL (Slack, Discord or any endpoint that accepts JSON) when something needs a
 * person: a problem when it starts, again every `REPEAT_MS` while it lasts, and once when it
 * clears. Admin changes queued in the timelock are posted once each, so nobody is surprised
 * when one executes.
 */
import type { SourceHealth } from "./prices";

export const REPEAT_MS = 60 * 60_000;
export const STALE_PRICE_S = 900;
export const ERRORS_BEFORE_ALERT = 3;

export type Severity = "critical" | "warning" | "info";
export type Alert = { key: string; severity: Severity; title: string; detail: string };

export type Snapshot = {
  now: number;
  gasLow: boolean;
  gasBalanceWei: string | null;
  minGasWei: string;
  consecutiveErrors: number;
  lastError: string | null;
  /** Only when the keeper signs its own prices (testnet). */
  sources: SourceHealth | null;
  minSources: number;
  markets: { id: number; symbol: string; openInterest: bigint; priceAt: number }[];
  broadcaster: { reachable: boolean; health: string | null } | null;
};

const eth = (wei: string | null) => (wei === null ? "unknown" : `${(Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(4)} ETH`);

/** The problems visible right now. Pure, so it is tested without a chain. */
export function evaluate(s: Snapshot): Alert[] {
  const out: Alert[] = [];
  if (s.gasLow) {
    out.push({ key: "keeper.gas", severity: "critical", title: "Keeper gas is low", detail: `Balance ${eth(s.gasBalanceWei)}, minimum ${eth(s.minGasWei)}. Top up the keeper wallet or liquidations and fills stop.` });
  }
  if (s.consecutiveErrors >= ERRORS_BEFORE_ALERT) {
    out.push({ key: "keeper.errors", severity: "critical", title: "Keeper passes are failing", detail: `${s.consecutiveErrors} in a row. Last error: ${s.lastError ?? "unknown"}` });
  }
  if (s.sources) {
    const up = Object.values(s.sources).filter((x) => x.ok).length;
    if (up < s.minSources) {
      const down = Object.entries(s.sources).filter(([, x]) => !x.ok).map(([k]) => k);
      out.push({ key: "prices.sources", severity: "critical", title: "Not enough price sources", detail: `${up} of ${Object.keys(s.sources).length} answering, ${s.minSources} needed. Down: ${down.join(", ") || "none"}.` });
    }
  }
  for (const m of s.markets) {
    const age = m.priceAt ? Math.floor(s.now / 1000) - m.priceAt : Infinity;
    if (m.openInterest > 0n && age > STALE_PRICE_S) {
      out.push({ key: `prices.stale.${m.id}`, severity: "critical", title: `${m.symbol} price is stale`, detail: `The newest recorded price is ${Number.isFinite(age) ? `${Math.round(age / 60)} minutes` : "missing"} old with open positions. Vault deposits and redemptions revert until it is refreshed.` });
    }
  }
  if (s.broadcaster && (!s.broadcaster.reachable || (s.broadcaster.health && s.broadcaster.health !== "ok"))) {
    out.push({ key: "broadcaster", severity: "warning", title: "Broadcaster needs attention", detail: s.broadcaster.reachable ? `Reports health "${s.broadcaster.health}". Users can still submit from their own wallets.` : "Not answering. Users can still submit from their own wallets." });
  }
  return out;
}

export type SentLog = Record<string, number>;

/** What to post now, given what was posted before. */
export function plan(active: Alert[], sent: SentLog, now: number, repeatMs = REPEAT_MS): { post: Alert[]; resolved: string[]; next: SentLog } {
  const next: SentLog = {};
  const post: Alert[] = [];
  for (const a of active) {
    const last = sent[a.key];
    if (last === undefined || now - last >= repeatMs) {
      post.push(a);
      next[a.key] = now;
    } else next[a.key] = last;
  }
  const resolved = Object.keys(sent).filter((k) => !active.some((a) => a.key === k));
  return { post, resolved, next };
}

export type QueuedCall = { id: string; target: string; data: string; delay: bigint; txHash: string };

/** One message for a call queued in the timelock. */
export function queuedAlert(network: string, c: QueuedCall, explorer: string): Alert {
  const hours = Number(c.delay) / 3600;
  return {
    key: `timelock.${c.id}`,
    severity: "info",
    title: "Admin change queued in the timelock",
    detail: `Target ${c.target}, call ${c.data.slice(0, 10)}, executable in ${hours >= 1 ? `${hours} hours` : `${Number(c.delay)} seconds`}. ${explorer}/tx/${c.txHash}`,
  };
}

const ICON: Record<Severity, string> = { critical: "🔴", warning: "🟠", info: "🔵" };

/** Slack reads `text`, Discord reads `content`; other endpoints get the structured fields. */
export function message(network: string, alerts: Alert[], resolved: string[]) {
  const lines = [
    ...alerts.map((a) => `${ICON[a.severity]} *Curveil ${network}: ${a.title}*\n${a.detail}`),
    ...resolved.map((k) => `🟢 *Curveil ${network}: resolved* (${k})`),
  ];
  const text = lines.join("\n\n");
  return { text, content: text.slice(0, 2000), network, alerts, resolved };
}

export async function deliver(url: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) });
    return r.ok;
  } catch {
    return false;
  }
}
