/**
 * Shielded perps. A position opened from vault notes is owned by the ShieldedPerpsAdapter and
 * backed by a claim note (one unit of shareResource(adapter, claimId)) in this browser. Spending
 * the claim note is the only way to close, add margin, place or cancel orders, or collect what
 * the engine paid out; a liquidated or closed position leaves only what was already paid.
 *
 * The broadcaster's fee comes from a USDG note: on the input leg for an open or added margin,
 * from the collected USDG for a collection, and from a small USDG "fee leg" (1 base unit goes
 * through the adapter and comes back as a note) for a close or an order change.
 */
import { useMemo, useState } from "react";
import { Loading } from "./Skeleton";
import { useReadContract } from "wagmi";
import {
  CLAIM_UNITS,
  encodePerpAddCollateral,
  encodePerpCancelOrder,
  encodePerpClose,
  encodePerpCollect,
  encodePerpOpen,
  encodePerpPlaceOrder,
  newClaimId,
  shareResource,
} from "@curveil/vault-core";
import { formatUnits, getAddress, type Abi, type Address, type Hex } from "viem";
import perpsAdapterAbiJson from "@curveil/manifest/abis/ShieldedPerpsAdapter.json";
import { Exposure, ModePicker, VaultSubmit, senderExposure, useBroadcaster, useMode, useVaultAction, type Mode } from "./VaultAction";
import { AmountField } from "./WalletAction";
import { CloseControls, OrderFields, OrderList, PositionSkeleton, PositionSummary, fmtUsdg, useOrderForm, USDG_SYMBOL } from "../routes/Perps";
import { curveilChain, QUOTE } from "../lib/config";
import { fmtAmount, parseAmount } from "../lib/format";
import { feeFor, pickFeeToken } from "../lib/vault/actions";
import { adapterAddress, prepareExecution, type ExecLeg } from "../lib/vault/execute";
import { balances, type VaultState, type VaultStatus } from "../lib/vault/store";
import {
  SLIPPAGES_BPS,
  USDG_DECIMALS,
  acceptablePrice,
  claimResources,
  kickKeeper,
  usePerpClaims,
  usePerpPosition,
  wad,
  type ApiClaim,
  type PerpMarket,
  type PerpsOverview,
} from "../lib/perps";

const adapterAbi = perpsAdapterAbiJson as Abi;
const same = (a: string, b: string) => getAddress(a) === getAddress(b);

function usdgAsset(status: VaultStatus) {
  const q = QUOTE;
  return q ? status.assets.find((a) => same(a.address, q.address)) : undefined;
}

const USDG_TOK = QUOTE ? { address: QUOTE.address as Address, symbol: QUOTE.symbol, decimals: QUOTE.decimals } : null;

/** Fee terms for one form: which mode, and the fee if the broadcaster submits. */
function useFee(available: bigint) {
  const b = useBroadcaster();
  const feeToken = USDG_TOK ? pickFeeToken(b.info, [{ address: USDG_TOK.address, available }]) : null;
  const [mode, setMode] = useMode(b, feeToken !== null);
  const fee = mode === "broadcaster" ? (feeFor(b.info, "execute", feeToken) ?? 0n) : 0n;
  const problem = mode !== "broadcaster" || feeToken
    ? null
    : b.info
      ? "The broadcaster cannot take its fee from these notes. Submit from your wallet."
      : "Loading the broadcaster's terms…";
  return { b, feeToken, mode, setMode, fee, problem };
}

// ------------------------------------------------------------------ open

