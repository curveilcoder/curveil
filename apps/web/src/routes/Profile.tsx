import { useMemo } from "react";
import "../styles/profile.css";
import { Link, Navigate, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useConnection } from "wagmi";
import { isAddress } from "viem";
import { Loading, Sk, SkRows } from "../components/Skeleton";
import { CopyAddress } from "../components/CopyAddress";
import { TokenPair } from "../components/TokenPair";
import { IndexerNote } from "../components/ModuleStatus";
import { WalletAction } from "../components/WalletAction";
import { LaunchCard, LaunchCardSkeleton } from "./Launch";
import { ApiKeys, WebhookConsole } from "../components/DevConsole";
import { PoolRow } from "./Markets";
import { ManagePositions } from "./Liquidity";
import { PositionSummary } from "./Perps";
import type { VaultSub } from "./Vault";
import { SubTabs } from "../components/SubTabs";
import { PageHead } from "../components/PageHead";
import { QUOTE, explorerAddress, explorerTx, shortAddress } from "../lib/config";
import { fmtAmount, timeAgo } from "../lib/format";
import { untilLabel, useEscrow, useLaunchesBy, type Lock } from "../lib/launch";
import { kindLabel, pairLabel, useActivity, useMarkets, usePoolsBy, usePositions, type ActivityItem, type MarketPool } from "../lib/markets";
import { PERPS_DEPLOYED, usePerpPositions, usePerpsOverview } from "../lib/perps";
import { same } from "../lib/tokens";

export type ProfileTab = "launches" | "liquidity" | "perps" | "activity" | "vault" | "developer";
export type ProfileSub = "tokens" | "locks" | "positions" | "pools" | "keys" | "webhooks" | VaultSub;
export type ProfileSearch = { tab?: ProfileTab; sub?: ProfileSub };
const GROUPS: ProfileTab[] = ["launches", "liquidity", "perps", "activity", "vault", "developer"];
const SUBS: Record<ProfileTab, ProfileSub[]> = {
  launches: ["tokens", "locks"],
  liquidity: ["positions", "pools"],
  perps: [],
  activity: [],
  vault: ["overview", "shield", "send", "withdraw", "notes", "backup"],
  developer: ["keys", "webhooks"],
};
// Older links named the single tabs; send them to their group.
const LEGACY: Record<string, ProfileSearch> = { tokens: { tab: "launches", sub: "tokens" }, locks: { tab: "launches", sub: "locks" }, pools: { tab: "liquidity", sub: "pools" } };

export function parseProfileSearch(s: Record<string, unknown>): ProfileSearch {
  const tab = typeof s.tab === "string" ? s.tab : undefined;
  if (tab && LEGACY[tab]) return LEGACY[tab]!;
  if (!tab || !GROUPS.includes(tab as ProfileTab)) return {};
  const t = tab as ProfileTab;
  const sub = SUBS[t].includes(s.sub as ProfileSub) ? (s.sub as ProfileSub) : undefined;
  return sub ? { tab: t, sub } : { tab: t };
}

/** /profile: the connected wallet's own page, or a prompt to connect. */
export function ProfileMe() {
  const { address } = useConnection();
  const { tab, sub } = useSearch({ from: "/profile" });
  if (address) return <Navigate to="/profile/$address" params={{ address }} search={{ tab, sub }} replace />;
  return (
    <div className="wrap tk">
      <header className="tk-head">
        <div className="tk-id-text">
          <h1 className="pf-title">Profile</h1>
          <p className="tk-meta">Tokens you launched, your liquidity, pools you created, locks and activity, in one place.</p>
        </div>
      </header>
      <div className="panel" style={{ maxWidth: 520, marginBottom: 40 }}>
        <WalletAction verb="see your profile">{null}</WalletAction>
      </div>
      <p className="small muted">The shielded vault needs no wallet. <Link to="/vault">Open the vault</Link>.</p>
    </div>
  );
}

/** Deterministic disc for an address: two hues from its bytes. */
function AddressAvatar({ address, size = 72 }: { address: string; size?: number }) {
  const h1 = parseInt(address.slice(2, 6), 16) % 360;
  const h2 = (h1 + 40 + (parseInt(address.slice(6, 8), 16) % 120)) % 360;
  return <span className="pf-avatar" aria-hidden="true" style={{ width: size, height: size, background: `radial-gradient(circle at 30% 25%, hsl(${h1} 80% 62%), hsl(${h2} 70% 30%) 70%, #000)` }} />;
}

