import { useEffect, useMemo, useState } from "react";
import { Loading, Sk } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import { ModuleStatus } from "../components/ModuleStatus";
import { TxStatus } from "../components/TxStatus";
import { WalletAction, AmountField, cleanAmount } from "../components/WalletAction";
import { useMarkets, priceOf, kindLabel, type MarketPool } from "../lib/markets";
import { useTokens, useWalletTokens, poolHas, poolOther, same, deadlineIn, isNative, poolToken, wethAbi, WETH, type Tok, GAS_RESERVE } from "../lib/tokens";
import { TokenPicker } from "../components/TokenPicker";
import { parseEventLogs, erc20Abi as erc20Events } from "viem";

/** WETH.deposit with the ETH sent along (the generated write types do not carry `value` here). */
const wrapParams = (amount: bigint) => ({ address: WETH!, abi: wethAbi, functionName: "deposit", value: amount, chainId: curveilChain.id }) as unknown as TxStep["params"];
import { routerAbi, erc20Abi } from "../lib/abis";
import { IS_TESTNET, ROUTER, curveilChain } from "../lib/config";
import { fmtAmount, fmtBps, fmtPrice, parseAmount, withSlippage } from "../lib/format";
import { useTxRunner, type TxStep } from "../lib/tx";
import { FundingRow, SyncNote, VaultGate, useShieldedVault } from "../components/Funding";
import { ShieldedSwapAction } from "../components/ShieldedSwap";
import { SHIELDED_EXECUTION, useFunding } from "../lib/funding";
import { balances } from "../lib/vault/store";
import { useT } from "../lib/i18n";

type Hop = { pool: `0x${string}`; tokenIn: `0x${string}`; tokenOut: `0x${string}` };
type Route = { key: string; hops: Hop[]; pools: MarketPool[] };
type Quote = { route: Route; ok: true; amountOut: bigint; fees: readonly bigint[]; hopIns: bigint[] } | { route: Route; ok: false };

const MAX_ROUTES = 12;
const DEADLINE_MIN = 10;
const SLIPPAGES = [10, 50, 100];

/** Direct routes through every pool holding both tokens, then two-hop routes through one middle token. */
function buildRoutes(pools: MarketPool[], a: `0x${string}`, b: `0x${string}`): Route[] {
  const routes: Route[] = [];
  for (const p of pools) {
    if (poolHas(p, a) && poolHas(p, b)) routes.push({ key: p.address, hops: [{ pool: p.address, tokenIn: a, tokenOut: b }], pools: [p] });
  }
  for (const p1 of pools) {
    if (!poolHas(p1, a)) continue;
    const mid = poolOther(p1, a);
    if (same(mid.address, b)) continue;
    for (const p2 of pools) {
      if (p2 === p1 || !poolHas(p2, mid.address) || !poolHas(p2, b)) continue;
      routes.push({
        key: `${p1.address}-${p2.address}`,
        hops: [
          { pool: p1.address, tokenIn: a, tokenOut: mid.address },
          { pool: p2.address, tokenIn: mid.address, tokenOut: b },
        ],
        pools: [p1, p2],
      });
    }
  }
  return routes.slice(0, MAX_ROUTES);
}

