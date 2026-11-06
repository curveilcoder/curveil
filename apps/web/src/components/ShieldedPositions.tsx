/**
 * Shielded liquidity positions held as share notes: what each is worth now, exits back to
 * vault notes or to a public address, and private transfers of the shares.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Loading, Sk } from "./Skeleton";
import { Link } from "@tanstack/react-router";
import { useReadContract } from "wagmi";
import { decodeAddress, encodeExit, isShieldedAddress, type Recipient } from "@curveil/vault-core";
import { getAddress, isAddress, zeroAddress, type Abi } from "viem";
import liquidityAdapterAbiJson from "@curveil/manifest/abis/ShieldedLiquidityAdapter.json";
import { Exposure, ModePicker, VaultSubmit, senderExposure, useBroadcaster, useMode, useVaultAction } from "./VaultAction";
import { TokenPair } from "./TokenPair";
import { useMarkets, pairLabel, kindLabel, type MarketPool } from "../lib/markets";
import { curveilChain, shortAddress } from "../lib/config";
import { fmtAmount, fmtBps, withSlippage } from "../lib/format";
import { feeFor, pickFeeToken, prepareTransfer, readyTransfer } from "../lib/vault/actions";
import { prepareExecution } from "../lib/vault/execute";
import { ownedPositions, positionLabel, usePositionList, type OwnedPosition } from "../lib/vault/positions";
import { vaultKeys, type VaultState, type VaultStatus } from "../lib/vault/store";
import { shareResource as shareRes } from "@curveil/vault-core";
import { PERPS_ADAPTER, claimResources, usePerpClaims } from "../lib/perps";

const adapterAbi = liquidityAdapterAbiJson as Abi;
const EXIT_SLIPPAGE_BPS = 50;

/** Units are 1e18 per whole position. */
export const unitsPct = (units: bigint, total: bigint) => (total === 0n ? "0" : fmtAmount((units * 10n ** 20n) / total, 18, 2));

export function ShieldedPositions({ v, status, empty, heading }: { v: VaultState; status: VaultStatus; empty?: ReactNode; heading?: ReactNode }) {
  const list = usePositionList(true);
  const markets = useMarkets();
  const claims = usePerpClaims(true);
  const claimRes = useMemo(() => claimResources(claims.data, PERPS_ADAPTER, shareRes), [claims.data]);
  const { owned, unmatched } = useMemo(() => ownedPositions(list.data, v.notes, status, claimRes), [list.data, v.notes, status, claimRes]);
  if (list.isError) return <p className="notice bad" role="alert">Shielded positions could not be listed. Your share notes are safe; try again shortly.</p>;
  if (list.isLoading) {
    return (
      <div className="stack" aria-busy="true">
        <Loading label="Loading shielded positions" />
        {heading}
        <div className="grid-2">
          <div className="panel stack shielded-panel" aria-hidden="true">
            <div className="row-between">
              <span className="pool-link"><Sk w={28} h={28} style={{ borderRadius: "50%" }} /><Sk w="10ch" /></span>
              <span className="tag tag-shielded">Shielded</span>
            </div>
            <dl className="kv">
              {["Position", "Your share", "Worth now, with fees"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="9ch" /></dd></div>)}
            </dl>
          </div>
        </div>
      </div>
    );
  }
  if (owned.length === 0 && unmatched === 0) return <>{empty ?? null}</>;
  return (
    <div className="stack">
      {heading}
      {unmatched > 0 && <p className="small muted" style={{ margin: 0 }}>{unmatched} share note{unmatched > 1 ? "s are" : " is"} waiting for the indexer to list its position.</p>}
      <div className="grid-2">
        {owned.map((p) => (
          <PositionCard key={p.positionId} p={p} status={status} pool={markets.data?.find((m) => getAddress(m.address) === getAddress(p.market))} />
        ))}
      </div>
    </div>
  );
}

type Action = "exit" | "send";