export function Profile() {
  const { address: raw } = useParams({ from: "/profile/$address" });
  const { tab: picked, sub: pickedSub } = useSearch({ from: "/profile/$address" });
  const navigate = useNavigate();
  const { address: me } = useConnection();
  const a = isAddress(raw, { strict: false }) ? raw : undefined;
  const own = same(a, me);

  const launches = useLaunchesBy(a);
  const pools = usePoolsBy(a);
  const positions = usePositions(a);
  const markets = useMarkets();
  const locks = useEscrow(a);
  const perps = usePerpPositions(a);
  const activity = useActivity(a);

  const openLocks = useMemo(() => (locks.data ?? []).filter((l) => !l.claimed || l.pendingFees0 !== "0" || l.pendingFees1 !== "0"), [locks.data]);
  const livePerps = useMemo(() => (perps.data?.positions ?? []).filter((p) => p.status === "open" || p.status === "pending"), [perps.data]);
  const lpCount = positions.data ? positions.data.damm.length + positions.data.dlmm.length : null;

  if (!a) {
    return (
      <div className="wrap">
        <PageHead kicker="Profile" label="Profile" title="Profile not found" lead={<><span className="mono">{raw}</span> is not a valid wallet address.</>} />
        <Link to="/profile" className="btn">Your profile</Link>
      </div>
    );
  }

  const counts: Record<ProfileSub | ProfileTab, number | null> = {
    tokens: launches.data?.length ?? null,
    locks: locks.data ? openLocks.length : null,
    positions: lpCount,
    pools: pools.data?.length ?? null,
    launches: launches.data?.length ?? null,
    liquidity: lpCount,
    perps: perps.data ? livePerps.length : null,
    activity: null,
    vault: null,
    developer: null,
    keys: null,
    webhooks: null,
    overview: null,
    shield: null,
    send: null,
    withdraw: null,
    notes: null,
    backup: null,
  };
  // The vault has its own page. Keys and webhooks are private, so they show only on your own profile.
  const tabs = GROUPS.filter((t) => t !== "vault" && (t !== "perps" || PERPS_DEPLOYED) && (t !== "developer" || own));
  // Without a choice, open the first section that has something in it.
  const tab: ProfileTab = picked && tabs.includes(picked) ? picked : (tabs.find((t) => (counts[t] ?? 0) > 0 || (t === "launches" && (counts.locks ?? 0) > 0) || (t === "liquidity" && (counts.pools ?? 0) > 0)) ?? "launches");
  const subs = SUBS[tab];
  const sub: ProfileSub | undefined = pickedSub && subs.includes(pickedSub) ? pickedSub : subs.find((x) => (counts[x] ?? 0) > 0) ?? subs[0];
  const go = (t: ProfileTab, x?: ProfileSub) => void navigate({ to: "/profile/$address", params: { address: raw }, search: x ? { tab: t, sub: x } : { tab: t }, replace: true, resetScroll: false });
  const label: Record<ProfileTab, string> = { launches: "Launches", liquidity: "Liquidity", perps: "Perps", activity: "Activity", vault: "Vault", developer: "Developer" };
  const subLabel: Partial<Record<ProfileSub, string>> = { tokens: "Tokens launched", locks: "Locked liquidity", positions: "Positions", pools: "Pools created", keys: "API keys", webhooks: "Webhooks" };
  const count = (n: number | null) => (n === null ? <Sk w="3ch" /> : n.toLocaleString("en-US"));

  return (
    <div className="wrap tk">
      <header className="tk-head">
        <div className="tk-id">
          <AddressAvatar address={a} />
          <div className="tk-id-text">
            <div className="tk-name">
              <h1 className="mono pf-addr">{shortAddress(a)}</h1>
              {own && <span className="tag tag-shielded">You</span>}
            </div>
            <p className="tk-meta">
              <CopyAddress value={a} label={a} />
              <a href={explorerAddress(a)} target="_blank" rel="noreferrer" className="tk-link">Explorer ↗</a>
            </p>
          </div>
        </div>
        {own && (
          <div className="pf-actions">
            <Link to="/launch/new" className="btn btn-sm">Create a token</Link>
            <Link to="/pools" className="btn btn-sm">Add liquidity</Link>
          </div>
        )}
      </header>

      <div className="pf-body">
        <dl className="tk-stats pf-stats">
          <div><dt>Tokens launched</dt><dd>{count(counts.tokens)}</dd></div>
          <div><dt>Pools created</dt><dd>{count(counts.pools)}</dd></div>
          <div><dt>Liquidity positions</dt><dd>{count(counts.liquidity)}</dd></div>
          <div><dt>Escrow locks</dt><dd>{count(counts.locks)}</dd></div>
          {PERPS_DEPLOYED && <div><dt>Open perps</dt><dd>{count(counts.perps)}</dd></div>}
        </dl>

        <p className="pf-note small">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
          Public activity only. Anything done through the shielded vault is not linked to this address, so it never shows here.
        </p>

        <section className="tk-tabs">
          <div className="tk-tablist" role="tablist" aria-label="Profile">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => go(t)}>
                {label[t]}
                {counts[t] !== null && <span className="tk-count">{counts[t]!.toLocaleString("en-US")}</span>}
              </button>
            ))}
            {tab !== "vault" && tab !== "developer" && <span className="tk-tab-note"><IndexerNote /></span>}
          </div>
          <div role="tabpanel">
            {subs.length > 0 && tab !== "vault" && (
              <SubTabs<ProfileSub> label={label[tab]} value={sub!} onChange={(x) => go(tab, x)} items={subs.map((x) => [x, subLabel[x] ?? x, counts[x]])} />
            )}
            {tab === "launches" && sub === "tokens" && <TokensTab q={launches} own={own} />}
            {tab === "launches" && sub === "locks" && <LocksTab q={locks} open={openLocks} own={own} />}
            {tab === "liquidity" && sub === "positions" && <LiquidityTab q={positions} markets={markets.data} loading={markets.isLoading} own={own} refetch={positions.refetch} />}
            {tab === "liquidity" && sub === "pools" && <PoolsTab q={pools} own={own} />}
            {tab === "perps" && <PerpsTab q={perps} live={livePerps} own={own} />}
            {tab === "activity" && <ActivityTab q={activity} markets={markets.data} />}
            {tab === "developer" && own && sub === "keys" && <DevSection title="API keys" lead="Raise the API limit from 300 to 3,000 requests a minute."><ApiKeys /></DevSection>}
            {tab === "developer" && own && sub === "webhooks" && <DevSection title="Webhooks" lead="Signed events sent to your server when tokens launch, trade or graduate."><WebhookConsole /></DevSection>}
          </div>
        </section>
      </div>
    </div>
  );
}

