import { useMemo, useState, type ReactNode } from "react";
import { Loading, Sk } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { ModuleStatus } from "../components/ModuleStatus";
import { TokenDisc, TokenPair } from "../components/TokenPair";
import { BinChart } from "../components/BinChart";
import { TxStatus } from "../components/TxStatus";
import { WalletAction, AmountField } from "../components/WalletAction";
import { useMarkets, pairLabel, kindLabel, binPrice, type MarketPool, type Positions } from "../lib/markets";
import { useWalletTokens, deadlineIn, same, NATIVE, WETH, wethAbi } from "../lib/tokens";
import { STRATEGIES, distribution, allocate, type Strategy } from "../lib/shapes";
import { routerAbi, erc20Abi, dammPoolAbi, dlmmPairAbi } from "../lib/abis";
import { ROUTER, curveilChain } from "../lib/config";
import { fmtAmount, fmtNumber, fmtPrice, parseAmount, withSlippage } from "../lib/format";
import { useTxRunner, type TxStep } from "../lib/tx";
import { CreatePool } from "./CreatePool";
import { justCreated } from "../lib/launch";
import { FundingRow, SyncNote, VaultGate, useShieldedVault } from "../components/Funding";
import { ShieldedEntry, marketAssets } from "../components/ShieldedEntry";
import { SHIELDED_EXECUTION, useFunding } from "../lib/funding";
import { balances, type VaultState } from "../lib/vault/store";
import { encodeDammEntry, encodeDlmmEntry } from "@curveil/vault-core";
import { useT, tNow } from "../lib/i18n";

const DEADLINE_MIN = 10;
const SLIPPAGE_BPS = 50;
const MAX_BINS = 100;

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Add liquidity to one pool. Reached only from that pool's page, so the pool is already chosen. */
export function AddLiquidity() {
  const t = useT();
  const { pool: address } = useParams({ from: "/app/pools/$pool/add" });
  const markets = useMarkets();
  const shielded = useFunding() === "shielded" && SHIELDED_EXECUTION;
  const vault = useShieldedVault(shielded);
  const pool = markets.data?.find((p) => p.address.toLowerCase() === address.toLowerCase());
  return (
    <div className="wrap tk">
      <Link to={pool ? "/app/pools/$pool" : "/app/pools"} params={{ pool: address }} className="tk-back">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {pool ? pairLabel(pool) : t("Pools", "资金池")}
      </Link>
      <header className="tk-head">
        <div className="tk-id">
          {pool ? <TokenPair pool={pool} size={44} /> : <Sk w={72} h={44} style={{ borderRadius: 22 }} />}
          <div className="tk-id-text">
            <div className="tk-name"><h1>{t("Add liquidity", "添加流动性")}</h1></div>
            <p className="tk-meta">{pool ? <><span>{pairLabel(pool)}</span><span>{kindLabel(pool)}</span><span>{t("Fee now", "当前费率")} {(pool.fees.currentBps / 100).toFixed(2)}%</span></> : <Sk w="24ch" />}</p>
          </div>
        </div>
      </header>
      <div className="stack">
        <ModuleStatus id="liquidity" />
        {SHIELDED_EXECUTION && <FundingRow what={t("Deposits and exits are public; who owns the position is not.", "存入和退出是公开的，但谁持有该仓位不公开。")} />}
        {shielded && <SyncNote v={vault} />}
        {markets.isLoading ? <AddSkeleton shielded={shielded} /> : !pool && justCreated(address) ? (
          <>
            <p className="notice" role="status">{t("Your pool is created. Curveil is indexing it now, which takes up to a minute. This page fills in by itself.", "资金池已创建。Curveil 正在为它建立索引，最多需要一分钟，本页会自动更新。")}</p>
            <AddSkeleton shielded={shielded} />
          </>
        ) : !pool ? (
          <p className="notice bad" role="alert">{t(<>No Curveil pool is indexed at <span className="mono">{address}</span>. <Link to="/app/pools">Back to Pools</Link></>, <>在 <span className="mono">{address}</span> 没有已索引的 Curveil 资金池。<Link to="/app/pools">返回资金池</Link></>)}</p>
        ) : (
          <AddForm pool={pool} vault={shielded ? vault : null} />
        )}
      </div>
    </div>
  );
}

