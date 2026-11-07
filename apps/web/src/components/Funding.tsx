/**
 * Funding account controls for Swap and Liquidity: the Public / Shielded switch, and the gate
 * that makes sure a vault account is unlocked, synced and able to run shielded actions.
 */
import { useEffect, type ReactNode } from "react";
import { SkNotice } from "./Skeleton";
import { Link } from "@tanstack/react-router";
import { useFunding } from "../lib/funding";
import { FundingSwitch } from "./FundingSwitch";
import { init, sync, useVault, type VaultState, type VaultStatus } from "../lib/vault/store";
import { UnlockInline } from "../routes/VaultSetup";
import { useT } from "../lib/i18n";

/** A row with the switch and one line on what the chosen account means. */
export function FundingRow({ what }: { what: string }) {
  const t = useT();
  const funding = useFunding();
  return (
    <div className="funding-row">
      <span className="small muted">
        {funding === "shielded" ? <span title={what}>{t(<>Paying from your shielded <Link to="/app/vault">vault</Link>.</>, <>从你的隐私<Link to="/app/vault">金库</Link>付款。</>)}</span> : t("Paying from your connected wallet.", "从你连接的钱包付款。")}
      </span>
      <FundingSwitch />
    </div>
  );
}

/** The vault account, loaded and kept in sync while a shielded form is open. */
export function useShieldedVault(active = true): VaultState {
  const v = useVault();
  useEffect(() => {
    if (active) void init();
  }, [active]);
  useEffect(() => {
    if (!active || v.phase !== "unlocked") return;
    void sync("page");
    const t = setInterval(() => void sync("poll"), 15_000);
    return () => clearInterval(t);
  }, [active, v.phase]);
  return v;
}

/** Renders `children(status)` only when the vault can run a shielded action now. */
export function VaultGate({ v, children }: { v: VaultState; children: (status: VaultStatus) => ReactNode }) {
  const t = useT();
  if (v.phase === "loading") return <SkNotice label={t("Loading your vault", "正在加载你的金库")} />;
  if (v.phase === "unavailable") return <p className="notice bad" role="alert">{v.error ?? t("This browser cannot store a vault account.", "此浏览器无法保存金库账户。")}</p>;
  if (v.phase === "none") {
    return (
      <div className="notice">
        {t(<>Shielded funding uses a vault account in this browser. <Link to="/app/vault">Create or recover one</Link>, shield some funds, then come back.</>, <>隐私付款使用此浏览器中的金库账户。请先<Link to="/app/vault">创建或恢复一个账户</Link>，存入一些隐私资金后再回来。</>)}
      </div>
    );
  }
  if (v.phase === "locked") return <UnlockInline />;
  const status = v.status;
  if (!status) return <SkNotice label={t("Loading vault status", "正在加载金库状态")} />;
  if (status.version !== 2 || !status.adapters?.length) return <p className="notice warn">{t("The vault on this network cannot run shielded swaps or liquidity yet.", "本网络上的金库暂时还不能执行隐私兑换或流动性操作。")}</p>;
  if (status.spendPaused) return <p className="notice warn">{t("Vault spending is paused right now. Shielded actions resume when it is unpaused.", "金库支出目前已暂停。解除暂停后即可恢复隐私操作。")}</p>;
  return <>{children(status)}</>;
}

export function SyncNote({ v }: { v: VaultState }) {
  const t = useT();
  if (v.sync.kind === "syncing") return <p className="small muted" style={{ margin: 0 }}>{t(`Scanning vault notes: ${v.sync.leaves.toLocaleString()} of ${v.sync.of.toLocaleString()}…`, `正在扫描金库票据：${v.sync.leaves.toLocaleString()} / ${v.sync.of.toLocaleString()}…`)}</p>;
  if (v.sync.kind === "error") return <p className="small bad-ink" style={{ margin: 0 }}>{t("Vault sync stopped:", "金库同步已停止：")} {v.sync.message}</p>;
  return null;
}