export function ShieldedPerpOpen({ status, market, isLong, size, collateral, acceptable, execFee, blocked, onDone }: {
  status: VaultStatus;
  market: PerpMarket;
  isLong: boolean;
  size: bigint;
  collateral: bigint;
  acceptable: bigint;
  execFee: bigint;
  blocked: string | null;
  onDone: () => void;
}) {
  const act = useVaultAction();
  const adapter = adapterAddress(status, "ShieldedPerpsAdapter");
  const asset = usdgAsset(status);
  const spendable = asset ? balances(asset.resource).spendable : 0n;
  const need = collateral + execFee;
  const f = useFee(spendable > need ? spendable - need : 0n);
  const problem = !adapter || adapter.status !== "active"
    ? "Shielded perps are closed on this network right now."
    : !asset
      ? `${USDG_SYMBOL} is not held in the vault.`
      : f.problem;
  // Not enough vault balance shows on the button, not as a separate notice.
  const short = need > 0n && need + f.fee > spendable;

  function go() {
    if (!adapter || !asset || problem || blocked || short) return;
    const claimId = newClaimId();
    const params = encodePerpOpen({ claimId, market: market.id, isLong, size, collateral, acceptablePrice: acceptable, executionFee: execFee });
    void act
      .run({
        status,
        action: "execute",
        label: `Shielded ${isLong ? "long" : "short"} ${market.symbol}, ${fmtUsdg(size)} ${USDG_SYMBOL}`,
        mode: f.mode,
        feeToken: f.feeToken,
        prove: async (fee, fr, onStage) => {
          const r = await prepareExecution({
            status,
            adapter: adapter.address,
            params,
            legs: [{ resource: asset.resource, amount: need, fee }],
            outputs: [{ kind: "note", to: "self", resource: shareResource(adapter.address, claimId) }],
            feeRecipient: fr,
            onStage,
          });
          return r.ready;
        },
      })
      .then((ok) => ok && onDone());
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <ModePicker mode={f.mode} onMode={f.setMode} b={f.b} action="execute" feeToken={USDG_TOK} />
      <Exposure
        pub={["The market, side, size, collateral and price limit (the engine's events show them)", "That the shielded adapter owns the position", ...senderExposure(f.mode)]}
        priv={["Which vault account holds the position", "Which of your notes paid for it", "Where the proceeds go when you collect them"]}
      />
      {problem && <p className="notice warn small" style={{ margin: 0 }}>{problem}</p>}
      <VaultSubmit mode={f.mode} act={act} disabled={Boolean(blocked) || Boolean(problem) || short} onClick={go}>
        {blocked ?? (short ? `Not enough ${USDG_SYMBOL} in your vault` : `Prove and ${isLong ? "long" : "short"} ${market.base}`)}
      </VaultSubmit>
    </div>
  );
}

// ------------------------------------------------------------------ claims

type OwnedClaim = ApiClaim & { resource: string; spendable: bigint; spending: bigint };

export function ShieldedPerpPositions({ v, status, o }: { v: VaultState; status: VaultStatus; o: PerpsOverview }) {
  const adapter = adapterAddress(status, "ShieldedPerpsAdapter");
  const claims = usePerpClaims(Boolean(adapter));
  const owned = useMemo(() => {
    const byResource = claimResources(claims.data, adapter?.address, shareResource);
    const out: OwnedClaim[] = [];
    const seen = new Set<string>();
    for (const n of v.notes) {
      if (n.spent || n.amount === "0" || seen.has(n.resource)) continue;
      const c = byResource.get(n.resource);
      if (!c) continue;
      seen.add(n.resource);
      const b = balances(n.resource);
      out.push({ ...c, resource: n.resource, spendable: b.spendable, spending: b.spending });
    }
    return out.sort((a, b) => b.blockNumber - a.blockNumber);
  }, [claims.data, v.notes, adapter?.address]);

  return (
    <div className="panel stack shielded-panel">
      <div className="row-between">
        <p className="eyebrow" style={{ margin: 0 }}>Your shielded positions</p>
        <span className="tag tag-shielded">Shielded</span>
      </div>
      {claims.isLoading && <><Loading label="Loading your shielded positions" /><PositionSkeleton shielded /></>}
      {claims.isError && <p className="notice bad" role="alert">Claims could not be listed. Your claim notes are safe; try again shortly.</p>}
      {claims.isSuccess && owned.length === 0 && (
        <p className="small muted" style={{ margin: 0 }}>No claim notes in this vault account. A new position's claim appears once the indexer lists it, usually within a minute.</p>
      )}
      {adapter && owned.map((c) => <ClaimCard key={c.claimId} c={c} status={status} o={o} adapter={adapter.address} />)}
    </div>
  );
}

