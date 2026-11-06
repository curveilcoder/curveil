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

const TIER_IDS = [0, 1, 2, 3] as const;
const TIER_NAMES = ["Standard", "Volatile", "Tier 2", "Tier 3"];
const ADMITTED = manifest.assets.map((a) => ({ address: a.address as `0x${string}`, symbol: a.symbol, decimals: a.decimals, name: a.name ?? null, logo: a.logo ?? null }));
// Pools hold WETH, not plain ETH, but ETH is what people look for: it is offered too and stands for WETH.
const PICKABLE = ETH ? [ETH, ...ADMITTED] : ADMITTED;
const onChain = (x: `0x${string}` | undefined) => (isNative(x) ? WETH : x);

/** Create a public pool from an admitted pair and a configuration the factory allows. Adds no liquidity. */
export function CreatePool() {
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
        ? await tx.run([{ label: "Create DAMM pool", params: { address: DAMM_FACTORY!, abi: dammFactoryAbi, functionName: "createPool", args: [a, b, tier], chainId: curveilChain.id } }])
        : await tx.run([{ label: "Create DLMM pair", params: { address: DLMM_FACTORY!, abi: dlmmFactoryAbi, functionName: "createPair", args: [a, b, binStep!, activeId!], chainId: curveilChain.id } }]);
    if (receipt) {
      const r = await existing.refetch();
      qc.invalidateQueries({ queryKey: ["markets"] });
      // The pool cannot trade until it has liquidity: go straight to adding it.
      if (r.data && r.data !== zeroAddress) markCreated(r.data);
      if (r.data && r.data !== zeroAddress) navigate({ to: "/pools/$pool/add", params: { pool: r.data } });
    }
  }

  const blocker = !ta || !tb
    ? "Select two assets"
    : same(a, b)
      ? isNative(pickA) !== isNative(pickB) ? "ETH and WETH are the same asset here: pick another one" : "Pick two different assets"
      : exists
        ? kind === "damm" ? "A DAMM pool already exists for this pair" : "A pair with this bin step already exists"
        : kind === "dlmm" && binStep === null
          ? "No bin step is enabled"
          : kind === "dlmm" && activeId === null
            ? "Enter a starting price"
            : kind === "dlmm" && !priceInRange
              ? "That starting price is out of range"
            : kind === "damm" && !tiersRead
              ? tiers.isPending ? "Reading fee tiers…" : "Could not read the fee tiers. Refresh the page"
            : kind === "damm" && !enabledTiers.some((t) => t.id === tier)
              ? "This fee tier is not enabled"
              : null;

  return (
    <div className="add-layout">
      <div className="panel stack">
        <section className="form-step">
        <div className="form-step-head"><span className="step-n">01</span><h3>Pool type</h3></div>
        <div className="choice-grid" role="group" aria-label="Pool type">
          <button type="button" className="choice" aria-pressed={kind === "dlmm"} onClick={() => setKind("dlmm")}>
            <strong>DLMM pair</strong><span>Liquidity sits in price bins that providers choose. Best for focused ranges.</span>
          </button>
          <button type="button" className="choice" aria-pressed={kind === "damm"} onClick={() => setKind("damm")}>
            <strong>DAMM pool</strong><span>Full-range liquidity with a fee that rises when the price is volatile.</span>
          </button>
        </div>
        </section>
        <section className="form-step">
        <div className="form-step-head"><span className="step-n">02</span><h3>Assets</h3></div>
        <div className="grid-2" style={{ gap: 12 }}>
          <div className="field">
            <span className="small muted">Base asset</span>
            <TokenPicker wide tokens={PICKABLE} value={ta} onChange={setA} label="Base asset" />
          </div>
          <div className="field">
            <span className="small muted">Quote asset</span>
            <TokenPicker wide tokens={PICKABLE} value={tb} onChange={setB} label="Quote asset" />
          </div>
        </div>
        {(isNative(pickA) || isNative(pickB)) && <p className="small muted" style={{ margin: 0 }}>The pool holds ETH as WETH. When you add liquidity or swap, your ETH is wrapped for you.</p>}
        </section>

        {kind === "damm" ? (
          <section className="form-step">
            <div className="form-step-head"><span className="step-n">03</span><h3>Fee tier</h3><p>Fixed for the life of the pool. The fee starts at the base rate and rises toward the maximum while the price is volatile. The first deposit sets the starting price.</p></div>
            <div className="choice-grid" role="group" aria-label="Fee tier">
              {enabledTiers.map((t) => (
                <button key={t.id} type="button" className="choice" aria-pressed={tier === t.id} onClick={() => setTier(t.id)}>
                  <strong>{TIER_NAMES[t.id]}</strong><span>{t.baseFeeBps / 100}% rising to {t.maxFeeBps / 100}%</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="form-step">
              <div className="form-step-head"><span className="step-n">03</span><h3>Bin step</h3><p>Fixed for the life of the pair. Smaller bins suit stable prices; larger bins suit volatile ones.</p></div>
              <div className="choice-grid" role="group" aria-label="Bin step">
                {enabledSteps.map((s) => (
                  <button key={s.binStep} type="button" className="choice" aria-pressed={binStep === s.binStep} onClick={() => setStep(s.binStep)}>
                    <strong>{(s.binStep / 100).toFixed(2)}% bins</strong><span>{s.baseFeeBps / 100}% fee per trade</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="form-step">
              <div className="form-step-head"><span className="step-n">04</span><h3>Starting price</h3></div>
              <AmountField
                label={`${tb?.symbol ?? ""} per 1 ${ta?.symbol ?? ""}`}
                value={price}
                onChange={setPrice}
                hint={binP !== null ? (
                  <>
                    {/* Both ways, so a price typed for the wrong side stands out before it is fixed on-chain. */}
                    <span className="mono">1 {ta?.symbol} = {fmtPrice(binP)} {tb?.symbol}</span> · <span className="mono">1 {tb?.symbol} = {fmtPrice(1 / binP)} {ta?.symbol}</span>
                    <br />
                    Opens in bin <span className="mono">{activeId?.toLocaleString("en-US")}</span>, the nearest bin price not above yours. Check it against the market price: it cannot be changed once the pair exists.
                  </>
                ) : `How many ${tb?.symbol ?? "units"} one ${ta?.symbol ?? "unit"} is worth. Liquidity added later is placed around it.`}
              >
                <span className="token-tag">{tb && <TokenDisc token={tb} size={20} />}{tb?.symbol}</span>
              </AmountField>
            </section>
          </>
        )}

        {exists && (
          <p className="notice good" style={{ margin: 0 }}>
            <span>
              This pool exists at <a href={explorerAddress(exists)} target="_blank" rel="noreferrer" className="mono">{exists.slice(0, 10)}…</a>.{" "}
              <Link to="/pools/$pool/add" params={{ pool: exists }}>Add liquidity to it</Link>
            </span>
          </p>
        )}
        <WalletAction verb="create a pool">
          <button className="btn btn-primary btn-block" disabled={Boolean(blocker) || tx.busy} onClick={create}>{tx.busy ? "Check your wallet…" : blocker ?? (kind === "damm" ? "Create DAMM pool" : "Create DLMM pair")}</button>
        </WalletAction>
        <TxStatus phase={tx.phase} />
      </div>
      <div className="panel stack">
        <p className="eyebrow" style={{ margin: 0 }}>Before you create</p>
        <ul className="checklist small">
          <li>Anyone can create a pool from admitted assets. Creation is not an endorsement and Curveil does not review new pools.</li>
          <li>Creating a pool adds no liquidity. Add liquidity next, or the pool cannot trade.</li>
          <li>Fee settings are fixed when the pool is created. {kind === "dlmm" ? "A different bin step makes a separate pair." : "There is one DAMM pool per pair."}</li>
          {protoBps !== undefined && <li>Every fee is split {100 - protoBps / 100}% to liquidity providers and {protoBps / 100}% to the protocol.</li>}
        </ul>
      </div>
    </div>
  );
}