function PositionCard({ p, status, pool }: { p: OwnedPosition; status: VaultStatus; pool: MarketPool | undefined }) {
  const [open, setOpen] = useState<Action | null>(null);
  const total = BigInt(p.remainingUnits);
  const preview = useReadContract({
    address: p.adapter,
    abi: adapterAbi,
    functionName: "previewExit",
    args: [p.id, p.spendable],
    chainId: curveilChain.id,
    query: { enabled: p.spendable > 0n, refetchInterval: 15_000 },
  });
  const [out0, out1] = (preview.data as readonly [bigint, bigint] | undefined) ?? [0n, 0n];
  const adapter = status.adapters?.find((a) => getAddress(a.address) === getAddress(p.adapter));
  return (
    <div className="panel stack shielded-panel">
      <div className="row-between">
        {pool ? (
          <Link to="/pools/$pool" params={{ pool: pool.address }} className="pool-link">
            <TokenPair pool={pool} size={28} />
            <strong>{pairLabel(pool)}</strong>
          </Link>
        ) : (
          <strong className="mono">{shortAddress(p.market)}</strong>
        )}
        <span className="row-between" style={{ gap: 6 }}>
          <span className="tag tag-shielded">Shielded</span>
          <span className="tag tag-public">{pool ? kindLabel(pool) : p.kind.toUpperCase()}</span>
        </span>
      </div>
      <dl className="kv">
        <div><dt>Position</dt><dd className="mono small">{positionLabel(p)}</dd></div>
        <div><dt>Your share</dt><dd className="mono">{unitsPct(p.spendable, total)}%{p.spending > 0n ? <span className="muted"> ({unitsPct(p.spending, total)}% being spent)</span> : null}</dd></div>
        {pool && (
          <div>
            <dt>Worth now, with fees</dt>
            <dd className="mono small">
              {preview.isLoading ? <><Sk w="12ch" /><br /><Sk w="10ch" /></> : <>{fmtAmount(out0, pool.token0.decimals, 6)} {pool.token0.symbol}<br />{fmtAmount(out1, pool.token1.decimals, 6)} {pool.token1.symbol}</>}
            </dd>
          </div>
        )}
      </dl>
      {p.spendable > 0n && (
        <div className="seg" role="group" aria-label="Position actions" style={{ marginTop: 0 }}>
          <button aria-pressed={open === "exit"} onClick={() => setOpen(open === "exit" ? null : "exit")}>Exit</button>
          <button aria-pressed={open === "send"} onClick={() => setOpen(open === "send" ? null : "send")}>Send shares privately</button>
        </div>
      )}
      {adapter?.status === "exit_only" && <p className="small muted" style={{ margin: 0 }}>New entries are closed for this adapter; exits stay open.</p>}
      {open === "exit" && pool && <ExitForm p={p} status={status} pool={pool} />}
      {open === "exit" && !pool && <p className="small muted" style={{ margin: 0 }}>Loading the market…</p>}
      {open === "send" && <SendSharesForm p={p} status={status} />}
    </div>
  );
}

function ExitForm({ p, status, pool }: { p: OwnedPosition; status: VaultStatus; pool: MarketPool }) {
  const [pct, setPct] = useState(100);
  const [dest, setDest] = useState<"notes" | "public">("notes");
  const [to, setTo] = useState("");
  const b = useBroadcaster();
  const act = useVaultAction();
  const units = (p.spendable * BigInt(pct)) / 100n;
  const preview = useReadContract({
    address: p.adapter,
    abi: adapterAbi,
    functionName: "previewExit",
    args: [p.id, units],
    chainId: curveilChain.id,
    query: { enabled: units > 0n, refetchInterval: 10_000 },
  });
  const [out0, out1] = (preview.data as readonly [bigint, bigint] | undefined) ?? [0n, 0n];
  const tokens = [pool.token0, pool.token1];
  const assets = tokens.map((t) => status.assets.find((a) => getAddress(a.address) === getAddress(t.address)));
  const feeToken = pickFeeToken(b.info, [
    { address: pool.token0.address, available: out0 },
    { address: pool.token1.address, available: out1 },
  ]);
  const feeTok = tokens.find((t) => feeToken && getAddress(t.address) === getAddress(feeToken)) ?? null;
  const [mode, setMode] = useMode(b, feeToken !== null);
  const fee = mode === "broadcaster" ? (feeFor(b.info, "execute", feeToken) ?? 0n) : 0n;
  const recipient = dest === "public" && isAddress(to) ? getAddress(to) : null;
  const problem =
    assets.some((a) => !a)
      ? "One of this market's tokens is not a vault asset, so the exit cannot settle."
      : dest === "public" && to && !recipient
        ? "Enter a valid public address (0x…)."
        : mode === "broadcaster" && !feeToken
          ? "The broadcaster cannot take its fee from this exit. Submit from your wallet."
          : null;

  function go() {
    if (units === 0n || problem || preview.data === undefined || (dest === "public" && !recipient)) return;
    const params = encodeExit({ positionId: p.id, min0: withSlippage(out0, EXIT_SLIPPAGE_BPS), min1: withSlippage(out1, EXIT_SLIPPAGE_BPS) });
    void act.run({
      status,
      action: "execute",
      label: `Exit ${pct}% of a shielded ${pairLabel(pool)} position${dest === "public" ? ` to ${shortAddress(recipient!)}` : ""}`,
      mode,
      feeToken,
      prove: async (f, fr, onStage) => {
        const outputs = tokens.map((t, i) => {
          const fee = feeToken && getAddress(t.address) === getAddress(feeToken) ? f : 0n;
          return dest === "public"
            ? ({ kind: "public", recipient: recipient!, fee } as const)
            : ({ kind: "note", to: "self", resource: BigInt(assets[i]!.resource), fee } as const);
        });
        const r = await prepareExecution({ status, adapter: p.adapter, params, legs: [{ resource: p.resource, amount: units, fee: 0n }], outputs, feeRecipient: fr, onStage });
        return r.ready;
      },
    });
  }

  const net = (x: bigint, t: (typeof tokens)[number]) => {
    const afterFee = feeTok && getAddress(feeTok.address) === getAddress(t.address) ? (x > fee ? x - fee : 0n) : x;
    return dest === "public" ? afterFee - (afterFee * BigInt(status.withdrawFeeBps) + 9999n) / 10_000n : afterFee;
  };
  return (
    <div className="stack">
      <div className="seg" role="group" aria-label="Share of the position to exit" style={{ marginTop: 0 }}>
        {[25, 50, 75, 100].map((n) => (
          <button key={n} type="button" aria-pressed={pct === n} onClick={() => setPct(n)}>{n}%</button>
        ))}
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">Where the tokens go</legend>
        <label className="check">
          <input type="radio" name={`dest-${p.positionId}`} checked={dest === "notes"} onChange={() => setDest("notes")} />
          <span>Back to my vault notes. No exit fee.</span>
        </label>
        <label className="check">
          <input type="radio" name={`dest-${p.positionId}`} checked={dest === "public"} onChange={() => setDest("public")} />
          <span>To a public address. Withdrawal fee {fmtBps(status.withdrawFeeBps)}.</span>
        </label>
      </fieldset>
      {dest === "public" && (
        <label className="field">
          <span className="small muted">Public recipient address</span>
          <input className="text-input mono" placeholder="0x…" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} />
        </label>
      )}
      <ModePicker mode={mode} onMode={setMode} b={b} action="execute" feeToken={feeTok} />
      <dl className="kv">
        {tokens.map((t, i) => (
          <div key={t.address}>
            <dt>{dest === "public" ? "Recipient receives" : "Back to notes"} ({t.symbol})</dt>
            <dd className="mono small">{preview.isLoading ? <Sk w="12ch" /> : `${fmtAmount(net(i === 0 ? out0 : out1, t), t.decimals, 6)} ${t.symbol}`}</dd>
          </div>
        ))}
        <div><dt>Minimum accepted</dt><dd className="small">Each amount may fall by at most {EXIT_SLIPPAGE_BPS / 100}% if the pool moves</dd></div>
      </dl>
      <Exposure
        pub={[
          "That a shielded position was reduced, by how much, and what it paid out",
          "The market and the holder contract of this position",
          ...(dest === "public" ? ["The recipient address and amounts"] : []),
          ...senderExposure(mode),
        ]}
        priv={["Which vault account owned the position", "Who entered it, if the shares changed hands", ...(dest === "notes" ? ["Who holds the tokens afterwards"] : [])]}
      />
      {problem && <p className="notice warn small" style={{ margin: 0 }}>{problem}</p>}
      <VaultSubmit mode={mode} act={act} disabled={units === 0n || Boolean(problem) || preview.data === undefined || (dest === "public" && !recipient)} onClick={go}>
        Prove and exit {pct}%
      </VaultSubmit>
    </div>
  );
}

