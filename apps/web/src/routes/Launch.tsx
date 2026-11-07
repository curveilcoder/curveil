import { useMemo, useState } from "react";
import { quoteSym } from "../lib/tokens";
import { QuoteFig } from "../components/QuoteFig";
import { Loading, Sk } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import { Link } from "@tanstack/react-router";
import { ModuleStatus, IndexerNote } from "../components/ModuleStatus";
import { TokenAvatar } from "../components/TokenAvatar";
import { useLaunches, useTemplates, STATE_LABEL, STATE_LABEL_ZH, type Launch as LaunchT, type CurveState } from "../lib/launch";
import { fmtBps, fmtNumber, fmtPrice, timeAgo, fmtQuote } from "../lib/format";
import { IS_TESTNET, QUOTE } from "../lib/config";
import { useT } from "../lib/i18n";

type Filter = "all" | CurveState;
const FILTERS: { id: Filter; label: string; zh: string }[] = [
  { id: "all", label: "All", zh: "全部" },
  { id: "trading", label: "Trading", zh: "交易中" },
  { id: "graduation_ready", label: "Ready", zh: "可毕业" },
  { id: "graduated", label: "Graduated", zh: "已毕业" },
];
const SORTS = [
  { id: "new", label: "Newest", zh: "最新" },
  { id: "active", label: "Last trade", zh: "最近成交" },
  { id: "volume", label: "Volume 24h", zh: "24 小时交易量" },
  { id: "progress", label: "Progress", zh: "进度" },
] as const;

