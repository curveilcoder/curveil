import { TokenDisc } from "../components/TokenPair";
import { TokenPicker } from "../components/TokenPicker";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useReadContract, useReadContracts } from "wagmi";
import { zeroAddress } from "viem";
import { TxStatus } from "../components/TxStatus";
import { WalletAction, AmountField } from "../components/WalletAction";
import { dammFactoryAbi, dlmmFactoryAbi } from "../lib/abis";
import { DAMM_FACTORY, DLMM_FACTORY, curveilChain, manifest, explorerAddress } from "../lib/config";
import { binPrice, idForPrice } from "../lib/markets";
import { fmtPrice } from "../lib/format";
import { same, ETH, WETH, isNative } from "../lib/tokens";
import { useTxRunner } from "../lib/tx";
import { markCreated } from "../lib/launch";
import { useT } from "../lib/i18n";

const TIER_IDS = [0, 1, 2, 3] as const;
const TIER_NAMES = ["Standard", "Volatile", "Tier 2", "Tier 3"];
const TIER_NAMES_ZH = ["标准", "高波动", "档位 2", "档位 3"];
const ADMITTED = manifest.assets.map((a) => ({ address: a.address as `0x${string}`, symbol: a.symbol, decimals: a.decimals, name: a.name ?? null, logo: a.logo ?? null }));
// Pools hold WETH, not plain ETH, but ETH is what people look for: it is offered too and stands for WETH.
const PICKABLE = ETH ? [ETH, ...ADMITTED] : ADMITTED;
const onChain = (x: `0x${string}` | undefined) => (isNative(x) ? WETH : x);

