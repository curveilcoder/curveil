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
import { useT } from "../lib/i18n";

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
  const tr = useT();
  const { address } = useConnection();
  const { tab, sub } = useSearch({ from: "/app/profile" });
  if (address) return <Navigate to="/app/profile/$address" params={{ address }} search={{ tab, sub }} replace />;
  return (
    <div className="wrap tk">
      <header className="tk-head">
        <div className="tk-id-text">
          <h1 className="pf-title">{tr("Profile", "个人资料")}</h1>
          <p className="tk-meta">{tr("Tokens you launched, your liquidity, pools you created, locks and activity, in one place.", "你发行的代币、流动性、创建的资金池、锁仓和活动，都在这里。")}</p>
        </div>
      </header>
      <div className="panel" style={{ maxWidth: 520, marginBottom: 40 }}>
        <WalletAction verb={tr("see your profile", "查看你的个人资料")}>{null}</WalletAction>
      </div>
      <p className="small muted">{tr(<>The shielded vault needs no wallet. <Link to="/app/vault">Open the vault</Link>.</>, <>隐私金库不需要钱包。<Link to="/app/vault">打开金库</Link>。</>)}</p>
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
  const tr = useT();
  const { address: raw } = useParams({ from: "/app/profile/$address" });
  const { tab: picked, sub: pickedSub } = useSearch({ from: "/app/profile/$address" });
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
        <PageHead kicker={tr("Profile", "个人资料")} label={tr("Profile", "个人资料")} title={tr("Profile not found", "找不到该个人资料")} lead={tr(<><span className="mono">{raw}</span> is not a valid wallet address.</>, <><span className="mono">{raw}</span> 不是有效的钱包地址。</>)} />
        <Link to="/app/profile" className="btn">{tr("Your profile", "你的个人资料")}</Link>
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
  const go = (t: ProfileTab, x?: ProfileSub) => void navigate({ to: "/app/profile/$address", params: { address: raw }, search: x ? { tab: t, sub: x } : { tab: t }, replace: true, resetScroll: false });
  const label: Record<ProfileTab, string> = tr({ launches: "Launches", liquidity: "Liquidity", perps: "Perps", activity: "Activity", vault: "Vault", developer: "Developer" }, { launches: "代币发行", liquidity: "流动性", perps: "永续合约", activity: "活动", vault: "金库", developer: "开发者" });
  const subLabel: Partial<Record<ProfileSub, string>> = tr({ tokens: "Tokens launched", locks: "Locked liquidity", positions: "Positions", pools: "Pools created", keys: "API keys", webhooks: "Webhooks" }, { tokens: "发行的代币", locks: "锁定的流动性", positions: "仓位", pools: "创建的资金池", keys: "API 密钥", webhooks: "Webhook" });
  const count = (n: number | null) => (n === null ? <Sk w="3ch" /> : n.toLocaleString("en-US"));

  return (
    <div className="wrap tk">
      <header className="tk-head">
        <div className="tk-id">
          <AddressAvatar address={a} />
          <div className="tk-id-text">
            <div className="tk-name">
              <h1 className="mono pf-addr">{shortAddress(a)}</h1>
              {own && <span className="tag tag-shielded">{tr("You", "你")}</span>}
            </div>
            <p className="tk-meta">
              <CopyAddress value={a} label={a} />
              <a href={explorerAddress(a)} target="_blank" rel="noreferrer" className="tk-link">{tr("Explorer", "浏览器")} ↗</a>
            </p>
          </div>
        </div>
        {own && (
          <div className="pf-actions">
            <Link to="/app/launch/new" className="btn btn-sm">{tr("Create a token", "创建代币")}</Link>
            <Link to="/app/pools" className="btn btn-sm">{tr("Add liquidity", "添加流动性")}</Link>
          </div>
        )}
      </header>

      <div className="pf-body">
        <dl className="tk-stats pf-stats">
          <div><dt>{tr("Tokens launched", "发行的代币")}</dt><dd>{count(counts.tokens)}</dd></div>
          <div><dt>{tr("Pools created", "创建的资金池")}</dt><dd>{count(counts.pools)}</dd></div>
          <div><dt>{tr("Liquidity positions", "流动性仓位")}</dt><dd>{count(counts.liquidity)}</dd></div>
          <div><dt>{tr("Escrow locks", "托管锁仓")}</dt><dd>{count(counts.locks)}</dd></div>
          {PERPS_DEPLOYED && <div><dt>{tr("Open perps", "持有的永续合约")}</dt><dd>{count(counts.perps)}</dd></div>}
        </dl>

        <p className="pf-note small">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
          {tr("Public activity only. Anything done through the shielded vault is not linked to this address, so it never shows here.", "这里只显示公开活动。通过隐私金库进行的操作不会关联到这个地址，因此永远不会出现在这里。")}
        </p>

        <section className="tk-tabs">
          <div className="tk-tablist" role="tablist" aria-label={tr("Profile", "个人资料")}>
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
            {tab === "developer" && own && sub === "keys" && <DevSection title={tr("API keys", "API 密钥")} lead={tr("Raise the API limit from 300 to 3,000 requests a minute.", "把 API 限额从每分钟 300 次提高到 3,000 次。")}><ApiKeys /></DevSection>}
            {tab === "developer" && own && sub === "webhooks" && <DevSection title="Webhooks" lead={tr("Signed events sent to your server when tokens launch, trade or graduate.", "代币发行、交易或毕业时，向你的服务器发送带签名的事件。")}><WebhookConsole /></DevSection>}
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
  const tr = useT();
  return <p className="notice bad small" role="alert" style={{ margin: 0 }}>{tr(`${what} could not be loaded. Nothing is shown rather than a guess.`, `无法加载${what}。为避免猜测，这里不显示任何内容。`)}</p>;
}

function TokensTab({ q, own }: { q: Q<import("../lib/launch").Launch[]>; own: boolean }) {
  const tr = useT();
  if (q.isError) return <Failed what={tr("Launches", "代币发行")} />;
  if (q.isLoading) {
    return (
      <div className="launch-grid" aria-busy="true">
        <Loading label={tr("Loading launches", "正在加载代币发行")} />
        {[0, 1, 2].map((i) => <LaunchCardSkeleton key={i} />)}
      </div>
    );
  }
  if (!q.data?.length) {
    return (
      <Empty text={own ? tr("You have not launched a token yet.", "你还没有发行过代币。") : tr("This address has not launched a token.", "该地址还没有发行过代币。")}>
        {own && <Link to="/app/launch/new" className="btn btn-primary btn-sm">{tr("Create a token", "创建代币")}</Link>}
      </Empty>
    );
  }
  return <div className="launch-grid">{q.data.map((l) => <LaunchCard key={l.token} l={l} />)}</div>;
}

function LiquidityTab({ q, markets, loading, own, refetch }: { q: Q<import("../lib/markets").Positions>; markets?: MarketPool[]; loading: boolean; own: boolean; refetch: () => unknown }) {
  const tr = useT();
  const pool = (addr: string) => markets?.find((p) => same(p.address, addr));
  if (q.isError) return <Failed what={tr("Positions", "仓位")} />;
  const rows = q.data ? [...q.data.damm.map((p) => ({ kind: "damm" as const, p })), ...q.data.dlmm.map((p) => ({ kind: "dlmm" as const, p }))] : [];
  if (!q.isLoading && !loading && rows.length === 0) {
    return (
      <Empty text={own ? tr("You have no liquidity in Curveil pools.", "你在 Curveil 资金池中没有流动性。") : tr("This address has no liquidity in Curveil pools.", "该地址在 Curveil 资金池中没有流动性。")}>
        {own && <Link to="/app/pools" className="btn btn-primary btn-sm">{tr("Add liquidity", "添加流动性")}</Link>}
      </Empty>
    );
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="small muted" style={{ margin: 0 }}>
        {tr("Amounts and unclaimed fees are read live from the pool contracts.", "数量和未领取手续费都是从资金池合约实时读取的。")}{own && tr(" Liquidity added from the shielded vault is listed under Vault, not here.", "从隐私金库添加的流动性列在“金库”中，不在这里。")}
      </p>
      {own && q.data && markets ? (
        <ManagePositions data={q.data} markets={markets} onDone={() => void refetch()} />
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead>
              <tr><th>{tr("Pool", "资金池")}</th><th>{tr("Type", "类型")}</th><th className="num">{tr("Holdings", "持有量")}</th><th className="num">{tr("Share", "占比")}</th><th className="num">{tr("Unclaimed fees", "未领取手续费")}</th></tr>
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
                    <td><Link to="/app/pools/$pool" params={{ pool: m.address }} className="pool-link"><TokenPair pool={m} size={24} /><span>{pairLabel(m)}</span></Link></td>
                    <td><span className={`tag ${m.kind === "dlmm" ? "tag-public" : "tag-illustration"}`}>{kindLabel(m)}</span></td>
                    <td className="num mono small">{fmtAmount(a0, m.token0.decimals)} {m.token0.symbol}<br />{fmtAmount(a1, m.token1.decimals)} {m.token1.symbol}</td>
                    <td className="num mono small">{kind === "damm" ? `${((p as any).shareOfPool * 100).toFixed(2)}%` : tr(`${(p as any).bins.length} bins`, `${(p as any).bins.length} 个价格档`)}</td>
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
  const tr = useT();
  const quote = QUOTE?.symbol ?? "quote";
  if (q.isError) return <Failed what={tr("Pools", "资金池")} />;
  if (!q.isLoading && !q.data?.length) {
    return (
      <Empty text={own ? tr("You have not created a pool yet.", "你还没有创建过资金池。") : tr("This address has not created a pool.", "该地址还没有创建过资金池。")}>
        <p className="small muted" style={{ margin: 0 }}>{tr("Pools made when a launch graduates belong to the launch, not to whoever finished the curve.", "发行毕业时创建的资金池属于该发行，而不属于买完曲线的人。")}</p>
        {own && <Link to="/app/pools/new" className="btn btn-primary btn-sm">{tr("Create a pool", "创建资金池")}</Link>}
      </Empty>
    );
  }
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data markets-table">
        <thead>
          <tr><th>{tr("Pool", "资金池")}</th><th>{tr("Type", "类型")}</th><th className="num">{tr("Price", "价格")}</th><th className="num">{tr("Liquidity", "流动性")} ({quote})</th><th className="num">{tr("Volume 24h", "24 小时成交量")}</th><th className="num">{tr("Fees 24h", "24 小时手续费")}</th><th className="num">{tr("Fee now", "当前费率")}</th><th>{tr("Last trade", "最近成交")}</th></tr>
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
  const tr = useT();
  if (q.isError) return <Failed what={tr("Locks", "锁仓")} />;
  if (!q.isLoading && open.length === 0) {
    return <Empty text={own ? tr("You hold no escrow locks.", "你没有托管锁仓。") : tr("This address holds no escrow locks.", "该地址没有托管锁仓。")}><p className="small muted" style={{ margin: 0 }}>{tr("A launch's creator receives a lock on part of the LP shares when the token graduates.", "代币毕业时，发行的创作者会获得一部分 LP 份额的锁仓。")}</p></Empty>;
  }
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data">
        <thead><tr><th>{tr("Lock", "锁仓")}</th><th>{tr("Pool", "资金池")}</th><th className="num">{tr("Underlying", "对应资产")}</th><th>{tr("Status", "状态")}</th><th className="num">{tr("Unclaimed fees", "未领取手续费")}</th></tr></thead>
        <tbody>
          {q.isLoading && <SkRows cols={5} rows={2} num={[2, 4]} />}
          {open.map((l) => {
            const t0 = l.pool?.token0;
            const t1 = l.pool?.token1;
            return (
              <tr key={l.id}>
                <td className="mono small">#{l.id}</td>
                <td>{l.launch ? <Link to="/app/launch/$token" params={{ token: l.launch.token }}>{t0 && t1 ? `${t0.symbol} / ${t1.symbol}` : l.launch.symbol}</Link> : <span className="mono small">{shortAddress(l.lpToken)}</span>}</td>
                <td className="num mono small">{t0 && t1 ? <>{fmtAmount(l.underlying0, t0.decimals)} {t0.symbol}<br />{fmtAmount(l.underlying1, t1.decimals)} {t1.symbol}</> : "–"}</td>
                <td className="small">{l.claimed ? tr("LP claimed", "LP 已领取") : l.unlockAt * 1000 <= Date.now() ? <span className="good-text">{tr("Unlocked", "已解锁")}</span> : tr(`Unlocks ${untilLabel(l.unlockAt)}`, `${untilLabel(l.unlockAt)}解锁`)}</td>
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
  const tr = useT();
  const overview = usePerpsOverview();
  if (q.isError) return <Failed what={tr("Perp positions", "永续合约仓位")} />;
  if (q.isLoading) {
    return (
      <div className="grid-2" aria-busy="true">
        <Loading label={tr("Loading positions", "正在加载仓位")} />
        {[0, 1].map((i) => <div key={i} className="panel stack"><Sk w="12ch" /><Sk block w="100%" h={72} /></div>)}
      </div>
    );
  }
  const closed = (q.data?.positions.length ?? 0) - live.length;
  if (live.length === 0) {
    return (
      <Empty text={own ? tr("You have no open perp positions.", "你没有持仓中的永续合约。") : tr("This address has no open perp positions.", "该地址没有持仓中的永续合约。")}>
        {closed > 0 && <p className="small muted" style={{ margin: 0 }}>{tr(`${closed} closed ${closed === 1 ? "position" : "positions"} earlier.`, `之前已平仓 ${closed} 个仓位。`)}</p>}
        {own && <Link to="/app/perps" className="btn btn-primary btn-sm">{tr("Open a position", "开仓")}</Link>}
      </Empty>
    );
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid-2">
        {live.map((p) => <div key={p.id} className="panel stack"><PositionSummary p={p} m={overview.data?.markets.find((m) => m.id === p.market)} /></div>)}
      </div>
      {closed > 0 && <p className="small muted" style={{ margin: 0 }}>{tr(<>Plus {closed} closed {closed === 1 ? "position" : "positions"}.{own && <> Manage on <Link to="/app/perps">Perps</Link>.</>}</>, <>另有 {closed} 个已平仓仓位。{own && <>请在<Link to="/app/perps">永续合约</Link>页面管理。</>}</>)}</p>}
    </div>
  );
}

const LIQ_LABEL: Record<string, string> = { add: "Add", remove: "Remove", claim: "Claim fees", transfer_in: "Received LP", transfer_out: "Sent LP" };
const LIQ_LABEL_ZH: Record<string, string> = { add: "添加", remove: "移除", claim: "领取手续费", transfer_in: "收到 LP", transfer_out: "转出 LP" };

function ActivityTab({ q, markets }: { q: Q<ActivityItem[]>; markets?: MarketPool[] }) {
  const tr = useT();
  const poolOf = (addr: string) => markets?.find((p) => same(p.address, addr));
  if (q.isError) return <Failed what={tr("Activity", "活动")} />;
  if (!q.isLoading && !q.data?.length) return <Empty text={tr("No public swaps or liquidity changes from this address yet.", "该地址还没有公开的兑换或流动性变动。")} />;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data pf-activity">
        <thead><tr><th>{tr("Type", "类型")}</th><th>{tr("Pool", "资金池")}</th><th>{tr("Details", "详情")}</th><th className="num">{tr("Age", "时间")}</th></tr></thead>
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
              kind = tr("Swap", "兑换");
              details = `${ti ? fmtAmount(it.amountIn, ti.decimals) : "?"} ${ti?.symbol ?? ""} → ${to ? fmtAmount(it.amountOut, to.decimals) : "?"} ${to?.symbol ?? ""}`;
            } else {
              kind = tr(LIQ_LABEL[it.kind], LIQ_LABEL_ZH[it.kind]) ?? it.kind;
              details = m ? `${fmtAmount(it.amount0, m.token0.decimals)} ${m.token0.symbol} + ${fmtAmount(it.amount1, m.token1.decimals)} ${m.token1.symbol}` : "–";
            }
            return (
              <tr key={`${it.txHash}-${it.type === "swap" ? it.logIndex : it.kind}`}>
                <td><span className={`tag ${it.type === "swap" ? "tag-illustration" : it.kind === "remove" || it.kind === "transfer_out" ? "tag-short" : "tag-live"}`}>{kind}</span></td>
                <td>{m ? <Link to="/app/pools/$pool" params={{ pool: m.address }}>{pairLabel(m)}</Link> : <span className="mono small">{shortAddress(it.pool)}</span>}</td>
                <td className="mono small">{details}</td>
                <td className="num small"><a href={explorerTx(it.txHash)} target="_blank" rel="noreferrer" className="muted" title={tr("View the transaction", "查看交易")}>{timeAgo(it.timestamp)}</a></td>
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