export function Launch() {
  const t = useT();
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
        kicker={t("Launch", "发币")} label={t("Bonding curves", "联合曲线")} title={t("Launches", "代币发行")} art="curve"
        lead={t("Fixed-supply tokens on reviewed templates. Each trades on its own bonding curve until its reserve reaches the threshold, then anyone can graduate it into a DAMM pool whose liquidity is locked in escrow.", "使用经审核模板发行的固定供应量代币。每个代币在自己的联合曲线上交易，直到储备达到门槛，之后任何人都可以让它毕业进入 DAMM 资金池，其流动性锁定在托管合约中。")}
      >
        <div className="hero-actions">
          <Link to="/app/launch/new" className="btn btn-primary">{t("Create a token", "创建代币")} <span aria-hidden="true">→</span></Link>
          <Link to="/docs" search={{ page: "launch" }} className="btn btn-ghost">{t("Read the guide", "阅读指南")}</Link>
        </div>
      </PageHead>

      <div className="stack">
        <ModuleStatus id="launch" />
        <div className="toolbar">
          <label className="search">
            <span className="sr-only">{t("Search launches", "搜索代币发行")}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search by name, symbol or address", "按名称、代号或地址搜索")} />
          </label>
          <div className="seg" role="group" aria-label={t("State", "状态")} style={{ marginTop: 0 }}>
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{t(f.label, f.zh)}</button>
            ))}
          </div>
          <label className="small muted sort-select">
            {t("Sort", "排序")}{" "}
            <select className="token-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{t<string>(s.label, s.zh)}</option>)}
            </select>
          </label>
          <IndexerNote />
        </div>

        {isError && (
          <div className="notice bad" role="alert">
            <span>{t("Launches could not be loaded from the Curveil API. Nothing is shown rather than stale numbers.", "无法从 Curveil API 加载代币发行。为避免显示过时数据，这里暂不显示任何内容。")}</span>
            <button className="btn btn-sm" onClick={() => refetch()}>{t("Retry", "重试")}</button>
          </div>
        )}

        {isLoading && (
          <div className="launch-grid" aria-busy="true">
            <Loading label={t("Loading launches", "正在加载代币发行")} />
            {[0, 1, 2].map((i) => <LaunchCardSkeleton key={i} />)}
          </div>
        )}
        {!isLoading && !isError && launches.length === 0 && (
          <div className="panel">
            <p style={{ margin: 0 }}>{data?.length ? t("No launch matches that filter.", "没有符合筛选条件的发行。") : t("No tokens have launched on this network yet.", "本网络上还没有发行任何代币。")}</p>
            <p className="small muted" style={{ marginBottom: 0 }}>
              <Link to="/app/launch/new">{t("Create the first one", "创建第一个")}</Link>{t(".", "。")}{IS_TESTNET && t(" On testnet you pay with test USDG from the faucet.", "在测试网上，你使用从水龙头领取的测试 USDG 付款。")}
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
  const t = useT();
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
        <span className={`lc-state lc-${STATE_TONE[l.state]}`}>{t(STATE_LABEL[l.state], STATE_LABEL_ZH[l.state])}</span>
      </div>

      <div className="lc-cap">
        <span className="tk-label">{t("Market cap", "市值")}</span>
        <strong><QuoteFig n={l.marketCap} symbol={quote} /></strong>
      </div>

      <div className="lc-prog">
        <div className="lc-prog-row">
          <span>
            {graduated
              ? t("Graduated into a DAMM pool", "已毕业进入 DAMM 资金池")
              : threshold
                ? t(<><span className="mono"><QuoteFig n={l.reserveQuote} symbol={quote} /></span> of <span className="mono"><QuoteFig n={threshold} symbol={quote} /></span> raised</>, <>已募集 <span className="mono"><QuoteFig n={l.reserveQuote} symbol={quote} /></span> / <span className="mono"><QuoteFig n={threshold} symbol={quote} /></span></>)
                : t("Bonding curve", "联合曲线")}
          </span>
          <span className="mono lc-pct">{graduated ? "100%" : `${pct.toFixed(pct < 1 ? 2 : pct < 10 ? 1 : 0)}%`}</span>
        </div>
        <div className="lc-bar"><div style={{ width: `${pct}%` }} data-done={graduated ? "true" : undefined} /></div>
      </div>

      <dl className="lc-stats">
        <div><dt>{t("Price", "价格")}</dt><dd className="mono">{fmtPrice(l.price)}</dd></div>
        <div><dt>{t("Vol 24h", "24 小时交易量")}</dt><dd className="mono">{fmtQuote(l.volume24hQuote, quote).text}</dd></div>
        <div><dt>{t("Trades", "成交笔数")}</dt><dd className="mono">{l.trades.toLocaleString("en-US")}</dd></div>
      </dl>
    </Link>
  );
}

/** A launch card while the list loads: the labels stay, the values are skeletons. */
export function LaunchCardSkeleton() {
  const t = useT();
  return (
    <div className="lc" aria-hidden="true">
      <div className="lc-top">
        <Sk w={52} h={52} style={{ borderRadius: "50%" }} />
        <div className="lc-id"><Sk w="11ch" /><Sk w="7ch" /></div>
        <Sk w="7ch" h={20} />
      </div>
      <div className="lc-cap"><span className="tk-label">{t("Market cap", "市值")}</span><strong><Sk w="6ch" /></strong></div>
      <div className="lc-prog"><Sk w="14ch" /><Sk block w="100%" h={8} style={{ borderRadius: 999 }} /></div>
      <dl className="lc-stats">
        {t(["Price", "Vol 24h", "Trades"], ["价格", "24 小时交易量", "成交笔数"]).map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="5ch" /></dd></div>)}
      </dl>
    </div>
  );
}

export function Progress({ bps, graduated }: { bps: number; graduated?: boolean }) {
  const t = useT();
  return (
    <div className="progress-wrap">
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bps / 100)} aria-label={t("Graduation progress", "毕业进度")}>
        <div style={{ width: `${Math.min(100, bps / 100)}%` }} data-done={bps >= 10_000 || graduated ? "true" : undefined} />
      </div>
      <span className="small mono">{graduated ? t("Graduated", "已毕业") : fmtBps(bps)}</span>
    </div>
  );
}