/** Create a new DAMM pool or DLMM pair. */
export function CreatePoolPage() {
  const t = useT();
  return (
    <div className="wrap tk">
      <Link to="/app/pools" className="tk-back">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {t("Pools", "资金池")}
      </Link>
      <PageHead
        kicker={t("Explore", "探索")} label={t("New pool", "新资金池")} title={t("Create a pool", "创建资金池")} art="shapes"
        lead={t("Open a public DAMM pool (full range, fees that rise with volatility) or a DLMM pair (liquidity placed in price bins) for two admitted assets. You can add the first liquidity right after.", "为两种已准入的资产开设公开的 DAMM 资金池（全价格区间，费率随波动上升）或 DLMM 交易对（流动性分布在各个价格档中）。创建后可以立刻添加第一笔流动性。")}
      />
      <div className="stack">
        <ModuleStatus id="liquidity" />
        <CreatePool />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ positions

/** Your public positions with remove and claim, shown on your own profile. */
export function ManagePositions({ data, markets, onDone }: { data: Positions; markets: MarketPool[]; onDone: () => void }) {
  const byAddr = (a: string) => markets.find((p) => p.address.toLowerCase() === a.toLowerCase());
  return (
    <div className="grid-2">
      {data.damm.map((p) => {
        const pool = byAddr(p.pool);
        return pool ? <DammPosition key={p.pool} pool={pool} pos={p} onDone={onDone} /> : null;
      })}
      {data.dlmm.map((p) => {
        const pool = byAddr(p.pool);
        return pool ? <DlmmPosition key={p.pool} pool={pool} pos={p} onDone={onDone} /> : null;
      })}
    </div>
  );
}

/** Pool head while it loads: two token circles and a pair name. */
function SkPoolHead() {
  return (
    <div className="pool-link" aria-hidden="true">
      <span style={{ display: "inline-flex" }}><Sk w={28} h={28} style={{ borderRadius: "50%" }} /><Sk w={28} h={28} style={{ borderRadius: "50%", marginLeft: -8 }} /></span>
      <Sk w="10ch" />
    </div>
  );
}

function AddSkeleton({ shielded }: { shielded: boolean }) {
  const t = useT();
  return (
    <div className="add-layout" aria-busy="true">
      <Loading label={t("Loading pools", "正在加载资金池")} />
      <div className={`panel stack${shielded ? " shielded-panel" : ""}`}>
        <div className="field"><span className="small muted">{t("Pool", "资金池")}</span><Sk block w="100%" h={44} /></div>
        <Sk block w="100%" h={64} />
        <Sk block w="100%" h={64} />
        <Sk block w="100%" h={48} />
      </div>
      <div className="panel stack">
        <SkPoolHead />
        <dl className="rows">
          {t(["Price", "Fee now", "Fees to LPs", "Fees 24h"], ["价格", "当前费率", "LP 分成", "24 小时手续费"]).map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="9ch" /></dd></div>)}
        </dl>
      </div>
    </div>
  );
}

function PositionHead({ pool }: { pool: MarketPool }) {
  return (
    <div className="row-between">
      <Link to="/app/pools/$pool" params={{ pool: pool.address }} className="pool-link">
        <TokenPair pool={pool} size={28} />
        <strong>{pairLabel(pool)}</strong>
      </Link>
      <span className="tag tag-public">{kindLabel(pool)}</span>
    </div>
  );
}

/**
 * One layout for every position card, DAMM or DLMM, so cards side by side line up:
 * head, value, a fixed-height picture, four rows, fees with Claim, and the remove controls at the bottom.
 */
function PositionCard(props: {
  pool: MarketPool;
  inRange: boolean | null;
  value: number;
  visual: ReactNode;
  rows: [string, ReactNode][];
  fees: ReactNode;
  canClaim: boolean;
  onClaim: () => void;
  pct: number;
  setPct: (n: number) => void;
  canRemove: boolean;
  onRemove: () => void;
  note: string;
  tx: ReturnType<typeof useTxRunner>;
}) {
  const t = useT();
  const { pool, tx } = props;
  // Value is passed in token1. When token0 is the dollar token, show it in dollars instead.
  const usd0 = /usd/i.test(pool.token0.symbol) && !/usd/i.test(pool.token1.symbol) && (pool.price ?? 0) > 0;
  const shown = usd0 ? { value: props.value / pool.price!, symbol: pool.token0.symbol } : { value: props.value, symbol: pool.token1.symbol };
  return (
    <article className="panel lpc">
      <header className="lpc-head">
        <Link to="/app/pools/$pool" params={{ pool: pool.address }} className="pool-link lpc-pair">
          <TokenPair pool={pool} size={32} />
          <span className="lpc-name">
            <strong>{pairLabel(pool)}</strong>
            <span className="lpc-sub">{kindLabel(pool)} · {t(`${(pool.fees.currentBps / 100).toFixed(2)}% fee`, `费率 ${(pool.fees.currentBps / 100).toFixed(2)}%`)}</span>
          </span>
        </Link>
        {props.inRange === null ? (
          <span className="tag tag-live">{t("Full range", "全区间")}</span>
        ) : (
          <span className={`tag ${props.inRange ? "tag-live" : "tag-warn"}`}>{props.inRange ? t("In range", "在区间内") : t("Out of range", "超出区间")}</span>
        )}
      </header>
      <div className="lpc-value">
        <span className="lpc-label">{t("Position value", "仓位价值")}</span>
        <strong>≈ {fmtNumber(shown.value, 2)} <span>{shown.symbol}</span></strong>
      </div>
      <div className="lpc-visual">{props.visual}</div>
      <dl className="rows lpc-rows">
        {props.rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <div className="lpc-fees">
        <div>
          <span className="lpc-label">{t("Unclaimed fees", "未领取手续费")}</span>
          <span className="mono">{props.fees}</span>
        </div>
        <button type="button" className="btn btn-sm" disabled={!props.canClaim || tx.busy} onClick={props.onClaim}>{t("Claim", "领取")}</button>
      </div>
      <div className="lpc-foot">
        <WalletAction verb={t("manage this position", "管理该仓位")}>
          <span className="lpc-label">{t("Remove liquidity", "移除流动性")}</span>
          <div className="lpc-remove">
            <PercentPicker value={props.pct} onChange={props.setPct} label={t("Share of the position to remove", "要移除的仓位比例")} />
            <button type="button" className="btn btn-sm" disabled={!props.canRemove || tx.busy} onClick={props.onRemove}>{t(`Remove ${props.pct}%`, `移除 ${props.pct}%`)}</button>
          </div>
          <p className="small muted lpc-note">{props.note}</p>
        </WalletAction>
      </div>
      <TxStatus phase={tx.phase} />
    </article>
  );
}

/** Full-range picture for a DAMM position: how its value splits between the two tokens. */
function Composition({ pool, v0, v1 }: { pool: MarketPool; v0: number; v1: number }) {
  const t = useT();
  const total = v0 + v1;
  const p0 = total > 0 ? (v0 / total) * 100 : 50;
  return (
    <div className="lpc-comp">
      <div className="lpc-comp-top">
        <span>{t("Composition by value", "按价值构成")}</span>
        <span>{t("Earns at every price", "在任何价格都能赚取手续费")}</span>
      </div>
      <div className="lpc-split" role="img" aria-label={`${pool.token0.symbol} ${p0.toFixed(1)}%, ${pool.token1.symbol} ${(100 - p0).toFixed(1)}%`}>
        <i style={{ width: `${p0}%` }} />
        <i />
      </div>
      <div className="lpc-comp-legend">
        <span><span className="swatch" style={{ background: "var(--chart)" }} /> {pool.token0.symbol} <b>{p0.toFixed(1)}%</b></span>
        <span><b>{(100 - p0).toFixed(1)}%</b> {pool.token1.symbol} <span className="swatch" style={{ background: "var(--ink)" }} /></span>
      </div>
    </div>
  );
}

function PercentPicker({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label} style={{ marginTop: 0 }}>
      {[25, 50, 75, 100].map((n) => (
        <button key={n} type="button" aria-pressed={value === n} onClick={() => onChange(n)}>{n}%</button>
      ))}
    </div>
  );
}

function DammPosition({ pool, pos, onDone }: { pool: MarketPool; pos: Positions["damm"][number]; onDone: () => void }) {
  const t = useT();
  const { address } = useConnection();
  const tx = useTxRunner();
  const [pct, setPct] = useState(100);
  const allowance = useReadContract({ address: pool.address, abi: dammPoolAbi, functionName: "allowance", args: address && ROUTER ? [address, ROUTER] : undefined, query: { enabled: Boolean(address && ROUTER) } });
  const lp = BigInt(pos.lpBalance);
  const liq = (lp * BigInt(pct)) / 100n;
  const out0 = (BigInt(pos.amount0) * BigInt(pct)) / 100n;
  const out1 = (BigInt(pos.amount1) * BigInt(pct)) / 100n;
  const hasFees = BigInt(pos.pendingFees0) > 0n || BigInt(pos.pendingFees1) > 0n;

  async function claim() {
    if (!address) return;
    if (await tx.run([{ label: t("Claim fees", "领取手续费"), params: { address: pool.address, abi: dammPoolAbi, functionName: "claimFees", args: [address], chainId: curveilChain.id } }])) onDone();
  }
  async function remove() {
    if (!address || !ROUTER || liq === 0n) return;
    const steps: TxStep[] = [];
    if ((allowance.data ?? 0n) < liq) steps.push({ label: t("Approve LP shares for the router", "授权路由器使用 LP 份额"), params: { address: pool.address, abi: dammPoolAbi, functionName: "approve", args: [ROUTER, liq], chainId: curveilChain.id } });
    steps.push({
      label: t(`Remove ${pct}% of liquidity`, `移除 ${pct}% 的流动性`),
      params: { address: ROUTER, abi: routerAbi, functionName: "removeLiquidityDamm", args: [pool.token0.address, pool.token1.address, liq, withSlippage(out0, SLIPPAGE_BPS), withSlippage(out1, SLIPPAGE_BPS), address, deadlineIn(DEADLINE_MIN)], chainId: curveilChain.id },
    });
    const ok = await tx.run(steps);
    await allowance.refetch();
    if (ok) onDone();
  }

  const v0 = Number(formatUnits(BigInt(pos.amount0), pool.token0.decimals)) * (pool.price ?? 0);
  const v1 = Number(formatUnits(BigInt(pos.amount1), pool.token1.decimals));
  return (
    <PositionCard
      pool={pool}
      inRange={null}
      value={v0 + v1}
      visual={<Composition pool={pool} v0={v0} v1={v1} />}
      rows={[
        [pool.token0.symbol, <span className="mono">{fmtAmount(pos.amount0, pool.token0.decimals)}</span>],
        [pool.token1.symbol, <span className="mono">{fmtAmount(pos.amount1, pool.token1.decimals, 2)}</span>],
        [t("Price range", "价格区间"), t("Full range", "全区间")],
        [t("Share of pool", "资金池占比"), <span className="mono">{fmtNumber(pos.shareOfPool * 100, 4)}%</span>],
      ]}
      fees={<>{fmtAmount(pos.pendingFees0, pool.token0.decimals, 6)} {pool.token0.symbol} + {fmtAmount(pos.pendingFees1, pool.token1.decimals, 4)} {pool.token1.symbol}</>}
      canClaim={hasFees}
      onClaim={claim}
      pct={pct}
      setPct={setPct}
      canRemove={liq > 0n}
      onRemove={remove}
      note={t(`Returns about ${fmtAmount(out0, pool.token0.decimals)} ${pool.token0.symbol} and ${fmtAmount(out1, pool.token1.decimals, 2)} ${pool.token1.symbol}, at most ${SLIPPAGE_BPS / 100}% less if the pool moves. Fees stay claimable.`, `约返还 ${fmtAmount(out0, pool.token0.decimals)} ${pool.token0.symbol} 和 ${fmtAmount(out1, pool.token1.decimals, 2)} ${pool.token1.symbol}，若资金池变动最多少 ${SLIPPAGE_BPS / 100}%。手续费仍可领取。`)}
      tx={tx}
    />
  );
}

function DlmmPosition({ pool, pos, onDone }: { pool: MarketPool; pos: Positions["dlmm"][number]; onDone: () => void }) {
  const t = useT();
  const { address } = useConnection();
  const tx = useTxRunner();
  const [pct, setPct] = useState(100);
  const price = (id: number) => binPrice(id, pool.binStep!, pool.token0.decimals, pool.token1.decimals);
  const bins = [...pos.bins].sort((a, b) => a.id - b.id);
  const hasFees = BigInt(pos.pendingFeesX) > 0n || BigInt(pos.pendingFeesY) > 0n;
  const lo = bins[0]?.id;
  const hi = bins[bins.length - 1]?.id;
  const inRange = pool.activeId !== null && lo !== undefined && hi !== undefined && pool.activeId >= lo && pool.activeId <= hi;
  const bars = bins.map((b) => ({ id: b.id, x: Number(formatUnits(BigInt(b.amountX), pool.token0.decimals)) * price(b.id), y: Number(formatUnits(BigInt(b.amountY), pool.token1.decimals)) }));

  async function claim() {
    if (!address) return;
    const steps: TxStep[] = chunk(pos.allBins, MAX_BINS).map((ids, i, all) => ({
      label: all.length > 1 ? t(`Claim fees, part ${i + 1}`, `领取手续费，第 ${i + 1} 部分`) : t("Claim fees", "领取手续费"),
      params: { address: pool.address, abi: dlmmPairAbi, functionName: "claimFees", args: [address, ids], chainId: curveilChain.id },
    }));
    if (await tx.run(steps)) onDone();
  }
  async function remove() {
    if (!address) return;
    const parts = bins
      .map((b) => ({ id: b.id, shares: (BigInt(b.shares) * BigInt(pct)) / 100n, x: (BigInt(b.amountX) * BigInt(pct)) / 100n, y: (BigInt(b.amountY) * BigInt(pct)) / 100n }))
      .filter((b) => b.shares > 0n);
    const steps: TxStep[] = chunk(parts, MAX_BINS).map((c, i, all) => ({
      label: all.length > 1 ? t(`Remove ${pct}%, part ${i + 1}`, `移除 ${pct}%，第 ${i + 1} 部分`) : t(`Remove ${pct}% of liquidity`, `移除 ${pct}% 的流动性`),
      params: {
        address: pool.address,
        abi: dlmmPairAbi,
        functionName: "removeLiquidity",
        args: [
          address,
          c.map((b) => b.id),
          c.map((b) => b.shares),
          withSlippage(c.reduce((s, b) => s + b.x, 0n), SLIPPAGE_BPS),
          withSlippage(c.reduce((s, b) => s + b.y, 0n), SLIPPAGE_BPS),
          deadlineIn(DEADLINE_MIN),
        ],
        chainId: curveilChain.id,
      },
    }));
    if (steps.length && (await tx.run(steps))) onDone();
  }

  const value = bars.reduce((sum, b) => sum + b.x + b.y, 0);
  return (
    <PositionCard
      pool={pool}
      inRange={inRange}
      value={value}
      visual={<BinChart bins={bars} activeId={pool.activeId} height={88} label={t(`Your liquidity across ${bins.length} bins`, `你在 ${bins.length} 个价格档中的流动性`)} symbols={[pool.token0.symbol, pool.token1.symbol]} />}
      rows={[
        [pool.token0.symbol, <span className="mono">{fmtAmount(pos.amountX, pool.token0.decimals)}</span>],
        [pool.token1.symbol, <span className="mono">{fmtAmount(pos.amountY, pool.token1.decimals, 2)}</span>],
        [t("Price range", "价格区间"), <span className="mono">{lo !== undefined && hi !== undefined ? `${fmtPrice(price(lo))} – ${fmtPrice(price(hi))}` : "–"}</span>],
        [t("Bins", "价格档"), t(<>{bins.length} bins{inRange ? ", active bin inside" : <span className="warn-text">, not earning</span>}</>, <>{bins.length} 个价格档{inRange ? "，包含当前价格档" : <span className="warn-text">，未在赚取手续费</span>}</>)],
      ]}
      fees={<>{fmtAmount(pos.pendingFeesX, pool.token0.decimals, 6)} {pool.token0.symbol} + {fmtAmount(pos.pendingFeesY, pool.token1.decimals, 4)} {pool.token1.symbol}</>}
      canClaim={hasFees}
      onClaim={claim}
      pct={pct}
      setPct={setPct}
      canRemove={bins.length > 0}
      onRemove={remove}
      note={t(`Removes ${pct}% of your shares in every bin, straight from the pair. Fees stay claimable.`, `直接从交易对中移除你在每个价格档里 ${pct}% 的份额。手续费仍可领取。`)}
      tx={tx}
    />
  );
}

// ------------------------------------------------------------------ add

function AddForm({ pool, vault }: { pool: MarketPool; vault: VaultState | null }) {
  const t = useT();
  const hasWeth = !vault && Boolean(WETH) && (same(pool.token0.address, WETH) || same(pool.token1.address, WETH));
  const [eth, setEth] = useState(true);
  // Shielded entries need both tokens to be vault assets.
  if (vault) {
    if (!vault.status) return <AddSkeleton shielded />;
    if (!marketAssets(vault.status, pool)) {
      return (
        <div className="panel shielded-panel">
          <p style={{ margin: 0 }}>{t("Both tokens of this pool must be vault assets to supply it from the vault. Switch to Public to add from your wallet.", "要从金库向该资金池提供流动性，两种代币都必须是金库资产。切换到“公开”即可从钱包添加。")}</p>
        </div>
      );
    }
  }
  return (
    <div className="add-layout">
      <div className={`panel stack${vault ? " shielded-panel" : ""}`}>
        <section className="form-step">
          <div className="form-step-head"><span className="step-n">01</span><h3>{t("Pool", "资金池")}</h3></div>
          <PositionHead pool={pool} />
        </section>
        {hasWeth && (
          <label className="check-row small">
            <input type="checkbox" checked={eth} onChange={(e) => setEth(e.target.checked)} />
            <span>{t("Pay the WETH side with ETH. It is wrapped for you first, which adds one wallet confirmation.", "用 ETH 支付 WETH 一侧。系统会先帮你包装，因此需要多确认一次钱包。")}</span>
          </label>
        )}
        {pool.kind === "damm" ? <DammAdd key={pool.address} pool={pool} vault={vault} eth={eth && hasWeth} /> : <DlmmAdd key={pool.address} pool={pool} vault={vault} eth={eth && hasWeth} />}
      </div>
      <PoolFacts pool={pool} />
    </div>
  );
}

function PoolFacts({ pool }: { pool: MarketPool }) {
  const t = useT();
  return (
    <div className="panel stack">
      <PositionHead pool={pool} />
      <dl className="rows">
        <div><dt>{t("Price", "价格")}</dt><dd className="mono">{fmtPrice(pool.price)} {pool.token1.symbol}</dd></div>
        <div><dt>{t("Fee now", "当前费率")}</dt><dd className="mono">{(pool.fees.currentBps / 100).toFixed(2)}%</dd></div>
        <div><dt>{t("Fees to LPs", "LP 分成")}</dt><dd>{t(`${100 - pool.fees.protocolShareBps / 100}% of every fee`, `每笔手续费的 ${100 - pool.fees.protocolShareBps / 100}%`)}</dd></div>
        <div><dt>{t("Fees 24h", "24 小时手续费")}</dt><dd className="mono">{fmtNumber(pool.fees24hQuote, 2)}</dd></div>
      </dl>
      <p className="small muted" style={{ margin: 0 }}>
        {pool.kind === "damm"
          ? t("DAMM liquidity covers every price, so it always earns, but less per unit than concentrated liquidity. You can lose value against holding when the price moves.", "DAMM 流动性覆盖所有价格，所以始终在赚取手续费，但单位收益低于集中流动性。价格变动时，相比直接持有可能会有价值损失。")
          : t("DLMM liquidity only earns while the price is inside your bins. Outside them it sits entirely in one token. You can lose value against holding when the price moves.", "DLMM 流动性只有在价格处于你的价格档内时才赚取手续费，超出后会全部变成一种代币。价格变动时，相比直接持有可能会有价值损失。")}
      </p>
    </div>
  );
}

/** Balances to deposit from: the connected wallet, or the vault's spendable notes. */
function useDeposit(pool: MarketPool, vault: VaultState | null, eth = false) {
  // Paying with ETH: the WETH side is funded from the wallet's ETH and wrapped first.
  const ethSide = !vault && eth ? (same(pool.token0.address, WETH) ? 0 : same(pool.token1.address, WETH) ? 1 : null) : null;
  const tokens = [pool.token0.address, pool.token1.address, ethSide !== null ? NATIVE : undefined];
  const wallet = useWalletTokens(tokens, ROUTER);
  const sym0 = ethSide === 0 ? "ETH" : pool.token0.symbol;
  const sym1 = ethSide === 1 ? "ETH" : pool.token1.symbol;
  if (vault) {
    const assets = vault.status && vault.phase === "unlocked" ? marketAssets(vault.status, pool) : null;
    const bal = (i: 0 | 1) => ({ balance: assets ? balances(assets[i].resource).spendable : undefined, allowance: undefined as bigint | undefined });
    return { wallet, b0: bal(0), b1: bal(1), sym0, sym1 };
  }
  const side = (i: 0 | 1) => {
    const t = i === 0 ? pool.token0.address : pool.token1.address;
    // The balance to spend is ETH; the router still pulls WETH, so its allowance is WETH's.
    return ethSide === i ? { balance: wallet.get(NATIVE).balance, allowance: wallet.get(t).allowance } : wallet.get(t);
  };
  return { wallet, b0: side(0), b1: side(1), sym0, sym1 };
}

/** Wraps the ETH that funds a pool's WETH side, when paying with ETH. */
function wraps(pool: MarketPool, amounts: [bigint, bigint], eth: boolean): TxStep[] {
  if (!eth || !WETH) return [];
  const i = same(pool.token0.address, WETH) ? 0 : same(pool.token1.address, WETH) ? 1 : -1;
  const amt = i === 0 ? amounts[0] : i === 1 ? amounts[1] : 0n;
  if (amt === 0n) return [];
  const params = { address: WETH, abi: wethAbi, functionName: "deposit", value: amt, chainId: curveilChain.id } as unknown as TxStep["params"];
  return [{ label: tNow(`Wrap ${fmtAmount(amt, 18)} ETH`, `包装 ${fmtAmount(amt, 18)} ETH`), params }];
}

function approvals(pool: MarketPool, amounts: [bigint, bigint], allowances: [bigint | undefined, bigint | undefined]): TxStep[] {
  const steps: TxStep[] = [];
  [pool.token0, pool.token1].forEach((t, i) => {
    const amt = amounts[i]!;
    if (amt > 0n && (allowances[i] ?? 0n) < amt) {
      steps.push({ label: tNow(`Approve ${fmtAmount(amt, t.decimals)} ${t.symbol} for the router`, `授权路由器使用 ${fmtAmount(amt, t.decimals)} ${t.symbol}`), params: { address: t.address, abi: erc20Abi, functionName: "approve", args: [ROUTER!, amt], chainId: curveilChain.id } });
    }
  });
  return steps;
}

function DammAdd({ pool, vault, eth }: { pool: MarketPool; vault: VaultState | null; eth: boolean }) {
  const t = useT();
  const { address } = useConnection();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const { wallet, b0, b1, sym0, sym1 } = useDeposit(pool, vault, eth);
  const state = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: pool.address, abi: dammPoolAbi, functionName: "getReserves" },
      { address: pool.address, abi: dammPoolAbi, functionName: "totalSupply" },
    ],
    query: { refetchInterval: 10_000 },
  });
  const [r0, r1] = (state.data?.[0] as readonly [bigint, bigint] | undefined) ?? [0n, 0n];
  const supply = (state.data?.[1] as bigint | undefined) ?? 0n;
  const empty = r0 === 0n || r1 === 0n;
  const [v0, setV0] = useState("");
  const [v1, setV1] = useState("");
  const a0 = parseAmount(v0, pool.token0.decimals) ?? 0n;
  const a1 = parseAmount(v1, pool.token1.decimals) ?? 0n;

  const on0 = (v: string) => {
    setV0(v);
    const raw = parseAmount(v, pool.token0.decimals);
    if (!empty) setV1(raw ? formatUnits((raw * r1) / r0, pool.token1.decimals) : "");
  };
  const on1 = (v: string) => {
    setV1(v);
    const raw = parseAmount(v, pool.token1.decimals);
    if (!empty) setV0(raw ? formatUnits((raw * r0) / r1, pool.token0.decimals) : "");
  };

  const minted = empty || supply === 0n ? null : [(a0 * supply) / r0, (a1 * supply) / r1].reduce((x, y) => (x < y ? x : y));
  const share = minted !== null && minted > 0n ? Number((minted * 1_000_000n) / (supply + minted)) / 10_000 : null;
  const short0 = b0.balance !== undefined && a0 > b0.balance;
  const short1 = b1.balance !== undefined && a1 > b1.balance;

  async function add() {
    if (!address || !ROUTER) return;
    const steps = [...wraps(pool, [a0, a1], eth), ...approvals(pool, [a0, a1], [b0.allowance, b1.allowance])];
    steps.push({
      label: t("Add liquidity", "添加流动性"),
      params: {
        address: ROUTER,
        abi: routerAbi,
        functionName: "addLiquidityDamm",
        args: [{ tokenA: pool.token0.address, tokenB: pool.token1.address, amountADesired: a0, amountBDesired: a1, amountAMin: withSlippage(a0, SLIPPAGE_BPS), amountBMin: withSlippage(a1, SLIPPAGE_BPS), to: address, deadline: deadlineIn(DEADLINE_MIN) }],
        chainId: curveilChain.id,
      },
    });
    const ok = await tx.run(steps);
    await wallet.refetch();
    if (ok) {
      setV0("");
      setV1("");
      state.refetch();
      qc.invalidateQueries({ queryKey: ["positions"] });
    }
  }

  const label = a0 === 0n || a1 === 0n ? "Enter both amounts" : short0 ? `Not enough ${sym0}` : short1 ? `Not enough ${sym1}` : "Add liquidity";
  const balLabel = vault ? t("Vault", "金库") : undefined;
  const say = (l: string) => l === "Enter both amounts" ? t(l, "请输入两种代币的数量") : l === "Add liquidity" ? t(l, "添加流动性") : l === "Enter an amount" ? t(l, "请输入金额") : l.startsWith("Not enough ") ? t(l, `${l.slice(11)} 余额不足`) : l;
  return (
    <>
      {empty && vault && <p className="notice warn" style={{ margin: 0 }}>{t("This pool is empty. Seed it from a public wallet first; a shielded deposit cannot set the starting price.", "该资金池是空的。请先用公开钱包注入初始流动性，隐私存入无法设定起始价格。")}</p>}
      {empty && !vault && <p className="notice warn" style={{ margin: 0 }}>{t("This pool is empty. Your deposit sets its starting price, so enter amounts in the ratio of the market price.", "该资金池是空的。你的存入将设定起始价格，请按市场价格的比例输入数量。")}</p>}
      <section className="form-step">
      <div className="form-step-head"><span className="step-n">02</span><h3>{t("Deposit both tokens", "存入两种代币")}</h3><p>{empty ? t("Enter both amounts in the ratio of the market price.", "请按市场价格的比例输入两种数量。") : t("Type either amount and the other follows the pool's current ratio.", "输入任意一种数量，另一种会按资金池当前比例自动计算。")}</p></div>
      <AmountField label={sym0} error={short0 ? t(`More than your ${vault ? "vault" : "wallet"} balance`, `超过你的${vault ? "金库" : "钱包"}余额`) : null} decimals={pool.token0.decimals} value={v0} onChange={on0} symbol={sym0} balanceLabel={balLabel} balance={b0.balance !== undefined ? fmtAmount(b0.balance, pool.token0.decimals) : undefined} onMax={() => b0.balance !== undefined && on0(formatUnits(b0.balance, pool.token0.decimals))}>
        <span className="token-tag"><TokenDisc token={{ address: sym0 === "ETH" ? NATIVE : pool.token0.address, symbol: sym0 }} size={20} />{sym0}</span>
      </AmountField>
      <AmountField label={sym1} error={short1 ? t(`More than your ${vault ? "vault" : "wallet"} balance`, `超过你的${vault ? "金库" : "钱包"}余额`) : null} decimals={pool.token1.decimals} value={v1} onChange={on1} symbol={sym1} balanceLabel={balLabel} balance={b1.balance !== undefined ? fmtAmount(b1.balance, pool.token1.decimals) : undefined} onMax={() => b1.balance !== undefined && on1(formatUnits(b1.balance, pool.token1.decimals))}>
        <span className="token-tag"><TokenDisc token={{ address: sym1 === "ETH" ? NATIVE : pool.token1.address, symbol: sym1 }} size={20} />{sym1}</span>
      </AmountField>
      </section>
      <dl className="rows summary">
        <div><dt>{t("Pool ratio", "资金池比例")}</dt><dd className="mono">{empty ? t("Set by your deposit", "由你的存入设定") : `1 ${sym0} = ${fmtPrice(Number(formatUnits(r1, pool.token1.decimals)) / Number(formatUnits(r0, pool.token0.decimals)))} ${sym1}`}</dd></div>
        <div><dt>{t("Your share after", "存入后你的占比")}</dt><dd className="mono">{share === null ? "–" : `${share.toFixed(4)}%`}</dd></div>
        <div><dt>{t("Minimums", "最低数量")}</dt><dd className="small">{t(`Each amount may fall by at most ${SLIPPAGE_BPS / 100}% if the ratio moves`, `若比例变动，每种数量最多减少 ${SLIPPAGE_BPS / 100}%`)}</dd></div>
      </dl>
      {vault ? (
        <VaultGate v={vault}>
          {(status) => (
            <ShieldedEntry
              status={status}
              pool={pool}
              amounts={[a0, a1]}
              params={(positionId) =>
                encodeDammEntry({ positionId, market: pool.address, min0: withSlippage(a0, SLIPPAGE_BPS), min1: withSlippage(a1, SLIPPAGE_BPS), minLiquidity: minted !== null ? withSlippage(minted, SLIPPAGE_BPS) : 1n })
              }
              blocked={empty ? t("Pool is empty", "资金池为空") : a0 === 0n || a1 === 0n ? t("Enter both amounts", "请输入两种代币的数量") : null}
              onDone={() => {
                setV0("");
                setV1("");
                state.refetch();
              }}
            />
          )}
        </VaultGate>
      ) : (
        <>
          <WalletAction verb={t("add liquidity", "添加流动性")}>
            <button className="btn btn-primary btn-block" disabled={label !== "Add liquidity" || tx.busy} onClick={add}>{tx.busy ? t("Check your wallet…", "请在钱包中确认…") : say(label)}</button>
          </WalletAction>
          <TxStatus phase={tx.phase} />
        </>
      )}
    </>
  );
}

