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

/** A row with the switch and one line on what the chosen account means. */
export function FundingRow({ what }: { what: string }) {
  const funding = useFunding();
  return (
    <div className="funding-row">
      <span className="small muted">
        {funding === "shielded" ? <span title={what}>Paying from your shielded <Link to="/vault">vault</Link>.</span> : "Paying from your connected wallet."}
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
  if (v.phase === "loading") return <SkNotice label="Loading your vault" />;
  if (v.phase === "unavailable") return <p className="notice bad" role="alert">{v.error ?? "This browser cannot store a vault account."}</p>;
  if (v.phase === "none") {
    return (
      <div className="notice">
        Shielded funding uses a vault account in this browser. <Link to="/vault">Create or recover one</Link>, shield some funds, then come back.
      </div>
    );
  }
  if (v.phase === "locked") return <UnlockInline />;
  const status = v.status;
  if (!status) return <SkNotice label="Loading vault status" />;
  if (status.version !== 2 || !status.adapters?.length) return <p className="notice warn">The vault on this network cannot run shielded swaps or liquidity yet.</p>;
  if (status.spendPaused) return <p className="notice warn">Vault spending is paused right now. Shielded actions resume when it is unpaused.</p>;
  return <>{children(status)}</>;
}

export function SyncNote({ v }: { v: VaultState }) {
  if (v.sync.kind === "syncing") return <p className="small muted" style={{ margin: 0 }}>Scanning vault notes: {v.sync.leaves.toLocaleString()} of {v.sync.of.toLocaleString()}…</p>;
  if (v.sync.kind === "error") return <p className="small bad-ink" style={{ margin: 0 }}>Vault sync stopped: {v.sync.message}</p>;
  return null;
}