type ClaimAction = "close" | "margin" | "orders";

function ClaimCard({ c, status, o, adapter }: { c: OwnedClaim; status: VaultStatus; o: PerpsOverview; adapter: Address }) {
  const live = usePerpPosition(c.positionId);
  const collectable = useReadContract({
    address: adapter,
    abi: adapterAbi,
    functionName: "collectable",
    args: [BigInt(c.claimId)],
    chainId: curveilChain.id,
    query: { refetchInterval: 8_000 },
  });
  const [action, setAction] = useState<ClaimAction | null>(null);
  // Forms stay mounted while their own action settles, so its status stays visible.
  const [collecting, setCollecting] = useState(false);
  const p = live.data?.position;
  const m = p ? o.markets.find((x) => x.id === p.market) : undefined;
  const owed = (collectable.data as bigint | undefined) ?? 0n;
  const isLive = p?.status === "open" || p?.status === "pending";
  const orders = (live.data?.orders ?? []).filter((x) => x.status === "active");
  if (!p) return <PositionSkeleton shielded />;
  return (
    <div className="panel stack perp-position">
      <PositionSummary p={p} m={m} tag={<span className="tag tag-shielded">Shielded</span>} />
      {c.spending > 0n && <p className="small muted" style={{ margin: 0 }}>An action on this claim is in flight.</p>}
      {(owed > 0n || collecting) && <CollectForm c={c} status={status} adapter={adapter} owed={owed} keep={isLive} onStart={() => setCollecting(true)} />}
      {!isLive && owed === 0n && !collecting && <p className="small muted" style={{ margin: 0 }}>Nothing left to collect. The claim note no longer backs anything.</p>}
      {p.status === "open" && m && (
        <>
          <div className="seg" role="group" aria-label="Position action" style={{ marginTop: 0 }}>
            <button type="button" aria-pressed={action === "close"} onClick={() => setAction(action === "close" ? null : "close")}>
              {p.pendingClose !== "0" ? "Closing…" : "Close"}
            </button>
            <button type="button" aria-pressed={action === "margin"} onClick={() => setAction(action === "margin" ? null : "margin")}>Add margin</button>
            <button type="button" aria-pressed={action === "orders"} onClick={() => setAction(action === "orders" ? null : "orders")}>
              TP / SL{orders.length ? ` (${orders.length})` : ""}
            </button>
          </div>
          {action === "close" && <ClaimClose c={c} status={status} adapter={adapter} m={m} o={o} />}
          {action === "margin" && <ClaimMargin c={c} status={status} adapter={adapter} />}
          {action === "orders" && <ClaimOrders c={c} status={status} adapter={adapter} m={m} o={o} orders={orders} />}
        </>
      )}
    </div>
  );
}

/**
 * Runs one claim action: the claim leg, an optional USDG leg (margin, or the 1-unit fee leg when
 * the broadcaster submits), and outputs in the adapter's order.
 */
function useClaimAction(status: VaultStatus, c: OwnedClaim, adapter: Address, usdgIn: bigint, kind: "margin" | "plain") {
  const act = useVaultAction();
  const asset = usdgAsset(status);
  const spendable = asset ? balances(asset.resource).spendable : 0n;
  const reserve = kind === "margin" ? usdgIn : 1n;
  const f = useFee(spendable > reserve ? spendable - reserve : 0n);
  const short = asset && (kind === "margin" ? usdgIn + f.fee : f.fee > 0n ? 1n + f.fee : 0n) > spendable;
  const problem = !asset
    ? `${USDG_SYMBOL} is not held in the vault.`
    : c.spendable < CLAIM_UNITS
      ? "Waiting for the last action on this position to settle."
      : short
        ? `Not enough spendable vault ${USDG_SYMBOL}${f.mode === "broadcaster" ? " for the broadcaster fee" : ""}.`
        : f.problem;

  function run(label: string, params: Hex, onDone?: () => void) {
    if (!asset || problem) return;
    void act
      .run({
        status,
        action: "execute",
        label,
        mode: f.mode,
        feeToken: f.feeToken,
        prove: async (fee, fr, onStage) => {
          const legs: ExecLeg[] = [{ resource: c.resource, amount: CLAIM_UNITS, fee: 0n }];
          const usdgLeg = kind === "margin" ? usdgIn : fee > 0n ? 1n : 0n;
          if (usdgLeg > 0n) legs.push({ resource: asset.resource, amount: usdgLeg, fee });
          const outputs: Parameters<typeof prepareExecution>[0]["outputs"] = [{ kind: "note", to: "self", resource: BigInt(c.resource) }];
          if (kind === "plain" && usdgLeg > 0n) outputs.push({ kind: "note", to: "self", resource: BigInt(asset.resource) });
          const r = await prepareExecution({ status, adapter, params, legs, outputs, feeRecipient: fr, onStage });
          return r.ready;
        },
      })
      .then((ok) => {
        if (ok) {
          kickKeeper();
          onDone?.();
        }
      });
  }
  return { act, f, problem, run };
}

