import { useMemo, useState } from "react";
import { SkRows } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import { Link, useNavigate } from "@tanstack/react-router";
import { ModuleStatus, IndexerNote } from "../components/ModuleStatus";
import { TokenPair } from "../components/TokenPair";
import { useMarkets, pairLabel, kindLabel, type MarketPool } from "../lib/markets";
import { fmtBps, fmtNumber, fmtPrice, timeAgo } from "../lib/format";
import { QUOTE } from "../lib/config";
import { useT } from "../lib/i18n";

type Kind = "all" | "damm" | "dlmm";

export function Pools() {
  const t = useT();
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
        kicker={t("Explore", "探索")} label={t("Every pool", "全部资金池")} title={t("Pools", "资金池")} art="bins"
        lead={t("Every public DAMM pool and DLMM pair created by the Curveil factories. Open a pool to see its price, volume, liquidity and trades, and to add liquidity to it.", "由 Curveil 工厂合约创建的所有公开 DAMM 资金池和 DLMM 交易对。打开一个资金池可以查看价格、交易量、流动性和成交，并向它添加流动性。")}
      >
        <div className="hero-actions">
          <Link to="/app/pools/new" className="btn btn-primary">{t("Create pool", "创建资金池")}</Link>
        </div>
      </PageHead>
      <div className="stack">
        <ModuleStatus id="markets" />
        <div className="toolbar">
          <label className="search">
            <span className="sr-only">{t("Search pools", "搜索资金池")}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search by symbol or address", "按代号或地址搜索")} />
          </label>
          <div className="seg" role="group" aria-label={t("Pool type", "资金池类型")} style={{ marginTop: 0 }}>
            {(["all", "damm", "dlmm"] as Kind[]).map((k) => (
              <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {k === "all" ? t("All", "全部") : k.toUpperCase()}
              </button>
            ))}
          </div>
          <IndexerNote />
        </div>

        {isError && (
          <div className="notice bad" role="alert">
            <span>{t("Pools could not be loaded from the Curveil API. Nothing is shown rather than stale numbers.", "无法从 Curveil API 加载资金池。为避免显示过时数据，这里暂不显示任何内容。")}</span>
            <button className="btn btn-sm" onClick={() => refetch()}>{t("Retry", "重试")}</button>
          </div>
        )}

        <div className="table-scroll" tabIndex={0}>
          <table className="data markets-table">
            <thead>
              <tr>
                <th>{t("Pool", "资金池")}</th>
                <th>{t("Type", "类型")}</th>
                <th className="num">{t("Price", "价格")}</th>
                <th className="num">{t("Liquidity", "流动性")} ({quote})</th>
                <th className="num">{t("Volume 24h", "24 小时交易量")}</th>
                <th className="num">{t("Fees 24h", "24 小时手续费")}</th>
                <th className="num">{t("Fee now", "当前费率")}</th>
                <th>{t("Last trade", "最近成交")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <SkRows cols={8} rows={4} num={[2, 3, 4, 5, 6]} />}
              {!isLoading && pools.length === 0 && !isError && (
                <tr>
                  <td colSpan={8} className="muted">
                    {data?.length ? t("No pool matches that search.", "没有匹配的资金池。") : t("No pools are indexed yet.", "还没有已索引的资金池。")}{" "}
                    <Link to="/app/pools/new">{t("Create a pool", "创建资金池")}</Link>
                  </td>
                </tr>
              )}
              {pools.map((p) => <PoolRow key={p.address} p={p} />)}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {t(
            `Pools are created permissionlessly from admitted assets. Creation is not an endorsement: check the assets, liquidity and contract before trading. Values in ${quote} are shown only for pools that trade against it.`,
            `资金池可由任何人用准入资产无需许可地创建。创建并不代表认可：交易前请核对资产、流动性和合约。以 ${quote} 计价的数值只对与它交易的资金池显示。`,
          )}
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
