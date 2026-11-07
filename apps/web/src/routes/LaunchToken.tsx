import { useEffect, useMemo, useState } from "react";
import { useFunding } from "../lib/funding";
import { QuoteFig } from "../components/QuoteFig";
import { Loading, Sk, SkRows } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import type { TxPhase } from "../components/TxStatus";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useReadContract } from "wagmi";
import { formatUnits, isAddress } from "viem";
import { TokenAvatar } from "../components/TokenAvatar";
import { CopyAddress } from "../components/CopyAddress";
import { TvChart } from "../components/TvChart";
import { tradeCandles } from "../lib/candles";
import { TxStatus } from "../components/TxStatus";
import { WalletAction, AmountField } from "../components/WalletAction";
import { IndexerNote } from "../components/ModuleStatus";
import { Progress } from "./Launch";
import { TemplateTerms } from "./LaunchCreate";
import { bondingCurveAbi, erc20Abi, lpEscrowAbi } from "../lib/abis";
import { LP_ESCROW, explorerAddress, explorerTx, shortAddress } from "../lib/config";
import { fmtAmount, fmtBps, fmtNumber, fmtPrice, isUsd, parseAmount, timeAgo, withSlippage } from "../lib/format";
import { STATE_LABEL, justCreated, untilLabel, useLaunch, useLaunchTrades, type LaunchDetail, type Lock } from "../lib/launch";
import { deadlineIn, useWalletTokens, same, NATIVE, WETH, wrapStep, unwrapStep, wethReceived, GAS_RESERVE, quoteSym } from "../lib/tokens";
import { useTxRunner, type TxStep } from "../lib/tx";
import { padHref, useOperator } from "../lib/launchpads";

export function LaunchToken() {
  const { token } = useParams({ from: "/app/launch/$token" });
  const valid = isAddress(token);
  const detail = useLaunch(valid ? token : "0x0000000000000000000000000000000000000000", valid);

  // A launch created a moment ago is not indexed yet: wait for it instead of saying it is missing.
  const fresh = valid && justCreated(token);
  if (fresh && !detail.data && (!detail.error || String(detail.error.message).includes("404"))) return <TokenSkeleton note="Your token is created. Curveil is indexing it now, which takes up to a minute. This page fills in by itself." />;
  // A failed refresh keeps showing the last good data.
  if (!valid || (detail.error && !detail.data)) {
    return (
      <div className="wrap">
        <PageHead
          kicker={<Link to="/app/launch">Launch</Link>} title="Launch not found"
          lead={valid && !String(detail.error?.message).includes("404")
            ? "The Curveil API could not be reached, so this launch cannot be shown."
            : <>No Curveil launch is indexed for <span className="mono">{token}</span> on this network. A launch created in the last few seconds may still be indexing.</>}
        />
        <div className="hero-actions">
          <Link to="/app/launch" className="btn">All launches</Link>
          {valid && <button className="btn" onClick={() => detail.refetch()}>Retry</button>}
        </div>
      </div>
    );
  }
  if (!detail.data) return <TokenSkeleton />;
  return <TokenView d={detail.data} />;
}

/** The token page while it loads: labels and the warning stay, values are skeletons. */
function TokenSkeleton({ note }: { note?: string }) {
  return (
    <div className="wrap tk" aria-busy="true">
      <Loading label={note ?? "Loading the launch"} />
      {note && <p className="notice good" style={{ marginBottom: 16 }}>{note}</p>}
      <Link to="/app/launch" className="tk-back">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Launches
      </Link>
      <header className="tk-head">
        <div className="tk-id">
          <Sk w={64} h={64} style={{ borderRadius: "50%", flex: "none" }} />
          <div className="tk-id-text">
            <div className="tk-name"><h1><Sk w="6em" h="0.85em" /></h1></div>
            <p className="tk-meta"><Sk w="38ch" /></p>
          </div>
        </div>
        <div className="tk-cap">
          <span className="tk-label">Market cap</span>
          <strong><Sk w="7ch" /></strong>
          <span className="tk-cap-sub"><Sk w="12ch" /></span>
        </div>
      </header>
      <div className="tk-grid">
        <div className="tk-main">
          <section className="tk-chart">
            <div className="tk-chart-top"><div><p className="tk-price"><Sk w="6ch" /></p><p className="tk-change"><Sk w="9ch" /></p></div></div>
            <Sk block w="100%" h={260} />
          </section>
          <dl className="tk-stats">
            {["Market cap", "Volume 24h", "Trades", "Supply", "Creator fees"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="7ch" /></dd></div>)}
          </dl>
          <section className="tk-curve">
            <span className="tk-label">Bonding curve progress</span>
            <Sk block w="100%" h={8} style={{ borderRadius: 999 }} />
            <Sk w="40ch" />
          </section>
        </div>
        <aside className="tk-side">
          <div className="panel stack tk-trade">
            <Sk block w="100%" h={44} />
            <Sk block w="100%" h={96} />
            <Sk block w="100%" h={44} />
            <Sk w="60%" />
          </div>
        </aside>
      </div>
    </div>
  );
}