type Q<T> = { data?: T; isLoading: boolean; isError: boolean };

function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="pf-empty">
      <p style={{ margin: 0 }}>{text}</p>
      {children}
    </div>
  );
}

function Failed({ what }: { what: string }) {
  return <p className="notice bad small" role="alert" style={{ margin: 0 }}>{what} could not be loaded. Nothing is shown rather than a guess.</p>;
}

function TokensTab({ q, own }: { q: Q<import("../lib/launch").Launch[]>; own: boolean }) {
  if (q.isError) return <Failed what="Launches" />;
  if (q.isLoading) {
    return (
      <div className="launch-grid" aria-busy="true">
        <Loading label="Loading launches" />
        {[0, 1, 2].map((i) => <LaunchCardSkeleton key={i} />)}
      </div>
    );
  }
  if (!q.data?.length) {
    return (
      <Empty text={own ? "You have not launched a token yet." : "This address has not launched a token."}>
        {own && <Link to="/launch/new" className="btn btn-primary btn-sm">Create a token</Link>}
      </Empty>
    );
  }
  return <div className="launch-grid">{q.data.map((l) => <LaunchCard key={l.token} l={l} />)}</div>;
}

function LiquidityTab({ q, markets, loading, own, refetch }: { q: Q<import("../lib/markets").Positions>; markets?: MarketPool[]; loading: boolean; own: boolean; refetch: () => unknown }) {
  const pool = (addr: string) => markets?.find((p) => same(p.address, addr));
  if (q.isError) return <Failed what="Positions" />;
  const rows = q.data ? [...q.data.damm.map((p) => ({ kind: "damm" as const, p })), ...q.data.dlmm.map((p) => ({ kind: "dlmm" as const, p }))] : [];
  if (!q.isLoading && !loading && rows.length === 0) {
    return (
      <Empty text={own ? "You have no liquidity in Curveil pools." : "This address has no liquidity in Curveil pools."}>
        {own && <Link to="/pools" className="btn btn-primary btn-sm">Add liquidity</Link>}
      </Empty>
    );
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="small muted" style={{ margin: 0 }}>
        Amounts and unclaimed fees are read live from the pool contracts.{own && " Liquidity added from the shielded vault is listed under Vault, not here."}
      </p>
      {own && q.data && markets ? (
        <ManagePositions data={q.data} markets={markets} onDone={() => void refetch()} />
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead>
              <tr><th>Pool</th><th>Type</th><th className="num">Holdings</th><th className="num">Share</th><th className="num">Unclaimed fees</th></tr>
            </thead>
            <tbody>
              {(q.isLoading || loading) && <SkRows cols={5} rows={2} num={[2, 3, 4]} />}
              {!loading && rows.map(({ kind, p }) => {
                const m = pool(p.pool);
                if (!m) return null;
                const [a0, a1, f0, f1] = kind === "damm"
                  ? [(p as any).amount0, (p as any).amount1, (p as any).pendingFees0, (p as any).pendingFees1]
                  : [(p as any).amountX, (p as any).amountY, (p as any).pendingFeesX, (p as any).pendingFeesY];
                return (
                  <tr key={p.pool}>
                    <td><Link to="/pools/$pool" params={{ pool: m.address }} className="pool-link"><TokenPair pool={m} size={24} /><span>{pairLabel(m)}</span></Link></td>
                    <td><span className={`tag ${m.kind === "dlmm" ? "tag-public" : "tag-illustration"}`}>{kindLabel(m)}</span></td>
                    <td className="num mono small">{fmtAmount(a0, m.token0.decimals)} {m.token0.symbol}<br />{fmtAmount(a1, m.token1.decimals)} {m.token1.symbol}</td>
                    <td className="num mono small">{kind === "damm" ? `${((p as any).shareOfPool * 100).toFixed(2)}%` : `${(p as any).bins.length} bins`}</td>
                    <td className="num mono small">{fmtAmount(f0, m.token0.decimals)} {m.token0.symbol}<br />{fmtAmount(f1, m.token1.decimals)} {m.token1.symbol}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PoolsTab({ q, own }: { q: Q<MarketPool[]>; own: boolean }) {
  const quote = QUOTE?.symbol ?? "quote";
  if (q.isError) return <Failed what="Pools" />;
  if (!q.isLoading && !q.data?.length) {
    return (
      <Empty text={own ? "You have not created a pool yet." : "This address has not created a pool."}>
        <p className="small muted" style={{ margin: 0 }}>Pools made when a launch graduates belong to the launch, not to whoever finished the curve.</p>
        {own && <Link to="/pools/new" className="btn btn-primary btn-sm">Create a pool</Link>}
      </Empty>
    );
  }
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data markets-table">
        <thead>
          <tr><th>Pool</th><th>Type</th><th className="num">Price</th><th className="num">Liquidity ({quote})</th><th className="num">Volume 24h</th><th className="num">Fees 24h</th><th className="num">Fee now</th><th>Last trade</th></tr>
        </thead>
        <tbody>
          {q.isLoading && <SkRows cols={8} rows={2} num={[2, 3, 4, 5, 6]} />}
          {q.data?.map((p) => <PoolRow key={p.address} p={p} />)}
        </tbody>
      </table>
    </div>
  );
}

function LocksTab({ q, open, own }: { q: Q<Lock[]>; open: Lock[]; own: boolean }) {
  if (q.isError) return <Failed what="Locks" />;
  if (!q.isLoading && open.length === 0) {
    return <Empty text={own ? "You hold no escrow locks." : "This address holds no escrow locks."}><p className="small muted" style={{ margin: 0 }}>A launch's creator receives a lock on part of the LP shares when the token graduates.</p></Empty>;
  }
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data">
        <thead><tr><th>Lock</th><th>Pool</th><th className="num">Underlying</th><th>Status</th><th className="num">Unclaimed fees</th></tr></thead>
        <tbody>
          {q.isLoading && <SkRows cols={5} rows={2} num={[2, 4]} />}
          {open.map((l) => {
            const t0 = l.pool?.token0;
            const t1 = l.pool?.token1;
            return (
              <tr key={l.id}>
                <td className="mono small">#{l.id}</td>
                <td>{l.launch ? <Link to="/launch/$token" params={{ token: l.launch.token }}>{t0 && t1 ? `${t0.symbol} / ${t1.symbol}` : l.launch.symbol}</Link> : <span className="mono small">{shortAddress(l.lpToken)}</span>}</td>
                <td className="num mono small">{t0 && t1 ? <>{fmtAmount(l.underlying0, t0.decimals)} {t0.symbol}<br />{fmtAmount(l.underlying1, t1.decimals)} {t1.symbol}</> : "–"}</td>
                <td className="small">{l.claimed ? "LP claimed" : l.unlockAt * 1000 <= Date.now() ? <span className="good-text">Unlocked</span> : `Unlocks ${untilLabel(l.unlockAt)}`}</td>
                <td className="num mono small">{t0 && t1 ? <>{fmtAmount(l.pendingFees0, t0.decimals)} {t0.symbol}<br />{fmtAmount(l.pendingFees1, t1.decimals)} {t1.symbol}</> : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PerpsTab({ q, live, own }: { q: Q<{ positions: import("../lib/perps").LivePosition[] }>; live: import("../lib/perps").LivePosition[]; own: boolean }) {
  const overview = usePerpsOverview();
  if (q.isError) return <Failed what="Perp positions" />;
  if (q.isLoading) {
    return (
      <div className="grid-2" aria-busy="true">
        <Loading label="Loading positions" />
        {[0, 1].map((i) => <div key={i} className="panel stack"><Sk w="12ch" /><Sk block w="100%" h={72} /></div>)}
      </div>
    );
  }
  const closed = (q.data?.positions.length ?? 0) - live.length;
  if (live.length === 0) {
    return (
      <Empty text={own ? "You have no open perp positions." : "This address has no open perp positions."}>
        {closed > 0 && <p className="small muted" style={{ margin: 0 }}>{closed} closed {closed === 1 ? "position" : "positions"} earlier.</p>}
        {own && <Link to="/perps" className="btn btn-primary btn-sm">Open a position</Link>}
      </Empty>
    );
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid-2">
        {live.map((p) => <div key={p.id} className="panel stack"><PositionSummary p={p} m={overview.data?.markets.find((m) => m.id === p.market)} /></div>)}
      </div>
      {closed > 0 && <p className="small muted" style={{ margin: 0 }}>Plus {closed} closed {closed === 1 ? "position" : "positions"}.{own && <> Manage on <Link to="/perps">Perps</Link>.</>}</p>}
    </div>
  );
}

const LIQ_LABEL: Record<string, string> = { add: "Add", remove: "Remove", claim: "Claim fees", transfer_in: "Received LP", transfer_out: "Sent LP" };

function ActivityTab({ q, markets }: { q: Q<ActivityItem[]>; markets?: MarketPool[] }) {
  const poolOf = (addr: string) => markets?.find((p) => same(p.address, addr));
  if (q.isError) return <Failed what="Activity" />;
  if (!q.isLoading && !q.data?.length) return <Empty text="No public swaps or liquidity changes from this address yet." />;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data pf-activity">
        <thead><tr><th>Type</th><th>Pool</th><th>Details</th><th className="num">Age</th></tr></thead>
        <tbody>
          {q.isLoading && <SkRows cols={4} rows={4} num={[3]} />}
          {q.data?.map((it) => {
            const m = poolOf(it.pool);
            const tok = (addr: string) => (m ? (same(m.token0.address, addr) ? m.token0 : m.token1) : undefined);
            let kind: string;
            let details: string;
            if (it.type === "swap") {
              const ti = tok(it.tokenIn);
              const to = tok(it.tokenOut);
              kind = "Swap";
              details = `${ti ? fmtAmount(it.amountIn, ti.decimals) : "?"} ${ti?.symbol ?? ""} → ${to ? fmtAmount(it.amountOut, to.decimals) : "?"} ${to?.symbol ?? ""}`;
            } else {
              kind = LIQ_LABEL[it.kind] ?? it.kind;
              details = m ? `${fmtAmount(it.amount0, m.token0.decimals)} ${m.token0.symbol} + ${fmtAmount(it.amount1, m.token1.decimals)} ${m.token1.symbol}` : "–";
            }
            return (
              <tr key={`${it.txHash}-${it.type === "swap" ? it.logIndex : it.kind}`}>
                <td><span className={`tag ${it.type === "swap" ? "tag-illustration" : it.kind === "remove" || it.kind === "transfer_out" ? "tag-short" : "tag-live"}`}>{kind}</span></td>
                <td>{m ? <Link to="/pools/$pool" params={{ pool: m.address }}>{pairLabel(m)}</Link> : <span className="mono small">{shortAddress(it.pool)}</span>}</td>
                <td className="mono small">{details}</td>
                <td className="num small"><a href={explorerTx(it.txHash)} target="_blank" rel="noreferrer" className="muted" title="View the transaction">{timeAgo(it.timestamp)}</a></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** API keys and webhook endpoints belong to the signed-in wallet. */
function DevSection({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <section className="panel stack">
      <div>
        <h2 className="pf-h">{title}</h2>
        <p className="small muted" style={{ margin: "6px 0 0" }}>{lead}</p>
      </div>
      {children}
    </section>
  );
}
