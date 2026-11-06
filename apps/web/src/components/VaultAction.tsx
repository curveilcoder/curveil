/**
 * Shared pieces for actions that spend vault notes: who submits (broadcaster or own wallet),
 * the proof and submission progress, the public/shielded exposure panel, and the runner that
 * proves, submits and tracks an action while its notes stay reserved.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { useConnection, usePublicClient } from "wagmi";
import { zeroAddress, type Abi, type Address } from "viem";
import shieldedPoolAbiJson from "@curveil/manifest/abis/ShieldedPool.json";
import { TxStatus } from "./TxStatus";
import { useTxToast, type ToastEntry } from "./TxToasts";
import { WalletAction } from "./WalletAction";
import { describeError } from "../lib/errors";
import { fmtAmount } from "../lib/format";
import { useTxRunner } from "../lib/tx";
import { broadcastStatus, broadcasterInfo, feeFor, getQuote, submitToBroadcaster, type BroadcasterInfo, type Ready, type VaultActionKind } from "../lib/vault/actions";
import type { ProveStage } from "../lib/vault/prover";
import { addPending, sync, updatePending, type VaultStatus } from "../lib/vault/store";

const poolAbi = shieldedPoolAbiJson as Abi;

export type Mode = "broadcaster" | "self";

/** The broadcaster's terms, fetched once per form. */
export function useBroadcaster() {
  const [info, setInfo] = useState<BroadcasterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    broadcasterInfo().then(setInfo, (e) => setError(e instanceof Error ? e.message : "Unavailable"));
  }, []);
  return { info, error };
}

/**
 * Uses the broadcaster whenever it can take the fee, and the wallet otherwise, until the user
 * picks one. A pick of the broadcaster falls back to the wallet while it cannot be used.
 */
export function useMode(b: ReturnType<typeof useBroadcaster>, usable: boolean, only?: Mode) {
  const [picked, setPicked] = useState<Mode | null>(null);
  const unusable = Boolean(b.error || (b.info && (!b.info.healthy || !usable)));
  const wanted = only ?? picked ?? "broadcaster";
  const mode: Mode = wanted === "broadcaster" && unusable ? "self" : wanted;
  return [mode, setPicked as (m: Mode) => void] as const;
}

export function ModePicker({
  mode,
  onMode,
  b,
  action,
  feeToken,
  onlySelf,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  b: ReturnType<typeof useBroadcaster>;
  action: VaultActionKind;
  /** The asset the broadcaster's fee is paid in, with its display data. */
  feeToken: { address: Address; symbol: string; decimals: number } | null;
  /** Why only the wallet can submit (for example, a private share transfer). */
  onlySelf?: string;
}) {
  const fee = feeFor(b.info, action, feeToken?.address);
  const usable = Boolean(b.info?.healthy && fee !== null && !onlySelf);
  const name = useId();
  const hint = mode === "broadcaster"
    ? onlySelf ?? "Curveil's broadcaster sends it and takes its fee from your notes. Your wallet address stays off-chain."
    : "You send it from your wallet and pay the gas. Your wallet address shows as the sender.";
  const why = onlySelf ?? (b.error ? b.error : b.info && !b.info.healthy ? "The broadcaster is unavailable right now (low on gas)." : b.info && fee === null ? `The broadcaster does not take ${feeToken?.symbol ?? "this asset"} as a fee.` : null);
  return (
    <div className="vx-mode">
      <div className="vx-row">
        <span className="vx-label" id={name}>Submit with</span>
        <div className="seg vx-seg" role="radiogroup" aria-labelledby={name}>
          <button type="button" role="radio" aria-checked={mode === "broadcaster"} aria-pressed={mode === "broadcaster"} disabled={!usable} onClick={() => onMode("broadcaster")}>
            Broadcaster{fee !== null && feeToken && usable ? <span className="vx-fee mono">{fmtAmount(fee, feeToken.decimals, 6)} {feeToken.symbol}</span> : null}
          </button>
          <button type="button" role="radio" aria-checked={mode === "self"} aria-pressed={mode === "self"} onClick={() => onMode("self")}>
            My wallet<span className="vx-fee mono">gas</span>
          </button>
        </div>
      </div>
      <p className="vx-hint">{!usable && why ? <><span className="warn-text">{why}</span> {hint}</> : hint}</p>
    </div>
  );
}

export type Stage =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "loading" }
  | { kind: "proving"; step?: string }
  | { kind: "sending" }
  | { kind: "waiting"; txHash: string | null }
  | { kind: "done"; txHash: string; block: number | null }
  | { kind: "failed"; message: string };

/** Progress of a vault action. It shows in a toast in the corner of the screen, not in the form. */
export function StageView({ stage }: { stage: Stage }) {
  const id = useId();
  const entry: ToastEntry | null =
    stage.kind === "idle"
      ? null
      : {
          title: stage.kind === "done" ? "Vault transaction confirmed" : stage.kind === "failed" ? "Vault transaction failed" : "Vault transaction",
          tone: stage.kind === "failed" ? "bad" : stage.kind === "done" ? "good" : "busy",
          hash: stage.kind === "waiting" || stage.kind === "done" ? stage.txHash : null,
          message:
            stage.kind === "quoting" ? "Getting the broadcaster's fee terms…"
            : stage.kind === "loading" ? "Downloading and checking the circuit files…"
            : stage.kind === "proving" ? `Generating the proof${stage.step ? ` (${stage.step})` : ""} on this device. This takes a few seconds.`
            : stage.kind === "sending" ? "Submitting…"
            : stage.kind === "waiting" ? "Waiting for the chain."
            : stage.kind === "done" ? `Confirmed${stage.block ? ` in block ${stage.block}` : ""}.`
            : `${stage.message} Your notes were not spent.`,
        };
  useTxToast(id, entry);
  return null;
}