const DAY = 86_400;
const RANGES = [["24h", DAY], ["7D", 7 * DAY], ["All", 0]] as const;
type Tab = "trades" | "locks" | "fees" | "terms";

function TokenView({ d }: { d: LaunchDetail }) {
  const l = d.launch;
  const quote = l.quote ?? d.template?.quote;
  const q = quoteSym(quote);
  const trades = useLaunchTrades(l.token);
  const pad = useOperator(l.operator ?? undefined);
  // A buy that completes the curve, or a graduation, swaps the panel for the next state's
  // panel; keep that transaction's receipt visible there.
  const [lastTx, setLastTx] = useState<TxPhase | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [range, setRange] = useState<number>(0);
  const [view, setView] = useState<"candles" | "line">("candles");
  const [tab, setTab] = useState<Tab>("trades");
  const tradable = (l.state === "created" || l.state === "trading") && Boolean(quote);
  const funding = useFunding();
  const graduated = l.state === "graduated";

  const points = useMemo(() => {
    const pts = (trades.data ?? [])
      .slice()
      .reverse()
      .filter((t) => t.priceAfter !== null)
      .map((t) => ({ t: t.timestamp, price: t.priceAfter! }));
    if (d.template && pts.length) pts.unshift({ t: l.createdAt, price: d.template.startPrice });
    return pts;
  }, [trades.data, d.template, l.createdAt]);

  const now = Math.floor(Date.now() / 1000);
  const shown = useMemo(() => {
    if (!range) return points;
    const from = now - range;
    const inside = points.filter((p) => p.t >= from);
    const before = points.filter((p) => p.t < from).pop();
    return before ? [{ t: from, price: before.price }, ...inside] : inside;
  }, [points, range, now]);

  // The 24h change: against the last price before a day ago, or the start price for a younger launch.
  const change = useMemo(() => {
    const cur = l.price;
    if (cur === null || !points.length) return null;
    const before = points.filter((p) => p.t <= now - DAY).pop();
    const ref = before?.price ?? (l.createdAt > now - DAY ? points[0]!.price : null);
    return ref ? (cur - ref) / ref : null;
  }, [points, l.price, l.createdAt, now]);
  // Carry the last price up to the current minute (not second, so the candles are not rebuilt every render).
  const nowMinute = Math.floor(now / 60) * 60;
  const candles = useMemo(() => tradeCandles(shown, 60, nowMinute), [shown, nowMinute]);

  const supply = d.template ? Number(BigInt(d.template.totalSupply)) / 1e18 : null;
  const reserve = graduated ? Number(d.graduation?.quoteAmount ?? 0) / 10 ** (quote?.decimals ?? 6) : l.reserveQuote;
  const threshold = d.template?.graduationThresholdQuote ?? null;
  const pct = Math.min(100, l.progressBps / 100);
  const creatorFees = quote ? Number(l.fees.creator) / 10 ** quote.decimals : null;
  const qd = isUsd(q) ? 2 : 4;
  const padName = pad.data ? pad.data.operator.brand?.name || pad.data.operator.slug : null;
  const links = [["Website", d.metadata?.website], ["X", d.metadata?.x], ["Telegram", d.metadata?.telegram]].filter((x): x is [string, string] => Boolean(x[1]));

  const pickSide = (s: "buy" | "sell") => {
    setSide(s);
    document.getElementById("trade")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className={`wrap tk${tradable || graduated ? " has-mbar" : ""}`}>
      <Link to="/app/launch" className="tk-back">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Launches
      </Link>

      <header className="tk-head">
        <div className="tk-id">
          <TokenAvatar token={l.token} symbol={l.symbol} image={l.image} size={64} />
          <div className="tk-id-text">
            <div className="tk-name">
              <h1>{l.name}</h1>
              <span className="tk-sym mono">{l.symbol}</span>
              <span className={`tag ${graduated ? "tag-live" : l.state === "graduation_ready" ? "tag-shielded" : "tag-public"}`}>{STATE_LABEL[l.state]}</span>
            </div>
            <p className="tk-meta">
              <span>by <Link className="mono" to="/app/profile/$address" params={{ address: l.creator }}>{shortAddress(l.creator)}</Link></span>
              <a href={explorerTx(l.createdTx)} target="_blank" rel="noreferrer">{timeAgo(l.createdAt)}</a>
              <span>{q} pair</span>
              <CopyAddress value={l.token} />
              {links.map(([label, href]) => <a key={label} className="tk-link" href={href} target="_blank" rel="noopener noreferrer nofollow ugc">{label} ↗</a>)}
            </p>
          </div>
        </div>
        <div className="tk-cap">
          <span className="tk-label">Market cap</span>
          <strong><QuoteFig n={l.marketCap} symbol={q} /></strong>
          <span className="tk-cap-sub mono">{fmtPrice(l.price)} {q} price</span>
        </div>
      </header>

      <div className="tk-grid">
        <div className="tk-main">
          <section className="tk-chart" aria-labelledby="tk-price">
            <div className="tk-chart-top">
              <div>
                <p id="tk-price" className="tk-price mono">{fmtPrice(l.price)} <span>{q}</span></p>
                <p className={`tk-change ${change === null ? "muted" : change >= 0 ? "good-text" : "bad-text"}`}>
                  {change === null ? "No 24h change yet" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%`} <span className="muted">24h</span>
                </p>
              </div>
              <div className="tk-chart-tools">
                <div className="seg tk-range" role="group" aria-label="Chart type" style={{ marginTop: 0 }}>
                  <button type="button" aria-pressed={view === "candles"} onClick={() => setView("candles")} aria-label="Candles" title="Candles">
                    <svg viewBox="0 0 16 16" aria-hidden="true" className="tk-ico"><path d="M4 2v12M12 2v12" /><rect x="2.5" y="5" width="3" height="6" /><rect x="10.5" y="4" width="3" height="5" /></svg>
                  </button>
                  <button type="button" aria-pressed={view === "line"} onClick={() => setView("line")} aria-label="Line" title="Line">
                    <svg viewBox="0 0 16 16" aria-hidden="true" className="tk-ico"><path d="M1.5 12 6 7l3 3 5.5-6.5" /></svg>
                  </button>
                </div>
                <div className="seg tk-range" role="group" aria-label="Chart range" style={{ marginTop: 0 }}>
                  {RANGES.map(([label, secs]) => <button key={label} type="button" aria-pressed={range === secs} onClick={() => setRange(secs)}>{label}</button>)}
                </div>
              </div>
            </div>
            {trades.isLoading ? <Sk block w="100%" h={360} /> : (
              <TvChart
                candles={candles}
                mark={l.price}
                markTitle="Price"
                height={360}
                mode={view === "line" ? "line" : "candles"}
                fmt={(n) => fmtPrice(n)}
                minBars={30}
                minBand={0.01}
                resetKey={`${l.token}:${range ?? "all"}`}
                empty="No trades in this range yet."
              />
            )}
            <p className="small muted" style={{ margin: 0 }}>{q} per {l.symbol} after each curve trade.{graduated && l.pool ? <> Pool trades are on the <Link to="/app/pools/$pool" params={{ pool: l.pool }}>pool page</Link>.</> : ""}</p>
          </section>

          <dl className="tk-stats">
            <div><dt>Market cap</dt><dd><QuoteFig n={l.marketCap} symbol={q} /></dd></div>
            <div><dt>Volume 24h</dt><dd><QuoteFig n={l.volume24hQuote} symbol={q} /></dd></div>
            <div><dt>Trades</dt><dd>{l.trades.toLocaleString("en-US")}</dd></div>
            <div><dt>Supply</dt><dd>{supply !== null ? compact(supply) : "–"}</dd></div>
            <div><dt>Creator fees</dt><dd>{creatorFees !== null ? fmtNumber(creatorFees, qd) : "–"} <span>{q}</span></dd></div>
          </dl>

          <section className="tk-curve" aria-label="Bonding curve progress">
            <div className="row-between">
              <span className="tk-label">{graduated ? "Graduated" : "Bonding curve progress"}</span>
              <span className="mono tk-curve-pct">{graduated ? "100%" : `${pct.toFixed(pct < 10 ? 2 : 1)}%`}</span>
            </div>
            <div className="tk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(graduated ? 100 : pct)}>
              <div style={{ width: `${graduated ? 100 : pct}%` }} data-done={graduated || undefined} />
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              {graduated
                ? <>The curve closed with <span className="mono">{fmtNumber(reserve, qd)} {q}</span> and moved into a DAMM pool. Its LP shares are locked in escrow.</>
                : <><span className="mono">{fmtNumber(reserve, qd)}</span> of <span className="mono">{fmtNumber(threshold, 0)} {q}</span> in the curve. At the threshold, trading stops and the liquidity moves into a DAMM pool with its LP shares locked.</>}
            </p>
          </section>

          <dl className="tk-facts">
            <div><dt>Token</dt><dd><CopyAddress value={l.token} /></dd></div>
            <div><dt>Curve</dt><dd><CopyAddress value={l.curve} /></dd></div>
            {l.pool && <div><dt>Pool</dt><dd><Link className="mono" to="/app/pools/$pool" params={{ pool: l.pool }}>{shortAddress(l.pool)}</Link></dd></div>}
            <div><dt>Launched</dt><dd>{new Date(l.createdAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
            <div><dt>Template</dt><dd title={l.templateLabel ?? undefined}>{l.templateLabel ?? `Template ${l.templateId}`}</dd></div>
            {l.operator && <div><dt>Launchpad</dt><dd><a href={padHref(pad.data?.operator, l.operator)} target="_blank" rel="noreferrer">{padName ?? shortAddress(l.operator)}</a></dd></div>}
          </dl>

          {(d.metadata?.description || (!d.metadata && l.metadataUri)) && (
            <section className="tk-about">
              <h2>About</h2>
              {d.metadata?.description && <p style={{ whiteSpace: "pre-line" }}>{d.metadata.description}</p>}
              {!d.metadata && l.metadataUri && <p className="small muted">Details at an external link not hosted by Curveil: <span className="mono">{l.metadataUri.slice(0, 80)}</span></p>}
            </section>
          )}

          <section className="tk-tabs">
            <div className="tk-tablist" role="tablist" aria-label="Token details">
              {([["trades", `Trades`, l.trades], ["locks", "Locked liquidity", d.locks.length || null], ["fees", "Fees", null], ["terms", "Terms", null]] as [Tab, string, number | null][])
                .filter(([id]) => id !== "locks" || d.locks.length > 0)
                .map(([id, label, n]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                    {label}{n !== null && <span className="tk-count">{n.toLocaleString("en-US")}</span>}
                  </button>
                ))}
              {tab === "trades" && <span className="tk-tab-note"><IndexerNote /></span>}
            </div>
            <div role="tabpanel">
              {tab === "trades" && <TradesTable trades={trades} symbol={l.symbol} quote={quote} />}
              {tab === "locks" && <LocksPanel d={d} />}
              {tab === "fees" && <FeesPanel d={d} />}
              {tab === "terms" && d.template && (
                <div className="stack">
                  <TemplateTerms t={d.template} operatorShareBps={d.launch.operatorShareBps} operatorName={padName ?? undefined} />
                  {d.launch.operator && <p className="small muted" style={{ margin: 0 }}>Launched on {padName ?? shortAddress(d.launch.operator)}. Its share was fixed when this token was created.</p>}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="tk-side" id="trade" aria-label="Trade">
          <div className="panel stack tk-trade">
            {tradable && funding === "shielded" && (
              <p className="small muted tk-public-note">
                Curve trades are public: they pay from your connected wallet, not your vault. Once the token graduates into a pool, it can be swapped shielded from <Link to="/app/swap">Swap</Link> if it is admitted to the vault.
              </p>
            )}
            {tradable && <TradePanel d={d} onConfirmed={setLastTx} side={side} onSide={setSide} />}
            {l.state === "graduation_ready" && <GraduatePanel d={d} prior={lastTx} onConfirmed={setLastTx} />}
            {graduated && <GraduatedPanel d={d} prior={lastTx} />}
          </div>
          <p className="tk-warn small">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 6.5v3.5M8 12v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            Anyone can launch a token. Curveil does not review projects; the template only fixes the economics. Trade only what you can afford to lose.
          </p>
        </aside>
      </div>

      {(tradable || graduated) && (
        <div className="tk-mbar" role="region" aria-label="Quick trade">
          <div className="tk-mbar-price">
            <span className="tk-label">{l.symbol}</span>
            <strong className="mono">{fmtPrice(l.price)} <span>{q}</span></strong>
          </div>
          {tradable ? (
            <>
              <button type="button" className="btn tk-sell" onClick={() => pickSide("sell")} disabled={l.state === "created"}>Sell</button>
              <button type="button" className="btn btn-primary tk-buy" onClick={() => pickSide("buy")}>Buy</button>
            </>
          ) : (
            l.pool && quote && <Link to="/app/swap" search={{ from: quote.address, to: l.token }} className="btn btn-primary">Trade in the pool</Link>
          )}
        </div>
      )}
    </div>
  );
}

const compact = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : fmtNumber(n, 0));

function TradesTable({ trades, symbol, quote }: { trades: ReturnType<typeof useLaunchTrades>; symbol: string; quote: { symbol: string; decimals: number } | null | undefined }) {
  const q = quoteSym(quote);
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data tk-trades">
        <thead>
          <tr><th>Side</th><th>Trader</th><th className="num">{q}</th><th className="num">{symbol}</th><th className="num">Price</th><th className="num">Age</th></tr>
        </thead>
        <tbody>
          {trades.isLoading && <SkRows cols={6} rows={5} num={[2, 3, 4, 5]} />}
          {trades.data?.length === 0 && <tr><td colSpan={6} className="muted">No trades yet. The first buy starts the price line.</td></tr>}
          {trades.data?.map((t) => (
            <tr key={`${t.txHash}-${t.logIndex}`}>
              <td>
                <span className={`tk-side-cell ${t.isBuy ? "good-text" : "bad-text"}`}>
                  <svg viewBox="0 0 12 12" aria-hidden="true"><path d={t.isBuy ? "M3 9 9 3M4.5 3H9v4.5" : "M3 3l6 6M9 4.5V9H4.5"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  {t.isBuy ? "Buy" : "Sell"}
                </span>
              </td>
              <td className="mono small"><Link to="/app/profile/$address" params={{ address: t.recipient }}>{shortAddress(t.recipient)}</Link></td>
              <td className="num mono">{fmtAmount(t.quoteAmount, quote?.decimals ?? 6, isUsd(quote?.symbol) ? 2 : 4)}</td>
              <td className="num mono">{compact(Number(t.tokenAmount) / 1e18)}</td>
              <td className="num mono small">{fmtPrice(t.priceAfter)}</td>
              <td className="num small"><a href={explorerTx(t.txHash)} target="_blank" rel="noreferrer" className="muted" title="View the transaction">{timeAgo(t.timestamp)}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SLIPPAGES = [50, 100, 200];

function TradePanel({ d, onConfirmed, side, onSide }: { d: LaunchDetail; onConfirmed: (p: TxPhase) => void; side: "buy" | "sell"; onSide: (s: "buy" | "sell") => void }) {
  const l = d.launch;
  const quote = (l.quote ?? d.template?.quote)!;
  const qc = useQueryClient();
  const { address } = useConnection();
  const tx = useTxRunner();
  const setSide = onSide;
  const [amount, setAmount] = useState("");
  useEffect(() => setAmount(""), [side]);
  const [slip, setSlip] = useState(100);
  const inDec = side === "buy" ? quote.decimals : 18;
  const raw = parseAmount(amount, inDec);
  // A launch priced in WETH is paid in ETH and pays out ETH: the site wraps and unwraps it.
  const ethQ = Boolean(WETH) && same(quote.address, WETH);
  const qSym = quoteSym(quote);
  const wallet = useWalletTokens([quote.address, l.token, ethQ ? NATIVE : undefined], l.curve);
  // ETH and any WETH already in the wallet both pay for an ETH buy; only the shortfall is wrapped.
  const wethHeld = ethQ ? wallet.get(quote.address).balance : undefined;
  const nativeHeld = ethQ ? wallet.get(NATIVE).balance : undefined;
  const qBal = ethQ
    ? { balance: nativeHeld !== undefined && wethHeld !== undefined ? nativeHeld + wethHeld : undefined, allowance: wallet.get(quote.address).allowance }
    : wallet.get(quote.address);
  const tBal = wallet.get(l.token);
  const bal = side === "buy" ? qBal : tBal;

  const buyQ = useReadContract({ address: l.curve, abi: bondingCurveAbi, functionName: "quoteBuy", args: raw ? [raw] : undefined, query: { enabled: side === "buy" && Boolean(raw), refetchInterval: 8_000 } });
  const sellQ = useReadContract({ address: l.curve, abi: bondingCurveAbi, functionName: "quoteSell", args: raw ? [raw] : undefined, query: { enabled: side === "sell" && Boolean(raw), refetchInterval: 8_000 } });

  let out: bigint | null = null;
  let fee: bigint | null = null;
  let used: bigint | null = raw;
  if (side === "buy" && buyQ.data) [out, fee, used] = buyQ.data;
  if (side === "sell" && sellQ.data) [out, fee] = sellQ.data;
  const quoteErr = (side === "buy" ? buyQ.error : sellQ.error) ? "This amount cannot be quoted. For sells, it may exceed the tokens in circulation." : null;
  const partial = side === "buy" && raw && used !== null && used < raw;
  const avgPrice = out && used && out > 0n ? (side === "buy" ? Number(used) / 10 ** quote.decimals / (Number(out) / 1e18) : Number(out + (fee ?? 0n)) / 10 ** quote.decimals / (Number(raw ?? 0n) / 1e18)) : null;
  const impact = avgPrice && l.price ? (side === "buy" ? avgPrice / l.price - 1 : 1 - avgPrice / l.price) : null;
  const minOut = out ? withSlippage(out, slip) : 0n;
  const insufficient = raw && bal.balance !== undefined && raw > bal.balance;

  async function submit() {
    if (!raw || !out || !address) return;
    const steps: TxStep[] = [];
    const token = side === "buy" ? quote.address : l.token;
    const needed = side === "buy" ? (used ?? raw) : raw;
    const wrap = side === "buy" && ethQ ? needed - (needed < (wethHeld ?? 0n) ? needed : (wethHeld ?? 0n)) : 0n;
    if (wrap > 0n) steps.push(wrapStep(wrap, `Wrap ${fmtAmount(wrap, 18, 6)} ETH`));
    if ((bal.allowance ?? 0n) < needed) {
      steps.push({ label: `Approve ${side === "buy" ? quote.symbol : l.symbol}`, params: { address: token, abi: erc20Abi, functionName: "approve", args: [l.curve, needed] } as const });
    }
    steps.push(
      side === "buy"
        ? { label: `Buy ${l.symbol}`, params: { address: l.curve, abi: bondingCurveAbi, functionName: "buy", args: [needed, minOut, address, deadlineIn(10)] } as const }
        : { label: `Sell ${l.symbol}`, params: { address: l.curve, abi: bondingCurveAbi, functionName: "sell", args: [raw, minOut, address, deadlineIn(10)] } as const },
    );
    let r = await tx.run(steps);
    if (r && side === "sell" && ethQ) {
      const got = wethReceived(r, address);
      if (got > 0n) r = await tx.run([unwrapStep(got, `Unwrap ${fmtAmount(got, 18, 6)} WETH to ETH`)]);
    }
    if (r) {
      onConfirmed({ kind: "confirmed", hash: r.transactionHash, block: r.blockNumber, step: partial ? "Your buy reached the graduation threshold" : undefined });
      setAmount("");
      wallet.refetch();
      qc.invalidateQueries({ queryKey: ["launch", l.token.toLowerCase()] });
      qc.invalidateQueries({ queryKey: ["launch-trades", l.token.toLowerCase()] });
      qc.invalidateQueries({ queryKey: ["launches"] });
    }
  }

  return (
    <>
      <div className="seg side-seg" role="tablist" aria-label="Trade side" style={{ marginTop: 0 }}>
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} role="tab" data-side={s === "buy" ? "long" : "short"} aria-selected={side === s} aria-pressed={side === s} onClick={() => { setSide(s); setAmount(""); }} disabled={s === "sell" && l.state === "created"}>
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <AmountField
        label={side === "buy" ? "You pay" : "You sell"}
        value={amount}
        onChange={setAmount}
        symbol={side === "buy" ? qSym : l.symbol}
        balance={bal.balance !== undefined ? fmtAmount(bal.balance, inDec, side === "buy" ? (ethQ ? 4 : 2) : 0) : undefined}
        onMax={bal.balance !== undefined ? () => {
          // On an ETH buy, keep a little ETH back for gas.
          const b = bal.balance!;
          const max = side === "buy" && ethQ ? (b > GAS_RESERVE ? b - GAS_RESERVE : 0n) : b;
          setAmount(formatUnits(max, inDec));
        } : undefined}
        decimals={inDec}
        error={insufficient ? `More than your ${side === "buy" ? qSym : l.symbol} balance` : null}
      >
        <span className="token-tag">{side === "buy" ? qSym : l.symbol}</span>
      </AmountField>
      <AmountField label="You receive" hint={out ? <>Estimate. At least <span className="mono">{fmtAmount(minOut, side === "buy" ? 18 : quote.decimals, side === "buy" ? 0 : 4)}</span> with {fmtBps(slip)} slippage, or the trade reverts.</> : undefined} value={out !== null ? fmtAmount(out, side === "buy" ? 18 : quote.decimals, side === "buy" ? 0 : 4).replace(/,/g, "") : ""} readOnly>
        <span className="token-tag">{side === "buy" ? l.symbol : qSym}</span>
      </AmountField>
      {partial && (
        <p className="notice good small" style={{ margin: 0 }}>
          This buy reaches the graduation threshold. Only {fmtAmount(used!, quote.decimals, isUsd(quote.symbol) ? 2 : 4)} {qSym} is used; the rest stays in your wallet. You receive all remaining curve tokens.
        </p>
      )}
      {quoteErr && raw && <p className="notice bad small" style={{ margin: 0 }}>{quoteErr}</p>}
      <div className="slippage">
        <span className="field-label">Slippage tolerance</span>
        <div className="seg" role="group" aria-label="Slippage" style={{ marginTop: 0 }}>
          {SLIPPAGES.map((s) => <button key={s} type="button" aria-pressed={slip === s} onClick={() => setSlip(s)}>{fmtBps(s)}</button>)}
        </div>
      </div>
      <dl className="rows summary">
        <div><dt>Average price</dt><dd className="mono">{fmtPrice(avgPrice)} {qSym}</dd></div>
        <div><dt>Price impact</dt><dd className={`mono ${impact !== null && impact > 0.05 ? "warn-text" : ""}`}>{impact === null ? "–" : `${(impact * 100).toFixed(2)}%`}</dd></div>
        <div><dt>Curve fee ({fmtBps(d.template?.feeBps)})</dt><dd className="mono">{fee !== null ? `${fmtAmount(fee, quote.decimals, 4)} ${qSym}` : "–"}</dd></div>
        <div><dt>Minimum received</dt><dd className="mono">{out ? fmtAmount(minOut, side === "buy" ? 18 : quote.decimals, side === "buy" ? 0 : 4) : "–"}</dd></div>
      </dl>
      <WalletAction verb={`${side} ${l.symbol}`}>
        <button className="btn btn-primary btn-block" disabled={tx.busy || !raw || !out || Boolean(insufficient)} onClick={submit}>
          {!raw ? "Enter an amount" : insufficient ? `Not enough ${side === "buy" ? qSym : l.symbol}` : tx.busy ? "Waiting for wallet…" : side === "buy" ? `Buy ${l.symbol}` : `Sell ${l.symbol}`}
        </button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </>
  );
}

function GraduatePanel({ d, prior, onConfirmed }: { d: LaunchDetail; prior: TxPhase | null; onConfirmed: (p: TxPhase) => void }) {
  const qc = useQueryClient();
  const tx = useTxRunner();
  const l = d.launch;
  async function graduate() {
    const r = await tx.run([{ label: "Graduate", params: { address: l.curve, abi: bondingCurveAbi, functionName: "graduate" } as const }]);
    if (r) {
      onConfirmed({ kind: "confirmed", hash: r.transactionHash, block: r.blockNumber, step: "Graduated into a DAMM pool" });
      qc.invalidateQueries({ queryKey: ["launch", l.token.toLowerCase()] });
      qc.invalidateQueries({ queryKey: ["launches"] });
    }
  }
  return (
    <>
      {prior && tx.phase.kind === "idle" && <TxStatus phase={prior} />}
      <div>
        <p className="eyebrow">Graduation</p>
        <h3>Ready to graduate</h3>
      </div>
      <p className="small" style={{ margin: 0 }}>
        The curve reserve reached the threshold and curve trading has stopped. Anyone can now graduate it. The migrator checks the amounts and the price, creates the DAMM pool at
        the curve's final price, deposits the reserve with the migration supply and locks every LP share in escrow.
      </p>
      <WalletAction verb="graduate this launch">
        <button className="btn btn-primary btn-block" disabled={tx.busy} onClick={graduate}>{tx.busy ? "Waiting for wallet…" : "Graduate into a DAMM pool"}</button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </>
  );
}

function GraduatedPanel({ d, prior }: { d: LaunchDetail; prior: TxPhase | null }) {
  const g = d.graduation;
  const quote = d.launch.quote;
  return (
    <>
      {prior && <TxStatus phase={prior} />}
      <div>
        <p className="eyebrow">Graduation</p>
        <h3>Trading in the pool</h3>
      </div>
      {g ? (
        <dl className="rows summary">
          <div><dt>Pool</dt><dd className="mono"><Link to="/app/pools/$pool" params={{ pool: g.pool }}>{shortAddress(g.pool)}</Link></dd></div>
          <div><dt>Tokens deposited</dt><dd className="mono">{fmtAmount(g.tokenAmount, 18, 0)}</dd></div>
          <div><dt>{quote?.symbol ?? "Quote"} deposited</dt><dd className="mono">{fmtAmount(g.quoteAmount, quote?.decimals ?? 6, isUsd(quote?.symbol) ? 2 : 4)}</dd></div>
          <div><dt>Graduated</dt><dd><a href={explorerTx(g.txHash)} target="_blank" rel="noreferrer">{timeAgo(g.timestamp)}</a></dd></div>
        </dl>
      ) : (
        <p className="small muted">Graduation details are still indexing.</p>
      )}
      {g && quote && (
        <div className="stack" style={{ gap: 8 }}>
          <Link to="/app/swap" search={{ from: quote.address, to: d.launch.token }} className="btn btn-primary btn-block">Trade in the pool</Link>
          <Link to="/app/pools/$pool" params={{ pool: g.pool }} className="btn btn-block">Pool details</Link>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>The curve is closed. All LP shares from graduation are in escrow; see Locked liquidity for their unlock dates.</p>
    </>
  );
}

function LocksPanel({ d }: { d: LaunchDetail }) {
  return (
    <div className="stack">
      <div className="grid-2">
        {d.locks.map((lock) => <LockCard key={lock.id} lock={lock} d={d} />)}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Locked shares stay in the pool and keep earning trading fees. The beneficiary can claim fees at any time and the LP shares after the unlock time.
        {LP_ESCROW && <> Escrow <a className="mono" href={explorerAddress(LP_ESCROW)} target="_blank" rel="noreferrer">{shortAddress(LP_ESCROW)}</a>.</>}
      </p>
    </div>
  );
}

function LockCard({ lock, d }: { lock: Lock; d: LaunchDetail }) {
  const { address } = useConnection();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const who = lock.id === d.graduation?.creatorLockId ? "Creator" : lock.id === d.graduation?.protocolLockId ? "Protocol" : `Lock #${lock.id}`;
  const p = lock.pool;
  const mine = same(address, lock.beneficiary);
  const unlocked = lock.unlockAt * 1000 <= Date.now();
  const hasFees = lock.pendingFees0 !== "0" || lock.pendingFees1 !== "0";
  async function act(kind: "fees" | "lp") {
    if (!LP_ESCROW || !address) return;
    const r = await tx.run([
      kind === "fees"
        ? { label: "Claim LP fees", params: { address: LP_ESCROW, abi: lpEscrowAbi, functionName: "claimFees", args: [BigInt(lock.id), address] } as const }
        : { label: "Claim LP shares", params: { address: LP_ESCROW, abi: lpEscrowAbi, functionName: "claim", args: [BigInt(lock.id), address] } as const },
    ]);
    if (r) {
      qc.invalidateQueries({ queryKey: ["launch", d.launch.token.toLowerCase()] });
      qc.invalidateQueries({ queryKey: ["escrow"] });
    }
  }
  return (
    <div className="lock-card stack">
      <div className="row-between">
        <strong>{who} lock</strong>
        <span className={`tag ${lock.claimed ? "tag-illustration" : unlocked ? "tag-live" : "tag-public"}`}>{lock.claimed ? "Claimed" : unlocked ? "Unlocked" : `Unlocks ${untilLabel(lock.unlockAt)}`}</span>
      </div>
      <dl className="rows">
        <div><dt>Beneficiary</dt><dd className="mono"><a href={explorerAddress(lock.beneficiary)} target="_blank" rel="noreferrer">{shortAddress(lock.beneficiary)}</a>{mine && " (you)"}</dd></div>
        <div><dt>Unlock time</dt><dd>{new Date(lock.unlockAt * 1000).toLocaleString()}</dd></div>
        {p && !lock.claimed && (
          <div><dt>Underlying now</dt><dd className="mono small">{fmtAmount(lock.underlying0, p.token0.decimals, 4)} {p.token0.symbol} + {fmtAmount(lock.underlying1, p.token1.decimals, 4)} {p.token1.symbol}</dd></div>
        )}
        {p && <div><dt>Unclaimed fees</dt><dd className="mono small">{fmtAmount(lock.pendingFees0, p.token0.decimals, 6)} {p.token0.symbol} + {fmtAmount(lock.pendingFees1, p.token1.decimals, 6)} {p.token1.symbol}</dd></div>}
      </dl>
      {mine && (
        <div className="hero-actions" style={{ marginTop: 0 }}>
          <button className="btn btn-sm" disabled={tx.busy || !hasFees} onClick={() => act("fees")}>Claim fees</button>
          <button className="btn btn-sm" disabled={tx.busy || !unlocked || lock.claimed} onClick={() => act("lp")}>{unlocked ? "Claim LP shares" : `LP unlocks ${untilLabel(lock.unlockAt)}`}</button>
        </div>
      )}
      <TxStatus phase={tx.phase} />
    </div>
  );
}

const BUCKETS = [
  { id: 0, key: "creator", label: "Creator" },
  { id: 2, key: "protocol", label: "Protocol" },
] as const;

function FeesPanel({ d }: { d: LaunchDetail }) {
  const l = d.launch;
  const quote = l.quote ?? d.template?.quote;
  const { address } = useConnection();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const [next, setNext] = useState("");
  const isRecipient = same(address, l.creatorRecipient);
  async function claim(bucket: number) {
    const r = await tx.run([{ label: "Send fees to recipient", params: { address: l.curve, abi: bondingCurveAbi, functionName: "claimFees", args: [bucket] } as const }]);
    if (r) qc.invalidateQueries({ queryKey: ["launch", l.token.toLowerCase()] });
  }
  async function setRecipient() {
    if (!isAddress(next)) return;
    const r = await tx.run([{ label: "Change fee recipient", params: { address: l.curve, abi: bondingCurveAbi, functionName: "setCreatorRecipient", args: [next] } as const }]);
    if (r) {
      setNext("");
      qc.invalidateQueries({ queryKey: ["launch", l.token.toLowerCase()] });
    }
  }
  if (!quote) return null;
  return (
    <div className="stack">
      <dl className="rows summary">
        {BUCKETS.map((b) => (
          <div key={b.id}>
            <dt>{b.label}{b.id === 0 && <> → <span className="mono">{shortAddress(l.creatorRecipient)}</span></>}</dt>
            <dd className="mono">
              {fmtAmount(l.fees[b.key], quote.decimals, 4)} {quote.symbol}
              {address && (
                <button className="link-btn" disabled={tx.busy || l.fees[b.key] === "0"} onClick={() => claim(b.id)}>Send</button>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="small muted" style={{ margin: 0 }}>Anyone can send accrued fees; they always go to the bucket's fixed recipient, never to the caller.</p>
      {isRecipient && (
        <div className="field">
          <span className="field-label">You are the creator fee recipient. Hand it to another address:</span>
          <div className="field-row">
            <input className="text-input mono" value={next} onChange={(e) => setNext(e.target.value.trim())} placeholder="0x…" />
            <button className="btn" disabled={tx.busy || !isAddress(next) || same(next, l.creatorRecipient)} onClick={setRecipient}>Change</button>
          </div>
        </div>
      )}
      <TxStatus phase={tx.phase} />
    </div>
  );
}