export function Swap() {
  const t = useT();
  const search = useSearch({ from: "/app/swap" });
  const navigate = useNavigate({ from: "/app/swap" });
  const shielded = useFunding() === "shielded" && SHIELDED_EXECUTION;
  // Public swaps can pay or receive native ETH; it is wrapped to WETH for the pools.
  const allTokens = useTokens({ eth: !shielded });
  const markets = useMarkets();
  const vault = useShieldedVault(shielded);
  const vaultAssets = shielded ? (vault.status?.assets ?? []) : null;
  // Shielded swaps start and end in vault assets.
  const tokens = vaultAssets ? allTokens.filter((t) => vaultAssets.some((a) => same(a.address, t.address))) : allTokens;
  const client = usePublicClient({ chainId: curveilChain.id });
  const { address } = useConnection();
  const qc = useQueryClient();
  const tx = useTxRunner();

  const tokIn = tokens.find((t) => same(t.address, search.from)) ?? tokens[0];
  const tokOut = tokens.find((t) => same(t.address, search.to) && !same(t.address, tokIn?.address)) ?? tokens.find((t) => !same(t.address, tokIn?.address));
  const [input, setInput] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [customSlip, setCustomSlip] = useState("");

  const amountIn = tokIn ? parseAmount(input, tokIn.decimals) : null;
  const ethIn = isNative(tokIn?.address);
  const ethOut = isNative(tokOut?.address);
  // ETH to WETH or back: no pool, just a wrap or an unwrap.
  const wrapOnly = Boolean(tokIn && tokOut && (ethIn || ethOut) && same(poolToken(tokIn.address), poolToken(tokOut.address)));
  const wallet = useWalletTokens([tokIn?.address, tokOut?.address, ethIn ? WETH : undefined], ROUTER);
  const vaultBal = (t: Tok | undefined) => {
    const a = t && vaultAssets?.find((x) => same(x.address, t.address));
    return a && vault.phase === "unlocked" ? { balance: balances(a.resource).spendable, allowance: undefined } : { balance: undefined, allowance: undefined };
  };
  const balIn = shielded ? vaultBal(tokIn) : wallet.get(tokIn?.address);
  const balOut = shielded ? vaultBal(tokOut) : wallet.get(tokOut?.address);

  const routes = useMemo(
    () => (tokIn && tokOut && markets.data && !wrapOnly ? buildRoutes(markets.data, poolToken(tokIn.address), poolToken(tokOut.address)) : []),
    [markets.data, tokIn, tokOut, wrapOnly],
  );
  const routeKey = routes.map((r) => r.key).join(",");

  const quotes = useQuery({
    queryKey: ["quote", routeKey, amountIn?.toString()],
    enabled: Boolean(client && ROUTER && amountIn && amountIn > 0n && routes.length),
    refetchInterval: 8_000,
    queryFn: async () => {
      const block = await client!.getBlockNumber();
      const calls = routes.flatMap((r) => {
        const full = { address: ROUTER!, abi: routerAbi, functionName: "quoteExactIn", args: [r.hops, amountIn!] } as const;
        return r.hops.length > 1 ? [full, { ...full, args: [[r.hops[0]!], amountIn!] } as const] : [full];
      });
      const res = await client!.multicall({ contracts: calls, blockNumber: block, allowFailure: true });
      let k = 0;
      const out: Quote[] = routes.map((route) => {
        const full = res[k++]!;
        const first = route.hops.length > 1 ? res[k++] : undefined;
        if (full.status !== "success") return { route, ok: false };
        const [amountOut, fees] = full.result as readonly [bigint, readonly bigint[]];
        const hopIns = [amountIn!];
        if (first?.status === "success") hopIns.push((first.result as readonly [bigint, readonly bigint[]])[0]);
        return { route, ok: true, amountOut, fees, hopIns };
      });
      return { block, quotes: out };
    },
  });

  const okQuotes = (quotes.data?.quotes ?? []).filter((q): q is Extract<Quote, { ok: true }> => q.ok).sort((x, y) => (y.amountOut > x.amountOut ? 1 : y.amountOut < x.amountOut ? -1 : 0));
  const best = okQuotes[0];
  const minOut = wrapOnly ? amountIn : best ? withSlippage(best.amountOut, slippageBps) : null;
  // What the router pulls: WETH when paying with ETH, which needs its own approval.
  const routerAllowance = ethIn ? wallet.get(WETH).allowance : balIn.allowance;

  // Reset the amount when the pair changes so a stale amount is never swapped into a new token.
  useEffect(() => tx.setPhase({ kind: "idle" }), [tokIn?.address, tokOut?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (side: "from" | "to", addr: string) => {
    const other = side === "from" ? tokOut : tokIn;
    const next = { from: tokIn?.address, to: tokOut?.address, [side]: addr };
    if (same(addr, other?.address)) next[side === "from" ? "to" : "from"] = side === "from" ? tokIn?.address : tokOut?.address;
    navigate({ search: next, replace: true });
  };
  const flip = () => {
    navigate({ search: { from: tokOut?.address, to: tokIn?.address }, replace: true });
    setInput("");
  };

  async function swap() {
    if (!tokIn || !tokOut || !address || !amountIn || !WETH && (ethIn || ethOut)) return;
    if (wrapOnly) {
      const step: TxStep = ethIn
        ? { label: t(`Wrap ${fmtAmount(amountIn, 18)} ETH`, `包装 ${fmtAmount(amountIn, 18)} ETH`), params: wrapParams(amountIn) }
        : { label: t(`Unwrap ${fmtAmount(amountIn, 18)} WETH`, `解包 ${fmtAmount(amountIn, 18)} WETH`), params: { address: WETH!, abi: wethAbi, functionName: "withdraw", args: [amountIn], chainId: curveilChain.id } };
      const r = await tx.run([step]);
      await wallet.refetch();
      if (r) setInput("");
      return;
    }
    if (!best || !ROUTER || minOut === null) return;
    const steps: TxStep[] = [];
    const pulled = ethIn ? WETH! : tokIn.address;
    if (ethIn) steps.push({ label: t(`Wrap ${fmtAmount(amountIn, 18)} ETH`, `包装 ${fmtAmount(amountIn, 18)} ETH`), params: wrapParams(amountIn) });
    if ((routerAllowance ?? 0n) < amountIn) {
      steps.push({ label: t(`Approve ${fmtAmount(amountIn, tokIn.decimals)} ${ethIn ? "WETH" : tokIn.symbol} for the router`, `授权路由器使用 ${fmtAmount(amountIn, tokIn.decimals)} ${ethIn ? "WETH" : tokIn.symbol}`), params: { address: pulled, abi: erc20Abi, functionName: "approve", args: [ROUTER, amountIn], chainId: curveilChain.id } });
    }
    steps.push({
      label: t("Swap", "兑换"),
      params: { address: ROUTER, abi: routerAbi, functionName: "swapExactIn", args: [best.route.hops, amountIn, minOut, address, deadlineIn(DEADLINE_MIN)], chainId: curveilChain.id },
    });
    let receipt = await tx.run(steps);
    if (receipt && ethOut) {
      // Unwrap exactly the WETH the swap paid out.
      const got = parseEventLogs({ abi: erc20Events, eventName: "Transfer", logs: receipt.logs })
        .filter((l) => same(l.address, WETH) && same(l.args.to, address))
        .reduce((sum, l) => sum + l.args.value, 0n);
      if (got > 0n) receipt = await tx.run([{ label: t(`Unwrap ${fmtAmount(got, 18)} WETH to ETH`, `把 ${fmtAmount(got, 18)} WETH 解包为 ETH`), params: { address: WETH!, abi: wethAbi, functionName: "withdraw", args: [got], chainId: curveilChain.id } }]);
    }
    await wallet.refetch();
    if (receipt) {
      setInput("");
      qc.invalidateQueries({ queryKey: ["activity"] });
      qc.invalidateQueries({ queryKey: ["markets"] });
    }
  }

  const insufficient = amountIn !== null && balIn.balance !== undefined && amountIn > balIn.balance;
  const noRoute = Boolean(amountIn && amountIn > 0n && quotes.isSuccess && !best);
  const steps = (ethIn ? 1 : 0) + ((routerAllowance ?? 0n) < (amountIn ?? 0n) ? 1 : 0) + 1 + (ethOut ? 1 : 0);
  const slipWarn = slippageBps > 300;
  const label = !tokIn || !tokOut
    ? "Select tokens"
    : !amountIn || amountIn === 0n
      ? "Enter an amount"
      : insufficient
        ? `Not enough ${tokIn.symbol}`
        : wrapOnly
          ? ethIn ? "Wrap" : "Unwrap"
          : routes.length === 0
            ? "No pool for this pair"
            : noRoute
              ? "Not enough liquidity"
              : !best
                ? "Getting a quote…"
                : steps > 1
                  ? `Swap (${steps} wallet confirmations)`
                  : "Swap";
  const disabled = !(label === "Swap" || label === "Wrap" || label === "Unwrap" || label.startsWith("Swap ("));
  const shieldedBlockedEn = !tokIn || !tokOut ? "Select tokens" : !amountIn || amountIn === 0n ? "Enter an amount" : routes.length === 0 ? "No pool for this pair" : noRoute ? "Not enough liquidity" : !best ? "Getting a quote…" : null;
  /** The button text in Chinese; the English text above also drives which states can be pressed. */
  const say = (l: string) => {
    const zh: Record<string, string> = {
      "Select tokens": "请选择代币", "Enter an amount": "请输入金额", Wrap: "包装", Unwrap: "解包", "No pool for this pair": "该交易对没有资金池",
      "Not enough liquidity": "流动性不足", "Getting a quote…": "正在获取报价…", Swap: "兑换",
    };
    if (zh[l]) return t(l, zh[l]);
    if (l.startsWith("Swap (")) return t(l, `兑换（需在钱包确认 ${steps} 次）`);
    if (l.startsWith("Not enough ")) return t(l, `${l.slice(11)} 余额不足`);
    return l;
  };
  const shieldedBlocked = shieldedBlockedEn && say(shieldedBlockedEn);

  return (
    <div className="wrap">
      <PageHead
        kicker={t("Trade", "交易")} label={t("Best route", "最优路由")} title={t("Swap", "兑换")} art="route"
        lead={t("Exact-input swaps across public DAMM and DLMM pools, routed through at most one middle token. Every figure below is quoted on-chain at a stated block.", "在公开的 DAMM 和 DLMM 资金池之间按精确输入兑换，最多经过一个中间代币。下方每个数字都在指定区块上从链上报价。")}
      />
      <div className="swap-layout">
        <div className="stack">
          <ModuleStatus id="swap" />
          <div className={`panel stack swap-card${shielded ? " shielded-panel" : ""}`}>
            {SHIELDED_EXECUTION && <FundingRow what={t("The swap's amounts are public; who swapped is not.", "兑换金额是公开的，但谁在兑换不公开。")} />}
            {shielded && <SyncNote v={vault} />}
            <AmountField
              label={t("You pay", "你支付")}
              value={input}
              onChange={setInput}
              symbol={tokIn?.symbol}
              decimals={tokIn?.decimals}
              balance={tokIn && balIn.balance !== undefined ? fmtAmount(balIn.balance, tokIn.decimals) : undefined}
              onMax={() => {
                if (!tokIn || balIn.balance === undefined) return;
                // Leave a little ETH for gas when paying with ETH.
                const max = ethIn ? (balIn.balance > GAS_RESERVE ? balIn.balance - GAS_RESERVE : 0n) : balIn.balance;
                setInput(formatUnits(max, tokIn.decimals));
              }}
              balanceLabel={shielded ? t("Vault", "金库") : undefined}
              error={insufficient && tokIn ? t(`More than your ${shielded ? "vault" : "wallet"} balance of ${fmtAmount(balIn.balance!, tokIn.decimals)} ${tokIn.symbol}`, `超过你的${shielded ? "金库" : "钱包"}余额 ${fmtAmount(balIn.balance!, tokIn.decimals)} ${tokIn.symbol}`) : null}
            >
              <TokenPicker tokens={tokens} value={tokIn} onChange={(a) => pick("from", a)} label={t("Token to pay", "支付的代币")} />
            </AmountField>
            <button type="button" className="flip" onClick={flip} aria-label={t("Swap the pay and receive tokens", "交换支付和收到的代币")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 2.5v11M2.5 11 5 13.5 7.5 11M11 13.5v-11M8.5 5 11 2.5 13.5 5" /></svg>
            </button>
            <AmountField
              label={t("You receive", "你收到")}
              value={wrapOnly && amountIn ? formatUnits(amountIn, 18) : best && tokOut ? formatUnits(best.amountOut, tokOut.decimals) : ""}
              readOnly
              symbol={tokOut?.symbol}
              balance={tokOut && balOut.balance !== undefined ? fmtAmount(balOut.balance, tokOut.decimals) : undefined}
              balanceLabel={shielded ? t("Vault", "金库") : undefined}
              hint={wrapOnly ? t("ETH and WETH are always one to one. No pool or fee is involved.", "ETH 和 WETH 始终一比一兑换，不经过资金池，也没有手续费。") : best && tokOut && minOut !== null ? t(<>Expected amount. At least <span className="mono">{fmtAmount(minOut, tokOut.decimals, 6)} {tokOut.symbol}</span> with {slippageBps / 100}% slippage, or the swap reverts.</>, <>预期数量。在 {slippageBps / 100}% 滑点下至少收到 <span className="mono">{fmtAmount(minOut, tokOut.decimals, 6)} {tokOut.symbol}</span>，否则兑换会回滚。</>) : undefined}
            >
              <TokenPicker tokens={tokens} value={tokOut} onChange={(a) => pick("to", a)} label={t("Token to receive", "收到的代币")} />
            </AmountField>

            <div className="slippage">
              <span className="field-label">{t("Slippage tolerance", "滑点容差")}</span>
              <div className="seg" role="group" aria-label={t("Slippage tolerance", "滑点容差")} style={{ marginTop: 0 }}>
                {SLIPPAGES.map((b) => (
                  <button key={b} type="button" aria-pressed={slippageBps === b && !customSlip} onClick={() => { setSlippageBps(b); setCustomSlip(""); }}>{b / 100}%</button>
                ))}
                <input
                  className="slip-input mono"
                  inputMode="decimal"
                  placeholder={t("Custom", "自定义")}
                  aria-label={t("Custom slippage in percent", "自定义滑点（百分比）")}
                  value={customSlip}
                  onChange={(e) => {
                    const raw = cleanAmount(e.target.value, 2);
                    setCustomSlip(raw);
                    const v = Number(raw);
                    if (Number.isFinite(v) && v > 0 && v <= 50) setSlippageBps(Math.round(v * 100));
                  }}
                />
              </div>
            </div>
            {slipWarn && <p className="notice warn" style={{ margin: 0 }}>{t("A tolerance above 3% lets the trade fill at a much worse price if the pool moves before it lands.", "容差超过 3% 时，如果资金池在交易上链前发生变动，交易可能以差得多的价格成交。")}</p>}

            {best && tokIn && tokOut && amountIn ? (
              <p className="quote-line" style={{ margin: 0 }}>
                <span>{t("Rate", "汇率")}</span>
                <span className="mono">1 {tokIn.symbol} = {fmtPrice(Number(formatUnits(best.amountOut, tokOut.decimals)) / Number(formatUnits(amountIn, tokIn.decimals)))} {tokOut.symbol}</span>
              </p>
            ) : null}
            {shielded ? (
              <VaultGate v={vault}>
                {(status) =>
                  tokIn && tokOut ? (
                    <ShieldedSwapAction
                      status={status}
                      tokIn={tokIn}
                      tokOut={tokOut}
                      amountIn={amountIn}
                      hops={best?.route.hops ?? null}
                      expectedOut={best?.amountOut ?? null}
                      minOut={minOut}
                      blocked={shieldedBlocked}
                      onDone={() => {
                        setInput("");
                        qc.invalidateQueries({ queryKey: ["markets"] });
                      }}
                    />
                  ) : (
                    <p className="small muted" style={{ margin: 0 }}>{t(<>Shield an asset in the <Link to="/app/vault">vault</Link> first.</>, <>请先在<Link to="/app/vault">金库</Link>中存入一种隐私资产。</>)}</p>
                  )
                }
              </VaultGate>
            ) : (
              <>
                <WalletAction verb={t("swap", "兑换")}>
                  <button className="btn btn-primary btn-block" disabled={disabled || tx.busy} onClick={swap}>{tx.busy ? t("Check your wallet…", "请在钱包中确认…") : say(label)}</button>
                </WalletAction>
                {insufficient && IS_TESTNET && tokIn?.symbol.startsWith("t") && (
                  <p className="small muted" style={{ margin: 0 }}>{t(<>Test tokens are free from the <Link to="/docs" search={{ page: "testnet" }} hash="faucet">testnet faucet</Link>.</>, <>可以从<Link to="/docs" search={{ page: "testnet" }} hash="faucet">测试网水龙头</Link>免费领取测试代币。</>)}</p>
                )}
                <TxStatus phase={tx.phase} />
              </>
            )}
          </div>
        </div>

        <div className="stack">
          {wrapOnly ? (
            <div className="panel stack">
              <p className="eyebrow" style={{ margin: 0 }}>{t("Wrap", "包装")}</p>
              <p className="small muted" style={{ margin: 0 }}>
                {ethIn ? t("ETH goes into the WETH contract and the same amount of WETH comes back.", "ETH 存入 WETH 合约，并换回等量的 WETH。") : t("WETH goes back into its contract and the same amount of ETH comes back.", "WETH 存回其合约，并换回等量的 ETH。")} {t("No pool, fee or slippage is involved. Pools trade WETH, so paying with ETH elsewhere on this page wraps it for you first.", "不经过资金池，没有手续费和滑点。资金池交易的是 WETH，所以在本页其他地方用 ETH 付款时会先自动帮你包装。")}
              </p>
            </div>
          ) : <QuoteDetails tokIn={tokIn} tokOut={tokOut} amountIn={amountIn} best={best} alternatives={okQuotes.slice(1)} failed={(quotes.data?.quotes ?? []).filter((q) => !q.ok).length} minOut={minOut} slippageBps={slippageBps} block={quotes.data?.block} loading={quotes.isFetching && !quotes.data} error={quotes.isError} />}
        </div>
      </div>
    </div>
  );
}

function QuoteDetails({ tokIn, tokOut, amountIn, best, alternatives, failed, minOut, slippageBps, block, loading, error }: {
  tokIn?: Tok;
  tokOut?: Tok;
  amountIn: bigint | null;
  best?: Extract<Quote, { ok: true }>;
  alternatives: Extract<Quote, { ok: true }>[];
  failed: number;
  minOut: bigint | null;
  slippageBps: number;
  block?: bigint;
  loading: boolean;
  error: boolean;
}) {
  const t = useT();
  if (!tokIn || !tokOut) return null;
  if (error) return <p className="notice bad" role="alert">{t("The quote could not be read from the chain. Swapping is blocked until a fresh quote arrives.", "无法从链上读取报价。在拿到新报价之前，兑换暂不可用。")}</p>;
  if (!amountIn || amountIn === 0n) {
    return (
      <div className="panel">
        <p className="eyebrow">{t("Quote", "报价")}</p>
        <p className="small muted" style={{ marginBottom: 0 }}>{t("Enter an amount to see the route, expected and minimum output, fees and price impact.", "输入金额即可查看路由、预期和最低输出、手续费以及价格影响。")}</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="panel stack" aria-busy="true">
        <Loading label={t("Quoting every route on-chain", "正在链上为每条路由报价")} />
        <div className="row-between">
          <p className="eyebrow" style={{ margin: 0 }}>{t("Quote", "报价")}</p>
          <span className="small muted mono"><Sk w="22ch" /></span>
        </div>
        <dl className="rows">
          {t(["Rate", "Expected output", "Minimum received", "Price impact"], ["汇率", "预期输出", "最低到账", "价格影响"]).map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="12ch" /></dd></div>)}
          <div><dt>{t("Deadline", "截止时间")}</dt><dd>{t(`${DEADLINE_MIN} minutes after you sign`, `签名后 ${DEADLINE_MIN} 分钟`)}</dd></div>
        </dl>
        <div>
          <p className="small muted" style={{ margin: "0 0 8px" }}>{t("Route and fees", "路由与手续费")}</p>
          <Sk block w="100%" h={44} />
        </div>
      </div>
    );
  }
  if (!best) {
    return (
      <div className="panel">
        <p className="eyebrow">{t("Quote", "报价")}</p>
        <p className="small muted" style={{ marginBottom: 0 }}>{t("No route can fill this amount at the current liquidity.", "按当前流动性，没有路由能成交这个金额。")}</p>
      </div>
    );
  }

  const inH = Number(formatUnits(amountIn, tokIn.decimals));
  const outH = Number(formatUnits(best.amountOut, tokOut.decimals));
  const spot = best.route.pools.reduce<number | null>((acc, p, i) => {
    const s = priceOf(p, best.route.hops[i]!.tokenIn);
    return acc === null || s === null ? null : acc * s;
  }, 1);
  const feeKeep = best.route.pools.reduce((acc, p, i) => {
    const hin = best.hopIns[i];
    const f = hin && hin > 0n ? Number(best.fees[i]!) / Number(hin) : p.fees.currentBps / 10_000;
    return acc * (1 - f);
  }, 1);
  const impact = spot ? Math.max(0, 1 - outH / (inH * spot * feeKeep)) : null;

  return (
    <div className="panel stack">
      <div className="row-between">
        <p className="eyebrow" style={{ margin: 0 }}>{t("Quote", "报价")}</p>
        <span className="small muted mono">{t(`block ${block?.toLocaleString("en-US")} · refreshes every 8s`, `区块 ${block?.toLocaleString("en-US")} · 每 8 秒刷新`)}</span>
      </div>
      <dl className="rows">
        <div><dt>{t("Rate", "汇率")}</dt><dd className="mono">1 {tokIn.symbol} = {fmtPrice(outH / inH)} {tokOut.symbol}</dd></div>
        <div><dt>{t("Expected output", "预期输出")}</dt><dd className="mono">{fmtAmount(best.amountOut, tokOut.decimals, 6)} {tokOut.symbol}</dd></div>
        <div><dt>{t("Minimum received", "最低到账")}</dt><dd className="mono">{minOut !== null ? fmtAmount(minOut, tokOut.decimals, 6) : "–"} {tokOut.symbol} <span className="muted">{t(`(${slippageBps / 100}% tolerance)`, `（${slippageBps / 100}% 容差）`)}</span></dd></div>
        <div>
          <dt>{t("Price impact", "价格影响")}</dt>
          <dd className={`mono ${impact !== null && impact > 0.05 ? "bad-text" : impact !== null && impact > 0.01 ? "warn-text" : ""}`}>
            {impact === null ? "–" : impact < 0.0001 ? "<0.01%" : `${(impact * 100).toFixed(2)}%`}
          </dd>
        </div>
        <div><dt>{t("Deadline", "截止时间")}</dt><dd>{t(`${DEADLINE_MIN} minutes after you sign`, `签名后 ${DEADLINE_MIN} 分钟`)}</dd></div>
      </dl>
      <div>
        <p className="small muted" style={{ margin: "0 0 8px" }}>{t("Route and fees", "路由与手续费")}</p>
        <ol className="route-hops">
          {best.route.pools.map((p, i) => {
            const hop = best.route.hops[i]!;
            const hin = same(hop.tokenIn, p.token0.address) ? p.token0 : p.token1;
            const hout = poolOther(p, hop.tokenIn);
            const fee = best.fees[i] ?? 0n;
            const proto = (fee * BigInt(p.fees.protocolShareBps)) / 10_000n;
            const pct = best.hopIns[i] && best.hopIns[i]! > 0n ? Number((fee * 1_000_000n) / best.hopIns[i]!) / 10_000 : null;
            return (
              <li key={p.address}>
                <div className="row-between">
                  <span>{hin.symbol} → {hout.symbol}</span>
                  <Link to="/app/pools/$pool" params={{ pool: p.address }} className="small">{kindLabel(p)}</Link>
                </div>
                <span className="small muted">
                  {t("Fee", "手续费")} {fmtAmount(fee, hin.decimals, 6)} {hin.symbol}{pct !== null ? ` (${pct.toFixed(2)}%)` : ` (${fmtBps(p.fees.currentBps)})`}: {t(`${fmtAmount(fee - proto, hin.decimals, 6)} to LPs, ${fmtAmount(proto, hin.decimals, 6)} to the protocol`, `${fmtAmount(fee - proto, hin.decimals, 6)} 给 LP，${fmtAmount(proto, hin.decimals, 6)} 给协议`)}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {(alternatives.length > 0 || failed > 0) && (
        <details>
          <summary className="small">{t(`Other routes checked (${alternatives.length + failed})`, `已检查的其他路由（${alternatives.length + failed}）`)}</summary>
          <ul className="small muted alt-routes">
            {alternatives.map((q) => (
              <li key={q.route.key}>
                {q.route.pools.map((p) => kindLabel(p)).join(" → ")}: <span className="mono">{fmtAmount(q.amountOut, tokOut.decimals, 6)}</span> {tokOut.symbol}
              </li>
            ))}
            {failed > 0 && <li>{t(`${failed} route${failed > 1 ? "s" : ""} cannot fill this amount.`, `${failed} 条路由无法成交这个金额。`)}</li>}
          </ul>
        </details>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        {t("Price impact compares the quote with the last indexed pool price, after fees. The swap reverts rather than fill below the minimum.", "价格影响是把扣除手续费后的报价与最近索引的资金池价格相比。兑换宁可回滚，也不会以低于最低值的价格成交。")}
      </p>
    </div>
  );
}
