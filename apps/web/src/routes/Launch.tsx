import { useMemo, useState } from "react";
import { quoteSym } from "../lib/tokens";
import { QuoteFig } from "../components/QuoteFig";
import { Loading, Sk } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import { Link } from "@tanstack/react-router";
import { ModuleStatus, IndexerNote } from "../components/ModuleStatus";
import { TokenAvatar } from "../components/TokenAvatar";
import { useLaunches, useTemplates, STATE_LABEL, type Launch as LaunchT, type CurveState } from "../lib/launch";
import { fmtBps, fmtNumber, fmtPrice, timeAgo, fmtQuote } from "../lib/format";
import { IS_TESTNET, QUOTE } from "../lib/config";

type Filter = "all" | CurveState;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "trading", label: "Trading" },
  { id: "graduation_ready", label: "Ready" },
  { id: "graduated", label: "Graduated" },
];
const SORTS = [
  { id: "new", label: "Newest" },
  { id: "active", label: "Last trade" },
  { id: "volume", label: "Volume 24h" },
  { id: "progress", label: "Progress" },
] as const;

export function Launch() {
  const [sort, setSort] = useState<(typeof SORTS)[number]["id"]>("new");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const { data, isLoading, isError, refetch } = useLaunches(sort);
  const launches = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data ?? []).filter(
      (l) =>
        (filter === "all" || l.state === filter || (filter === "trading" && l.state === "created")) &&
        (!term || l.name.toLowerCase().includes(term) || l.symbol.toLowerCase().includes(term) || l.token.toLowerCase() === term),
    );
  }, [data, filter, q]);

  return (
    <div className="wrap">
      <PageHead
        kicker="Launch" label="Bonding curves" title="Launches" art="curve"
        lead="Fixed-supply tokens on reviewed templates. Each trades on its own bonding curve until its reserve reaches the threshold, then anyone can graduate it into a DAMM pool whose liquidity is locked in escrow."
      >
        <div className="hero-actions">
          <Link to="/app/launch/new" className="btn btn-primary">Create a token <span aria-hidden="true">→</span></Link>
          <Link to="/docs" search={{ page: "launch" }} className="btn btn-ghost">Read the guide</Link>
        </div>
      </PageHead>

      <div className="stack">
        <ModuleStatus id="launch" />
        <div className="toolbar">
          <label className="search">
            <span className="sr-only">Search launches</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, symbol or address" />
          </label>
          <div className="seg" role="group" aria-label="State" style={{ marginTop: 0 }}>
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          <label className="small muted sort-select">
            Sort{" "}
            <select className="token-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <IndexerNote />
        </div>

        {isError && (
          <div className="notice bad" role="alert">
            <span>Launches could not be loaded from the Curveil API. Nothing is shown rather than stale numbers.</span>
            <button className="btn btn-sm" onClick={() => refetch()}>Retry</button>
          </div>
        )}

        {isLoading && (
          <div className="launch-grid" aria-busy="true">
            <Loading label="Loading launches" />
            {[0, 1, 2].map((i) => <LaunchCardSkeleton key={i} />)}
          </div>
        )}
        {!isLoading && !isError && launches.length === 0 && (
          <div className="panel">
            <p style={{ margin: 0 }}>{data?.length ? "No launch matches that filter." : "No tokens have launched on this network yet."}</p>
            <p className="small muted" style={{ marginBottom: 0 }}>
              <Link to="/app/launch/new">Create the first one</Link>.{IS_TESTNET && " On testnet you pay with test USDG from the faucet."}
            </p>
          </div>
        )}
        <div className="launch-grid">
          {launches.map((l) => <LaunchCard key={l.token} l={l} />)}
        </div>
      </div>
    </div>
  );
}

const STATE_TONE: Record<CurveState, string> = { created: "new", trading: "trading", graduation_ready: "ready", graduated: "done" };

export function LaunchCard({ l }: { l: LaunchT }) {
  const quote = quoteSym(l.quote ?? QUOTE);
  const templates = useTemplates();
  const threshold = templates.data?.templates.find((t) => t.id === l.templateId)?.graduationThresholdQuote;
  const graduated = l.state === "graduated";
  const pct = graduated ? 100 : Math.min(100, l.progressBps / 100);
  return (
    <Link to="/app/launch/$token" params={{ token: l.token }} className="lc" style={{ "--lc-hue": parseInt(l.token.slice(2, 8), 16) % 360 } as React.CSSProperties}>
      <div className="lc-top">
        <TokenAvatar token={l.token} symbol={l.symbol} image={l.image} size={52} />
        <div className="lc-id">
          <strong className="lc-name">{l.name}</strong>
          <span className="lc-sub"><span className="mono">{l.symbol}</span><span>{timeAgo(l.createdAt)}</span></span>
        </div>
        <span className={`lc-state lc-${STATE_TONE[l.state]}`}>{STATE_LABEL[l.state]}</span>
      </div>

      <div className="lc-cap">
        <span className="tk-label">Market cap</span>
        <strong><QuoteFig n={l.marketCap} symbol={quote} /></strong>
      </div>

      <div className="lc-prog">
        <div className="lc-prog-row">
          <span>
            {graduated
              ? "Graduated into a DAMM pool"
              : threshold
                ? <><span className="mono"><QuoteFig n={l.reserveQuote} symbol={quote} /></span> of <span className="mono"><QuoteFig n={threshold} symbol={quote} /></span> raised</>
                : "Bonding curve"}
          </span>
          <span className="mono lc-pct">{graduated ? "100%" : `${pct.toFixed(pct < 1 ? 2 : pct < 10 ? 1 : 0)}%`}</span>
        </div>
        <div className="lc-bar"><div style={{ width: `${pct}%` }} data-done={graduated ? "true" : undefined} /></div>
      </div>

      <dl className="lc-stats">
        <div><dt>Price</dt><dd className="mono">{fmtPrice(l.price)}</dd></div>
        <div><dt>Vol 24h</dt><dd className="mono">{fmtQuote(l.volume24hQuote, quote).text}</dd></div>
        <div><dt>Trades</dt><dd className="mono">{l.trades.toLocaleString("en-US")}</dd></div>
      </dl>
    </Link>
  );
}

/** A launch card while the list loads: the labels stay, the values are skeletons. */
export function LaunchCardSkeleton() {
  return (
    <div className="lc" aria-hidden="true">
      <div className="lc-top">
        <Sk w={52} h={52} style={{ borderRadius: "50%" }} />
        <div className="lc-id"><Sk w="11ch" /><Sk w="7ch" /></div>
        <Sk w="7ch" h={20} />
      </div>
      <div className="lc-cap"><span className="tk-label">Market cap</span><strong><Sk w="6ch" /></strong></div>
      <div className="lc-prog"><Sk w="14ch" /><Sk block w="100%" h={8} style={{ borderRadius: 999 }} /></div>
      <dl className="lc-stats">
        {["Price", "Vol 24h", "Trades"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="5ch" /></dd></div>)}
      </dl>
    </div>
  );
}

export function Progress({ bps, graduated }: { bps: number; graduated?: boolean }) {
  return (
    <div className="progress-wrap">
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bps / 100)} aria-label="Graduation progress">
        <div style={{ width: `${Math.min(100, bps / 100)}%` }} data-done={bps >= 10_000 || graduated ? "true" : undefined} />
      </div>
      <span className="small mono">{graduated ? "Graduated" : fmtBps(bps)}</span>
    </div>
  );
}