/** Create a public pool from an admitted pair and a configuration the factory allows. Adds no liquidity. */
export function CreatePool() {
  const t = useT();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const [kind, setKind] = useState<"damm" | "dlmm">("dlmm");
  const [pickA, setA] = useState<`0x${string}` | undefined>(ETH?.address ?? ADMITTED[1]?.address ?? ADMITTED[0]?.address);
  const [pickB, setB] = useState<`0x${string}` | undefined>(ADMITTED.find((t) => !same(t.address, WETH))?.address);
  const a = onChain(pickA);
  const b = onChain(pickB);
  const [tier, setTier] = useState(0);
  const [step, setStep] = useState<number | null>(null);
  const [price, setPrice] = useState("");
  const ta = PICKABLE.find((t) => same(t.address, pickA));
  const tb = PICKABLE.find((t) => same(t.address, pickB));

  const tiers = useReadContracts({
    allowFailure: true,
    contracts: DAMM_FACTORY ? TIER_IDS.map((id) => ({ address: DAMM_FACTORY, abi: dammFactoryAbi, functionName: "tier", args: [id] }) as const) : [],
  });
  const steps = useReadContract({ address: DLMM_FACTORY, abi: dlmmFactoryAbi, functionName: "binSteps", query: { enabled: Boolean(DLMM_FACTORY) } });
  const presets = useReadContracts({
    allowFailure: false,
    contracts: DLMM_FACTORY ? (steps.data ?? []).map((s) => ({ address: DLMM_FACTORY, abi: dlmmFactoryAbi, functionName: "presets", args: [s] }) as const) : [],
    query: { enabled: Boolean(steps.data?.length) },
  });
  const dlmmShare = useReadContract({ address: DLMM_FACTORY, abi: dlmmFactoryAbi, functionName: "protocolShareBps", query: { enabled: Boolean(DLMM_FACTORY) } });
  const enabledTiers = TIER_IDS.flatMap((id, i) => {
    const r = tiers.data?.[i];
    if (r?.status !== "success") return [];
    const [params, enabled] = r.result as readonly [{ baseFeeBps: number; maxFeeBps: number; protocolShareBps: number }, boolean];
    return enabled ? [{ id, ...params }] : [];
  });
  // A failed read is not a disabled tier: say which it is.
  const tiersRead = Boolean(tiers.data?.some((r) => r.status === "success"));
  const enabledSteps = (steps.data ?? []).flatMap((s, i) => {
    const p = presets.data?.[i] as readonly [number, boolean] | undefined;
    return p?.[1] ? [{ binStep: s, baseFeeBps: p[0] }] : [];
  });
  const binStep = step ?? enabledSteps[0]?.binStep ?? null;

  const pairOk = Boolean(a && b && !same(a, b));
  const dammExisting = useReadContract({ address: DAMM_FACTORY, abi: dammFactoryAbi, functionName: "getPool", args: a && b ? [a, b] : undefined, query: { enabled: pairOk && kind === "damm" } });
  const dlmmExisting = useReadContract({ address: DLMM_FACTORY, abi: dlmmFactoryAbi, functionName: "getPair", args: a && b && binStep !== null ? [a, b, binStep] : undefined, query: { enabled: pairOk && binStep !== null && kind === "dlmm" } });
  const existing = kind === "damm" ? dammExisting : dlmmExisting;
  const exists = pairOk && existing.data && existing.data !== zeroAddress ? existing.data : null;

  const p = Number(price);
  const validPrice = Number.isFinite(p) && p > 0;
  const activeId = ta && tb && binStep !== null && validPrice ? idForPrice(p, binStep, ta.decimals, tb.decimals) : null;
  const binP = activeId !== null && ta && tb && binStep !== null ? binPrice(activeId, binStep, ta.decimals, tb.decimals) : null;
  // Bin prices are Q128 fixed point on-chain: keep the raw price (base units) well inside 2^±128.
  const rawP = binP !== null && ta && tb ? binP / 10 ** (ta.decimals - tb.decimals) : null;
  const priceInRange = rawP === null || (rawP > 1e-30 && rawP < 1e30 && activeId! > 0 && activeId! < 2 ** 24);

  const protoBps = kind === "dlmm" ? dlmmShare.data : enabledTiers.find((t) => t.id === tier)?.protocolShareBps;

  const navigate = useNavigate();
  async function create() {
    if (!a || !b) return;
    const receipt =
      kind === "damm"
        ? await tx.run([{ label: t("Create DAMM pool", "创建 DAMM 资金池"), params: { address: DAMM_FACTORY!, abi: dammFactoryAbi, functionName: "createPool", args: [a, b, tier], chainId: curveilChain.id } }])
        : await tx.run([{ label: t("Create DLMM pair", "创建 DLMM 交易对"), params: { address: DLMM_FACTORY!, abi: dlmmFactoryAbi, functionName: "createPair", args: [a, b, binStep!, activeId!], chainId: curveilChain.id } }]);
    if (receipt) {
      const r = await existing.refetch();
      qc.invalidateQueries({ queryKey: ["markets"] });
      // The pool cannot trade until it has liquidity: go straight to adding it.
      if (r.data && r.data !== zeroAddress) markCreated(r.data);
      if (r.data && r.data !== zeroAddress) navigate({ to: "/app/pools/$pool/add", params: { pool: r.data } });
    }
  }

  const blocker = !ta || !tb
    ? t("Select two assets", "请选择两种资产")
    : same(a, b)
      ? isNative(pickA) !== isNative(pickB) ? t("ETH and WETH are the same asset here: pick another one", "在这里 ETH 和 WETH 是同一种资产：请换一个") : t("Pick two different assets", "请选择两种不同的资产")
      : exists
        ? kind === "damm" ? t("A DAMM pool already exists for this pair", "该交易对已有 DAMM 资金池") : t("A pair with this bin step already exists", "该区间步长的交易对已存在")
        : kind === "dlmm" && binStep === null
          ? t("No bin step is enabled", "没有启用的区间步长")
          : kind === "dlmm" && activeId === null
            ? t("Enter a starting price", "请输入初始价格")
            : kind === "dlmm" && !priceInRange
              ? t("That starting price is out of range", "该初始价格超出范围")
            : kind === "damm" && !tiersRead
              ? tiers.isPending ? t("Reading fee tiers…", "正在读取费率档位…") : t("Could not read the fee tiers. Refresh the page", "无法读取费率档位，请刷新页面")
            : kind === "damm" && !enabledTiers.some((x) => x.id === tier)
              ? t("This fee tier is not enabled", "该费率档位未启用")
              : null;

  return (
    <div className="add-layout">
      <div className="panel stack">
        <section className="form-step">
        <div className="form-step-head"><span className="step-n">01</span><h3>{t("Pool type", "资金池类型")}</h3></div>
        <div className="choice-grid" role="group" aria-label={t("Pool type", "资金池类型")}>
          <button type="button" className="choice" aria-pressed={kind === "dlmm"} onClick={() => setKind("dlmm")}>
            <strong>{t("DLMM pair", "DLMM 交易对")}</strong><span>{t("Liquidity sits in price bins that providers choose. Best for focused ranges.", "流动性分布在提供者选择的价格区间中，适合集中在某个范围。")}</span>
          </button>
          <button type="button" className="choice" aria-pressed={kind === "damm"} onClick={() => setKind("damm")}>
            <strong>{t("DAMM pool", "DAMM 资金池")}</strong><span>{t("Full-range liquidity with a fee that rises when the price is volatile.", "全区间流动性，价格波动时费率会上升。")}</span>
          </button>
        </div>
        </section>
        <section className="form-step">
        <div className="form-step-head"><span className="step-n">02</span><h3>{t("Assets", "资产")}</h3></div>
        <div className="grid-2" style={{ gap: 12 }}>
          <div className="field">
            <span className="small muted">{t("Base asset", "基础资产")}</span>
            <TokenPicker wide tokens={PICKABLE} value={ta} onChange={setA} label={t("Base asset", "基础资产")} />
          </div>
          <div className="field">
            <span className="small muted">{t("Quote asset", "计价资产")}</span>
            <TokenPicker wide tokens={PICKABLE} value={tb} onChange={setB} label={t("Quote asset", "计价资产")} />
          </div>
        </div>
        {(isNative(pickA) || isNative(pickB)) && <p className="small muted" style={{ margin: 0 }}>{t("The pool holds ETH as WETH. When you add liquidity or swap, your ETH is wrapped for you.", "资金池以 WETH 的形式持有 ETH。添加流动性或兑换时，你的 ETH 会自动包装。")}</p>}
        </section>

        {kind === "damm" ? (
          <section className="form-step">
            <div className="form-step-head"><span className="step-n">03</span><h3>{t("Fee tier", "费率档位")}</h3><p>{t("Fixed for the life of the pool. The fee starts at the base rate and rises toward the maximum while the price is volatile. The first deposit sets the starting price.", "在资金池整个生命周期内固定不变。费率从基础费率开始，价格波动时向最高费率上升。首笔存入决定初始价格。")}</p></div>
            <div className="choice-grid" role="group" aria-label={t("Fee tier", "费率档位")}>
              {enabledTiers.map((x) => (
                <button key={x.id} type="button" className="choice" aria-pressed={tier === x.id} onClick={() => setTier(x.id)}>
                  <strong>{t(TIER_NAMES[x.id], TIER_NAMES_ZH[x.id])}</strong><span>{t(`${x.baseFeeBps / 100}% rising to ${x.maxFeeBps / 100}%`, `${x.baseFeeBps / 100}%，最高升至 ${x.maxFeeBps / 100}%`)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="form-step">
              <div className="form-step-head"><span className="step-n">03</span><h3>{t("Bin step", "区间步长")}</h3><p>{t("Fixed for the life of the pair. Smaller bins suit stable prices; larger bins suit volatile ones.", "在交易对整个生命周期内固定不变。较小的区间适合稳定的价格，较大的区间适合波动大的价格。")}</p></div>
              <div className="choice-grid" role="group" aria-label={t("Bin step", "区间步长")}>
                {enabledSteps.map((s) => (
                  <button key={s.binStep} type="button" className="choice" aria-pressed={binStep === s.binStep} onClick={() => setStep(s.binStep)}>
                    <strong>{t(`${(s.binStep / 100).toFixed(2)}% bins`, `${(s.binStep / 100).toFixed(2)}% 区间`)}</strong><span>{t(`${s.baseFeeBps / 100}% fee per trade`, `每笔交易手续费 ${s.baseFeeBps / 100}%`)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="form-step">
              <div className="form-step-head"><span className="step-n">04</span><h3>{t("Starting price", "初始价格")}</h3></div>
              <AmountField
                label={t(`${tb?.symbol ?? ""} per 1 ${ta?.symbol ?? ""}`, `每 1 ${ta?.symbol ?? ""} 兑 ${tb?.symbol ?? ""}`)}
                value={price}
                onChange={setPrice}
                hint={binP !== null ? (
                  <>
                    {/* Both ways, so a price typed for the wrong side stands out before it is fixed on-chain. */}
                    <span className="mono">1 {ta?.symbol} = {fmtPrice(binP)} {tb?.symbol}</span> · <span className="mono">1 {tb?.symbol} = {fmtPrice(1 / binP)} {ta?.symbol}</span>
                    <br />
                    {t(<>Opens in bin <span className="mono">{activeId?.toLocaleString("en-US")}</span>, the nearest bin price not above yours. Check it against the market price: it cannot be changed once the pair exists.</>, <>将在区间 <span className="mono">{activeId?.toLocaleString("en-US")}</span> 开盘，即不高于你所填价格的最近区间价格。请与市场价格核对：交易对创建后无法更改。</>)}
                  </>
                ) : t(`How many ${tb?.symbol ?? "units"} one ${ta?.symbol ?? "unit"} is worth. Liquidity added later is placed around it.`, `1 个 ${ta?.symbol ?? "单位"} 值多少 ${tb?.symbol ?? "单位"}。之后添加的流动性会围绕这个价格分布。`)}
              >
                <span className="token-tag">{tb && <TokenDisc token={tb} size={20} />}{tb?.symbol}</span>
              </AmountField>
            </section>
          </>
        )}

        {exists && (
          <p className="notice good" style={{ margin: 0 }}>
            <span>
              {t("This pool exists at", "该资金池已存在，地址")} <a href={explorerAddress(exists)} target="_blank" rel="noreferrer" className="mono">{exists.slice(0, 10)}…</a>{t(".", "。")}{" "}
              <Link to="/app/pools/$pool/add" params={{ pool: exists }}>{t("Add liquidity to it", "向它添加流动性")}</Link>
            </span>
          </p>
        )}
        <WalletAction verb={t("create a pool", "创建资金池")}>
          <button className="btn btn-primary btn-block" disabled={Boolean(blocker) || tx.busy} onClick={create}>{tx.busy ? t("Check your wallet…", "请在钱包中确认…") : blocker ?? (kind === "damm" ? t("Create DAMM pool", "创建 DAMM 资金池") : t("Create DLMM pair", "创建 DLMM 交易对"))}</button>
        </WalletAction>
        <TxStatus phase={tx.phase} />
      </div>
      <div className="panel stack">
        <p className="eyebrow" style={{ margin: 0 }}>{t("Before you create", "创建之前")}</p>
        <ul className="checklist small">
          <li>{t("Anyone can create a pool from admitted assets. Creation is not an endorsement and Curveil does not review new pools.", "任何人都可以用准入资产创建资金池。创建并不代表认可，Curveil 也不会审核新资金池。")}</li>
          <li>{t("Creating a pool adds no liquidity. Add liquidity next, or the pool cannot trade.", "创建资金池不会添加流动性。接下来请添加流动性，否则资金池无法交易。")}</li>
          <li>{t("Fee settings are fixed when the pool is created.", "费率设置在资金池创建时固定。")} {kind === "dlmm" ? t("A different bin step makes a separate pair.", "不同的区间步长会形成单独的交易对。") : t("There is one DAMM pool per pair.", "每个交易对只有一个 DAMM 资金池。")}</li>
          {protoBps !== undefined && <li>{t(`Every fee is split ${100 - protoBps / 100}% to liquidity providers and ${protoBps / 100}% to the protocol.`, `每笔手续费中 ${100 - protoBps / 100}% 分给流动性提供者，${protoBps / 100}% 分给协议。`)}</li>}
        </ul>
      </div>
    </div>
  );
}
