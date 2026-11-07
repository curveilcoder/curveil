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
import { useT, tNow } from "../lib/i18n";

const poolAbi = shieldedPoolAbiJson as Abi;

export type Mode = "broadcaster" | "self";

/** The broadcaster's terms, fetched once per form. */
export function useBroadcaster() {
  const [info, setInfo] = useState<BroadcasterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    broadcasterInfo().then(setInfo, (e) => setError(e instanceof Error ? e.message : tNow("Unavailable", "不可用")));
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
  const t = useT();
  const fee = feeFor(b.info, action, feeToken?.address);
  const usable = Boolean(b.info?.healthy && fee !== null && !onlySelf);
  const name = useId();
  const hint = mode === "broadcaster"
    ? onlySelf ?? t("Curveil's broadcaster sends it and takes its fee from your notes. Your wallet address stays off-chain.", "由 Curveil 广播者代为发送，并从你的票据中扣除手续费。你的钱包地址不会上链。")
    : t("You send it from your wallet and pay the gas. Your wallet address shows as the sender.", "由你从钱包发送并支付 Gas。你的钱包地址会显示为发送方。");
  const why = onlySelf ?? (b.error ? b.error : b.info && !b.info.healthy ? t("The broadcaster is unavailable right now (low on gas).", "广播者目前不可用（Gas 不足）。") : b.info && fee === null ? t(`The broadcaster does not take ${feeToken?.symbol ?? "this asset"} as a fee.`, `广播者不接受用 ${feeToken?.symbol ?? "该资产"} 支付手续费。`) : null);
  return (
    <div className="vx-mode">
      <div className="vx-row">
        <span className="vx-label" id={name}>{t("Submit with", "提交方式")}</span>
        <div className="seg vx-seg" role="radiogroup" aria-labelledby={name}>
          <button type="button" role="radio" aria-checked={mode === "broadcaster"} aria-pressed={mode === "broadcaster"} disabled={!usable} onClick={() => onMode("broadcaster")}>
            {t("Broadcaster", "广播者")}{fee !== null && feeToken && usable ? <span className="vx-fee mono">{fmtAmount(fee, feeToken.decimals, 6)} {feeToken.symbol}</span> : null}
          </button>
          <button type="button" role="radio" aria-checked={mode === "self"} aria-pressed={mode === "self"} onClick={() => onMode("self")}>
            {t("My wallet", "我的钱包")}<span className="vx-fee mono">{t("gas", "Gas")}</span>
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
  const t = useT();
  const id = useId();
  const entry: ToastEntry | null =
    stage.kind === "idle"
      ? null
      : {
          title: stage.kind === "done" ? t("Vault transaction confirmed", "金库交易已确认") : stage.kind === "failed" ? t("Vault transaction failed", "金库交易失败") : t("Vault transaction", "金库交易"),
          tone: stage.kind === "failed" ? "bad" : stage.kind === "done" ? "good" : "busy",
          hash: stage.kind === "waiting" || stage.kind === "done" ? stage.txHash : null,
          message:
            stage.kind === "quoting" ? t("Getting the broadcaster's fee terms…", "正在获取广播者的手续费条款…")
            : stage.kind === "loading" ? t("Downloading and checking the circuit files…", "正在下载并校验电路文件…")
            : stage.kind === "proving" ? t(`Generating the proof${stage.step ? ` (${stage.step})` : ""} on this device. This takes a few seconds.`, `正在本设备上生成证明${stage.step ? `（${stage.step}）` : ""}，需要几秒钟。`)
            : stage.kind === "sending" ? t("Submitting…", "正在提交…")
            : stage.kind === "waiting" ? t("Waiting for the chain.", "等待链上确认。")
            : stage.kind === "done" ? t(`Confirmed${stage.block ? ` in block ${stage.block}` : ""}.`, `已确认${stage.block ? `（区块 ${stage.block}）` : ""}。`)
            : t(`${stage.message} Your notes were not spent.`, `${stage.message} 你的票据没有被花费。`),
        };
  useTxToast(id, entry);
  return null;
}

export function Exposure({ pub, priv }: { pub: string[]; priv: string[] }) {
  const t = useT();
  return (
    <details className="vx-privacy">
      <summary>
        <span className="vx-label">{t("Privacy", "隐私")}</span>
        <span className="vx-privacy-sum">{t(`${priv.length} things stay private, ${pub.length} are public`, `${priv.length} 项保持隐私，${pub.length} 项公开`)}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </summary>
      <div className="vx-privacy-body">
        <div>
          <p><span className="tag tag-shielded">{t("Private", "隐私")}</span></p>
          <ul>{priv.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div>
          <p><span className="tag tag-public">{t("Public", "公开")}</span></p>
          <ul>{pub.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
    </details>
  );
}

/** What the sender exposes, by submission route. */
export const senderExposure = (mode: Mode) =>
  mode === "broadcaster" ? tNow(["The broadcaster fee and its asset", "The broadcaster sees your network address and timing"], ["广播者手续费及其资产", "广播者能看到你的网络地址和时间"]) : tNow(["Your wallet address as the sender"], ["你的钱包地址（作为发送方）"]);

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
        if (!o.feeToken) throw new Error(tNow("The broadcaster cannot take a fee for this action. Submit from your wallet instead.", "广播者无法为该操作收取手续费，请改用钱包提交。"));
        setStage({ kind: "quoting" });
        const quote = await getQuote(o.action, o.feeToken);
        fee = BigInt(quote.fee);
        feeRecipient = quote.feeRecipient;
      } else if (!wallet) {
        throw new Error(tNow("Connect a wallet to submit yourself.", "请连接钱包后自行提交。"));
      }
      setStage({ kind: "loading" });
      const r = await o.prove(fee, feeRecipient, (s, step) => setStage(s === "proving" ? { kind: "proving", step } : { kind: "loading" }));
      // Make sure the contract still knows every root the proofs use.
      for (const root of new Set(r.roots)) {
        const known = (await client!.readContract({ address: o.status.pool, abi: poolAbi, functionName: "isKnownRoot", args: [root] })) as boolean;
        if (!known) throw new Error(tNow("The vault moved on while proving. Refresh and try again.", "生成证明期间金库状态已更新，请刷新后重试。"));
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
            throw new Error(s.error ?? tNow("The transaction did not go through.", "交易未能完成。"));
          }
        }
        // Still pending after four minutes: keep the notes reserved and leave the link up.
        if (!confirmed) return false;
      } else {
        const receipt = await selfTx.run([{ label: o.label, params: { address: o.status.pool, abi: poolAbi, functionName: r.self.functionName, args: r.self.args } as never }]);
        if (!receipt) throw new Error(tNow("The wallet transaction did not complete.", "钱包交易未完成。"));
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
  const t = useT();
  const button = (
    <button className="btn btn-primary btn-block" disabled={act.busy || disabled} onClick={onClick}>
      {act.busy ? t("Working…", "处理中…") : children}
    </button>
  );
  return (
    <>
      {mode === "self" ? <WalletAction verb={t("submit yourself", "自行提交")}>{button}</WalletAction> : button}
      <StageView stage={act.stage} />
      {mode === "self" && act.selfPhase.kind !== "idle" && act.stage.kind !== "done" && <TxStatus phase={act.selfPhase} />}
    </>
  );
}