export function Exposure({ pub, priv }: { pub: string[]; priv: string[] }) {
  return (
    <details className="vx-privacy">
      <summary>
        <span className="vx-label">Privacy</span>
        <span className="vx-privacy-sum">{priv.length} things stay private, {pub.length} are public</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </summary>
      <div className="vx-privacy-body">
        <div>
          <p><span className="tag tag-shielded">Private</span></p>
          <ul>{priv.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div>
          <p><span className="tag tag-public">Public</span></p>
          <ul>{pub.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
    </details>
  );
}

/** What the sender exposes, by submission route. */
export const senderExposure = (mode: Mode) =>
  mode === "broadcaster" ? ["The broadcaster fee and its asset", "The broadcaster sees your network address and timing"] : ["Your wallet address as the sender"];

/** Proves, submits through the chosen route, tracks the result, and keeps notes reserved meanwhile. */
export function useVaultAction() {
  const client = usePublicClient();
  const { address: wallet } = useConnection();
  const selfTx = useTxRunner();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  /** Resolves true once the action is confirmed on-chain. */
  async function run(o: {
    status: VaultStatus;
    label: string;
    mode: Mode;
    action: VaultActionKind;
    /** The asset the broadcaster fee is quoted in (ignored when submitting yourself). */
    feeToken: Address | null;
    prove: (fee: bigint, feeRecipient: Address, onStage: (s: ProveStage, step?: string) => void) => Promise<Ready>;
  }): Promise<boolean> {
    const id = crypto.randomUUID();
    let added = false;
    try {
      let fee = 0n;
      let feeRecipient: Address = zeroAddress;
      if (o.mode === "broadcaster") {
        if (!o.feeToken) throw new Error("The broadcaster cannot take a fee for this action. Submit from your wallet instead.");
        setStage({ kind: "quoting" });
        const quote = await getQuote(o.action, o.feeToken);
        fee = BigInt(quote.fee);
        feeRecipient = quote.feeRecipient;
      } else if (!wallet) {
        throw new Error("Connect a wallet to submit yourself.");
      }
      setStage({ kind: "loading" });
      const r = await o.prove(fee, feeRecipient, (s, step) => setStage(s === "proving" ? { kind: "proving", step } : { kind: "loading" }));
      // Make sure the contract still knows every root the proofs use.
      for (const root of new Set(r.roots)) {
        const known = (await client!.readContract({ address: o.status.pool, abi: poolAbi, functionName: "isKnownRoot", args: [root] })) as boolean;
        if (!known) throw new Error("The vault moved on while proving. Refresh and try again.");
      }
      await addPending(o.status.pool, {
        id,
        kind: o.action,
        label: o.label,
        createdAt: Date.now(),
        nullifiers: r.nullifiers.map(String),
        incoming: r.incoming,
        state: "submitted",
      });
      added = true;
      setStage({ kind: "sending" });
      if (o.mode === "broadcaster") {
        const rec = await submitToBroadcaster(r.broadcast.action, r.broadcast.body);
        await updatePending(o.status.pool, id, { broadcastId: rec.id, txHash: rec.txHash ?? undefined });
        setStage({ kind: "waiting", txHash: rec.txHash });
        let confirmed = false;
        for (let i = 0; i < 120 && !confirmed; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          const s = await broadcastStatus(rec.id);
          if (s.status === "confirmed") {
            setStage({ kind: "done", txHash: s.txHash!, block: s.blockNumber });
            confirmed = true;
          } else if (s.status === "failed" || s.status === "dropped") {
            throw new Error(s.error ?? "The transaction did not go through.");
          }
        }
        // Still pending after four minutes: keep the notes reserved and leave the link up.
        if (!confirmed) return false;
      } else {
        const receipt = await selfTx.run([{ label: o.label, params: { address: o.status.pool, abi: poolAbi, functionName: r.self.functionName, args: r.self.args } as never }]);
        if (!receipt) throw new Error("The wallet transaction did not complete.");
        await updatePending(o.status.pool, id, { txHash: receipt.transactionHash });
        setStage({ kind: "done", txHash: receipt.transactionHash, block: Number(receipt.blockNumber) });
      }
      await sync("action");
      return true;
    } catch (e) {
      const message = describeError(e);
      setStage({ kind: "failed", message });
      if (added) await updatePending(o.status.pool, id, { state: "failed", error: message }).catch(() => undefined);
      return false;
    }
  }
  const busy = !["idle", "done", "failed"].includes(stage.kind);
  return { run, stage, busy, selfPhase: selfTx.phase, reset: () => setStage({ kind: "idle" }) };
}

/** The submit button (wallet-gated when submitting yourself) and the progress below it. */
export function VaultSubmit({
  mode,
  act,
  disabled,
  onClick,
  children,
}: {
  mode: Mode;
  act: ReturnType<typeof useVaultAction>;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <button className="btn btn-primary btn-block" disabled={act.busy || disabled} onClick={onClick}>
      {act.busy ? "Working…" : children}
    </button>
  );
  return (
    <>
      {mode === "self" ? <WalletAction verb="submit yourself">{button}</WalletAction> : button}
      <StageView stage={act.stage} />
      {mode === "self" && act.selfPhase.kind !== "idle" && act.stage.kind !== "done" && <TxStatus phase={act.selfPhase} />}
    </>
  );
}