function DlmmAdd({ pool, vault, eth }: { pool: MarketPool; vault: VaultState | null; eth: boolean }) {
  const t = useT();
  const { address } = useConnection();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const { wallet, b0, b1, sym0, sym1 } = useDeposit(pool, vault, eth);
  const live = useReadContract({ address: pool.address, abi: dlmmPairAbi, functionName: "activeId", query: { refetchInterval: 8_000 } });
  const active = live.data ?? pool.activeId ?? 0;
  const [strategy, setStrategy] = useState<Strategy>("balanced");
  const [radius, setRadius] = useState(10);
  const [lower, setLower] = useState(-10);
  const [upper, setUpper] = useState(10);
  const [vx, setVx] = useState("");
  const [vy, setVy] = useState("");
  const lo = strategy === "custom" ? lower : -radius;
  const hi = strategy === "custom" ? upper : radius;
  const dist = useMemo(() => distribution(strategy, lo, hi), [strategy, lo, hi]);
  const ax = parseAmount(vx, pool.token0.decimals) ?? 0n;
  const ay = parseAmount(vy, pool.token1.decimals) ?? 0n;
  const price = (id: number) => binPrice(id, pool.binStep!, pool.token0.decimals, pool.token1.decimals);
  const alloc = allocate(dist, ax, ay);
  const bars = alloc.map((a) => ({ id: active + a.delta, x: Number(formatUnits(a.x, pool.token0.decimals)) * price(active + a.delta), y: Number(formatUnits(a.y, pool.token1.decimals)) }));
  const short0 = b0.balance !== undefined && ax > b0.balance;
  const short1 = b1.balance !== undefined && ay > b1.balance;
  const needsX = hi > 0;
  const needsY = lo < 0;

  async function add() {
    if (!address || !ROUTER) return;
    const steps = [...wraps(pool, [ax, ay], eth), ...approvals(pool, [ax, ay], [b0.allowance, b1.allowance])];
    steps.push({
      label: t("Add liquidity", "添加流动性"),
      params: {
        address: ROUTER,
        abi: routerAbi,
        functionName: "addLiquidityDlmm",
        args: [{ pair: pool.address, amountX: ax, amountY: ay, activeIdExpected: active, idSlippage: 3, deltaIds: dist.deltaIds, distributionX: dist.distributionX, distributionY: dist.distributionY, to: address, deadline: deadlineIn(DEADLINE_MIN) }],
        chainId: curveilChain.id,
      },
    });
    const ok = await tx.run(steps);
    await wallet.refetch();
    if (ok) {
      setVx("");
      setVy("");
      qc.invalidateQueries({ queryKey: ["positions"] });
    }
  }

  const say = (l: string) => l === "Enter both amounts" ? t(l, "请输入两种代币的数量") : l === "Add liquidity" ? t(l, "添加流动性") : l === "Enter an amount" ? t(l, "请输入金额") : l.startsWith("Not enough ") ? t(l, `${l.slice(11)} 余额不足`) : l;
  const label = ax === 0n && ay === 0n ? "Enter an amount" : short0 ? `Not enough ${sym0}` : short1 ? `Not enough ${sym1}` : "Add liquidity";
  return (
    <>
      <section className="form-step">
      <div className="form-step-head"><span className="step-n">02</span><h3>{t("Shape your range", "设定价格区间")}</h3><p>{t("Your liquidity earns fees only while the price is inside the bins you pick.", "只有当价格位于你选择的价格档内时，你的流动性才会赚取手续费。")}</p></div>
      <div className="choice-grid two" role="group" aria-label={t("Allocation strategy", "分配策略")}>
        {STRATEGIES.map((s) => (
          <button key={s.id} type="button" className="choice" aria-pressed={strategy === s.id} onClick={() => setStrategy(s.id)}>
            <strong>{t(s.label, s.labelZh)}</strong>
            <span>{t(s.text, s.textZh)}</span>
          </button>
        ))}
      </div>
      {strategy === "custom" ? (
        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field">
            <span className="field-top"><span className="field-label">{t("Bins below the price", "价格下方的价格档")}</span><span className="mono small">{-lower}</span></span>
            <input type="range" min={0} max={50} value={-lower} onChange={(e) => setLower(-Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="field-top"><span className="field-label">{t("Bins above the price", "价格上方的价格档")}</span><span className="mono small">{upper}</span></span>
            <input type="range" min={0} max={50} value={upper} onChange={(e) => setUpper(Number(e.target.value))} />
          </label>
        </div>
      ) : (
        <label className="field">
          <span className="field-top"><span className="field-label">{t("Bins on each side of the price", "价格两侧各有的价格档")}</span><span className="mono small">{radius} <span className="muted">{t(`· ${radius * 2 + 1} bins in all`, `· 共 ${radius * 2 + 1} 个价格档`)}</span></span></span>
          <input type="range" min={1} max={50} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </label>
      )}
      <dl className="kv range-kv">
        <div><dt>{t("Min price", "最低价格")}</dt><dd className="small">{fmtPrice(price(active + lo))} <span className="muted">{sym1}</span></dd></div>
        <div><dt>{t("Max price", "最高价格")}</dt><dd className="small">{fmtPrice(price(active + hi))} <span className="muted">{sym1}</span></dd></div>
      </dl>
      </section>
      <section className="form-step">
      <div className="form-step-head"><span className="step-n">03</span><h3>{t("Deposit", "存入")}</h3><p>{needsX && needsY ? t(`Bins above the price hold ${sym0}, bins below hold ${sym1}. Fill one side or both.`, `价格上方的价格档存放 ${sym0}，下方存放 ${sym1}。可以只填一侧，也可以两侧都填。`) : needsX ? t(`This range is above the price, so it only takes ${sym0}.`, `该区间在当前价格上方，因此只接受 ${sym0}。`) : t(`This range is below the price, so it only takes ${sym1}.`, `该区间在当前价格下方，因此只接受 ${sym1}。`)}</p></div>
      {needsX && (
        <AmountField label={t(`${sym0} for bins above the price`, `存入上方价格档的 ${sym0}`)} error={short0 ? t(`More than your ${vault ? "vault" : "wallet"} balance`, `超过你的${vault ? "金库" : "钱包"}余额`) : null} decimals={pool.token0.decimals} value={vx} onChange={setVx} symbol={sym0} balanceLabel={vault ? t("Vault", "金库") : undefined} balance={b0.balance !== undefined ? fmtAmount(b0.balance, pool.token0.decimals) : undefined} onMax={() => b0.balance !== undefined && setVx(formatUnits(b0.balance, pool.token0.decimals))}>
          <span className="token-tag"><TokenDisc token={{ address: sym0 === "ETH" ? NATIVE : pool.token0.address, symbol: sym0 }} size={20} />{sym0}</span>
        </AmountField>
      )}
      {needsY && (
        <AmountField label={t(`${sym1} for bins below the price`, `存入下方价格档的 ${sym1}`)} error={short1 ? t(`More than your ${vault ? "vault" : "wallet"} balance`, `超过你的${vault ? "金库" : "钱包"}余额`) : null} decimals={pool.token1.decimals} value={vy} onChange={setVy} symbol={sym1} balanceLabel={vault ? t("Vault", "金库") : undefined} balance={b1.balance !== undefined ? fmtAmount(b1.balance, pool.token1.decimals) : undefined} onMax={() => b1.balance !== undefined && setVy(formatUnits(b1.balance, pool.token1.decimals))}>
          <span className="token-tag"><TokenDisc token={{ address: sym1 === "ETH" ? NATIVE : pool.token1.address, symbol: sym1 }} size={20} />{sym1}</span>
        </AmountField>
      )}
      <div className="field">
        <span className="field-label">{t("Preview of what each bin receives", "各价格档分配预览")}</span>
        {(needsX ? ax : 0n) === 0n && (needsY ? ay : 0n) === 0n ? (
          <div className="preview-empty small muted">{t(`Enter an amount to see how it spreads across the ${bars.length} bins.`, `输入金额即可查看它如何分布到 ${bars.length} 个价格档。`)}</div>
        ) : (
          <BinChart bins={bars} activeId={active} height={120} label={t(`Deposit preview across ${bars.length} bins`, `${bars.length} 个价格档的存入预览`)} formatPrice={(id) => fmtPrice(price(id))} symbols={[sym0, sym1]} />
        )}
      </div>
      </section>
      <p className="small muted" style={{ margin: 0 }}>
        {t(`The active bin (${active.toLocaleString("en-US")}) takes only what matches its current mix of ${sym0} and ${sym1}; anything left over is returned to ${vault ? "your vault as notes" : "your wallet"} in the same transaction. If the price moves more than 3 bins before your deposit lands, it reverts.`, `当前价格档（${active.toLocaleString("en-US")}）只接收符合其当前 ${sym0} 与 ${sym1} 比例的部分，多余的会在同一笔交易中退回${vault ? "你的金库（以票据形式）" : "你的钱包"}。如果在存入上链前价格移动超过 3 个价格档，交易会回滚。`)}
      </p>
      {vault ? (
        <VaultGate v={vault}>
          {(status) => (
            <ShieldedEntry
              status={status}
              pool={pool}
              amounts={[needsX ? ax : 0n, needsY ? ay : 0n]}
              params={(positionId) =>
                encodeDlmmEntry({
                  positionId,
                  market: pool.address,
                  activeIdExpected: active,
                  idSlippage: 3,
                  deltaIds: dist.deltaIds.map(BigInt),
                  distributionX: dist.distributionX,
                  distributionY: dist.distributionY,
                })
              }
              blocked={(needsX ? ax : 0n) === 0n && (needsY ? ay : 0n) === 0n ? t("Enter an amount", "请输入金额") : null}
              onDone={() => {
                setVx("");
                setVy("");
              }}
            />
          )}
        </VaultGate>
      ) : (
        <>
          <WalletAction verb={t("add liquidity", "添加流动性")}>
            <button className="btn btn-primary btn-block" disabled={label !== "Add liquidity" || tx.busy} onClick={add}>{tx.busy ? t("Check your wallet…", "请在钱包中确认…") : say(label)}</button>
          </WalletAction>
          <TxStatus phase={tx.phase} />
        </>
      )}
    </>
  );
}
