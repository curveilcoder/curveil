import { useMemo, useState } from "react";
import { SkRows } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import { Link, useNavigate } from "@tanstack/react-router";
import { ModuleStatus, IndexerNote } from "../components/ModuleStatus";
import { TokenPair } from "../components/TokenPair";
import { useMarkets, pairLabel, kindLabel, type MarketPool } from "../lib/markets";
import { fmtBps, fmtNumber, fmtPrice, timeAgo } from "../lib/format";
import { QUOTE } from "../lib/config";

type Kind = "all" | "damm" | "dlmm";

export function Pools() {
  const { data, isLoading, isError, refetch } = useMarkets();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const pools = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data ?? []).filter(
      (p) =>
        (kind === "all" || p.kind === kind) &&
        (!term || pairLabel(p).toLowerCase().includes(term) || p.address.toLowerCase().includes(term) || p.token0.address.toLowerCase() === term || p.token1.address.toLowerCase() === term),
    );
  }, [data, q, kind]);
  const quote = QUOTE?.symbol ?? "quote";

  return (
    <div className="wrap">
      <PageHead
        kicker="Explore" label="Every pool" title="Pools" art="bins"
        lead="Every public DAMM pool and DLMM pair created by the Curveil factories. Open a pool to see its price, volume, liquidity and trades, and to add liquidity to it."
      >
        <div className="hero-actions">
          <Link to="/app/pools/new" className="btn btn-primary">Create pool</Link>
        </div>
      </PageHead>
      <div className="stack">
        <ModuleStatus id="markets" />
        <div className="toolbar">
          <label className="search">
            <span className="sr-only">Search pools</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by symbol or address" />
          </label>
          <div className="seg" role="group" aria-label="Pool type" style={{ marginTop: 0 }}>
            {(["all", "damm", "dlmm"] as Kind[]).map((k) => (
              <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {k === "all" ? "All" : k.toUpperCase()}
              </button>
            ))}
          </div>
          <IndexerNote />
        </div>

        {isError && (
          <div className="notice bad" role="alert">
            <span>Pools could not be loaded from the Curveil API. Nothing is shown rather than stale numbers.</span>
            <button className="btn btn-sm" onClick={() => refetch()}>Retry</button>
          </div>
        )}

        <div className="table-scroll" tabIndex={0}>
          <table className="data markets-table">
            <thead>
              <tr>
                <th>Pool</th>
                <th>Type</th>
                <th className="num">Price</th>
                <th className="num">Liquidity ({quote})</th>
                <th className="num">Volume 24h</th>
                <th className="num">Fees 24h</th>
                <th className="num">Fee now</th>
                <th>Last trade</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <SkRows cols={8} rows={4} num={[2, 3, 4, 5, 6]} />}
              {!isLoading && pools.length === 0 && !isError && (
                <tr>
                  <td colSpan={8} className="muted">
                    {data?.length ? "No pool matches that search." : "No pools are indexed yet."}{" "}
                    <Link to="/app/pools/new">Create a pool</Link>
                  </td>
                </tr>
              )}
              {pools.map((p) => <PoolRow key={p.address} p={p} />)}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Pools are created permissionlessly from admitted assets. Creation is not an endorsement: check the assets, liquidity and contract before trading. Values in {quote} are shown only for pools that trade against it.
        </p>
      </div>
    </div>
  );
}

export function PoolRow({ p }: { p: MarketPool }) {
  const navigate = useNavigate();
  return (
    <tr
      className="row-link"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        navigate({ to: "/app/pools/$pool", params: { pool: p.address } });
      }}
    >
      <td>
        <Link to="/app/pools/$pool" params={{ pool: p.address }} className="pool-link">
          <TokenPair pool={p} size={24} />
          <span>{pairLabel(p)}</span>
        </Link>
      </td>
      <td><span className={`tag ${p.kind === "dlmm" ? "tag-public" : "tag-illustration"}`}>{kindLabel(p)}</span></td>
      <td className="num mono">{fmtPrice(p.price)} <span className="muted small">{p.token1.symbol}</span></td>
      <td className="num mono">{fmtNumber(p.tvlQuote, 0)}</td>
      <td className="num mono">{fmtNumber(p.volume24hQuote, 0)}</td>
      <td className="num mono">{fmtNumber(p.fees24hQuote, 2)}</td>
      <td className="num mono">{fmtBps(p.fees.currentBps)}</td>
      <td className="small muted">{timeAgo(p.lastSwapAt)}</td>
    </tr>
  );
}