function SendSharesForm({ p, status }: { p: OwnedPosition; status: VaultStatus }) {
  const [pct, setPct] = useState(100);
  const [to, setTo] = useState("");
  const b = useBroadcaster();
  const act = useVaultAction();
  const [mode] = useMode(b, false, "self");
  const units = (p.spendable * BigInt(pct)) / 100n;
  const recipient: Recipient | null = useMemo(() => (isShieldedAddress(to) ? decodeAddress(to) : null), [to]);
  const self = recipient && vaultKeys() && recipient.ownerKey === vaultKeys()!.ownerKey;

  function go() {
    if (!recipient || units === 0n) return;
    void act.run({
      status,
      action: "transfer",
      label: `Send ${pct}% of a shielded position privately`,
      mode: "self",
      feeToken: null,
      prove: async (_f, _fr, onStage) => {
        const t = await prepareTransfer({ status, token: null, resource: p.resource, amount: units, to: recipient, fee: 0n, feeRecipient: zeroAddress, onStage });
        return readyTransfer(t, [{ commitment: t.plan.args.commitments[1].toString(), resource: p.resource, amount: t.plan.outputs[1].amount.toString() }]);
      },
    }).then((ok) => ok && setTo(""));
  }

  return (
    <div className="stack">
      <div className="seg" role="group" aria-label="Share of the position to send" style={{ marginTop: 0 }}>
        {[25, 50, 75, 100].map((n) => (
          <button key={n} type="button" aria-pressed={pct === n} onClick={() => setPct(n)}>{n}%</button>
        ))}
      </div>
      <label className="field">
        <span className="small muted">Recipient's shielded address</span>
        <input className="text-input mono" placeholder="cvl1…" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} />
      </label>
      {to && !recipient && <p className="notice warn small" style={{ margin: 0 }}>That is not a Curveil shielded address (cvl1…).</p>}
      {self && <p className="small muted" style={{ margin: 0 }}>This is your own address: the transfer splits or combines your share notes.</p>}
      <ModePicker mode={mode} onMode={() => undefined} b={b} action="transfer" feeToken={null} onlySelf="Not available for shares: its fee would have to be paid in shares." />
      <Exposure
        pub={["That a private transfer happened, and when", "Your wallet address as the sender"]}
        priv={["That the notes were liquidity shares, and of which position", "The amount", "The recipient"]}
      />
      <VaultSubmit mode={mode} act={act} disabled={!recipient || units === 0n} onClick={go}>Prove and send shares</VaultSubmit>
    </div>
  );
}