function ClaimFooter({ a, disabled, label, onClick, mode }: { a: ReturnType<typeof useClaimAction>; disabled: boolean; label: string; onClick: () => void; mode: Mode }) {
  return (
    <>
      <ModePicker mode={a.f.mode} onMode={a.f.setMode} b={a.f.b} action="execute" feeToken={USDG_TOK} />
      {a.problem && <p className="notice warn small" style={{ margin: 0 }}>{a.problem}</p>}
      <VaultSubmit mode={mode} act={a.act} disabled={disabled || Boolean(a.problem)} onClick={onClick}>{label}</VaultSubmit>
    </>
  );
}

function ClaimClose({ c, status, adapter, m, o }: { c: OwnedClaim; status: VaultStatus; adapter: Address; m: PerpMarket; o: PerpsOverview }) {
  const live = usePerpPosition(c.positionId).data?.position;
  const a = useClaimAction(status, c, adapter, 0n, "plain");
  const [pct, setPct] = useState(100);
  const [slippage, setSlippage] = useState<number>(SLIPPAGES_BPS[1]);
  const mark = wad(m.markPrice);
  const size = live ? (BigInt(live.size) * BigInt(pct)) / 100n : 0n;
  const limit = mark && live ? acceptablePrice(mark, !live.isLong, slippage) : null;
  const execFee = BigInt(o.params.minExecutionFee);
  const closing = live ? live.pendingClose !== "0" : false;
  return (
    <CloseControls pct={pct} setPct={setPct} slippage={slippage} setSlippage={setSlippage} size={size} limit={limit} execFee={execFee} closeFeeBps={m.config?.closeFeeBps}>
      <p className="small muted" style={{ margin: 0 }}>Proceeds stay with the claim until you collect them into a new note.</p>
      <ClaimFooter
        a={a}
        mode={a.f.mode}
        disabled={!limit || size === 0n || closing}
        label={closing ? "Waiting for the keeper…" : `Prove and close ${pct}%`}
        onClick={() => limit && a.run(`Close ${pct}% of shielded ${m.symbol}`, encodePerpClose({ claimId: BigInt(c.claimId), size, acceptablePrice: limit, executionFee: execFee }))}
      />
    </CloseControls>
  );
}

function ClaimMargin({ c, status, adapter }: { c: OwnedClaim; status: VaultStatus; adapter: Address }) {
  const [input, setInput] = useState("");
  const amount = parseAmount(input, USDG_DECIMALS) ?? 0n;
  const a = useClaimAction(status, c, adapter, amount, "margin");
  const asset = usdgAsset(status);
  const spendable = asset ? balances(asset.resource).spendable : 0n;
  return (
    <div className="stack">
      <AmountField label="Add collateral" value={input} onChange={setInput} symbol={USDG_SYMBOL} decimals={USDG_DECIMALS} balance={fmtAmount(spendable, USDG_DECIMALS)} balanceLabel="Vault" onMax={() => setInput(formatUnits(spendable, USDG_DECIMALS))}>
        <span className="token-tag">{USDG_SYMBOL}</span>
      </AmountField>
      <ClaimFooter a={a} mode={a.f.mode} disabled={amount === 0n} label="Prove and add margin" onClick={() => a.run(`Add ${fmtUsdg(amount)} ${USDG_SYMBOL} margin`, encodePerpAddCollateral(BigInt(c.claimId)))} />
    </div>
  );
}

function ClaimOrders({ c, status, adapter, m, o, orders }: { c: OwnedClaim; status: VaultStatus; adapter: Address; m: PerpMarket; o: PerpsOverview; orders: Parameters<typeof OrderList>[0]["orders"] }) {
  const live = usePerpPosition(c.positionId).data?.position;
  const a = useClaimAction(status, c, adapter, 0n, "plain");
  const form = useOrderForm(live!, m, o);
  if (!live) return null;
  const claimId = BigInt(c.claimId);
  return (
    <div className="stack">
      <OrderList orders={orders} busy={a.act.busy} onCancel={(id) => a.run("Cancel shielded order", encodePerpCancelOrder(claimId, BigInt(id)))} />
      <OrderFields form={form} />
      <ClaimFooter
        a={a}
        mode={a.f.mode}
        disabled={!form.ready}
        label={form.problem ?? `Prove and place ${form.kindLabel}`}
        onClick={() => a.run(`Place shielded ${form.kindLabel}`, encodePerpPlaceOrder({ claimId, ...form.body }), form.reset)}
      />
    </div>
  );
}

function CollectForm({ c, status, adapter, owed, keep, onStart }: { c: OwnedClaim; status: VaultStatus; adapter: Address; owed: bigint; keep: boolean; onStart: () => void }) {
  const act = useVaultAction();
  const asset = usdgAsset(status);
  const f = useFee(owed);
  const problem = !asset
    ? `${USDG_SYMBOL} is not held in the vault.`
    : owed === 0n
      ? null
      : c.spendable < CLAIM_UNITS
        ? "Waiting for the last action on this position to settle."
        : f.mode === "broadcaster" && !f.feeToken && f.b.info
          ? "Too little to pay the broadcaster. Submit from your wallet."
          : f.problem;
  function go() {
    if (!asset || problem || owed === 0n) return;
    onStart();
    void act.run({
      status,
      action: "execute",
      label: `Collect ${fmtUsdg(owed)} ${USDG_SYMBOL} from a shielded position`,
      mode: f.mode,
      feeToken: f.feeToken,
      prove: async (fee, fr, onStage) => {
        const usdgOut = { kind: "note" as const, to: "self" as const, resource: BigInt(asset.resource), fee };
        const r = await prepareExecution({
          status,
          adapter,
          params: encodePerpCollect(BigInt(c.claimId), keep),
          legs: [{ resource: c.resource, amount: CLAIM_UNITS, fee: 0n }],
          outputs: keep ? [{ kind: "note", to: "self", resource: BigInt(c.resource) }, usdgOut] : [usdgOut],
          feeRecipient: fr,
          onStage,
        });
        return r.ready;
      },
    });
  }
  if (owed === 0n) {
    return (
      <VaultSubmit mode={f.mode} act={act} disabled onClick={go}>Collected</VaultSubmit>
    );
  }
  return (
    <div className="stack">
      <div className="notice good">
        <span className="dot good" style={{ marginTop: 7 }} aria-hidden="true" />
        <span>{fmtUsdg(owed)} {USDG_SYMBOL} is ready to collect into a new vault note{keep ? "; the position stays open" : ""}.</span>
      </div>
      <ModePicker mode={f.mode} onMode={f.setMode} b={f.b} action="execute" feeToken={USDG_TOK} />
      <Exposure pub={["How much the position paid out (the engine's events show it)", ...senderExposure(f.mode)]} priv={["Which vault account receives it", "The new note"]} />
      {problem && <p className="notice warn small" style={{ margin: 0 }}>{problem}</p>}
      <VaultSubmit mode={f.mode} act={act} disabled={Boolean(problem)} onClick={go}>Prove and collect</VaultSubmit>
    </div>
  );
}

export type { ExecLeg };
