import { useStatus, moduleById, STATUS_LABEL } from "../lib/api";
import { Link } from "@tanstack/react-router";
import { Loading, Sk } from "./Skeleton";

/** The risk that matters most where each module is used. The full list is on the Risks page. */
const RISK: Record<string, string> = {
  swap: "The price can move before your swap lands; your minimum received protects you. USDG's issuer can freeze or pause it.",
  markets: "Liquidity can end up worth less than holding both tokens, and USDG's issuer can freeze or pause it.",
  liquidity: "Liquidity can end up worth less than holding both tokens, and USDG's issuer can freeze or pause it.",
  launch: "Most launched tokens lose value. Anyone can launch a token with any name, so check the address before you buy.",
  vault: "Amounts and timing of deposits and withdrawals are public, so a deposit and a withdrawal close in size and time can be linked. Lose your recovery phrase and backup and the funds are gone.",
  perps: "Leverage multiplies losses, and a position is liquidated when its margin runs out. Prices come from an oracle that can be delayed.",
};

/**
 * Availability notice, straight from the API. Shown only when a module is not usable (not
 * live yet, paused, or the API is unreachable); a live module shows nothing.
 */
export function ModuleStatus({ id }: { id: string }) {
  const { data, isLoading, isError, refetch } = useStatus();
  const mod = moduleById(data, id);
  if (isLoading) return null;
  if (isError) {
    return (
      <div className="notice bad" role="alert">
        <span>Could not reach the Curveil API, so availability is unknown.</span>
        <button className="btn btn-sm" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }
  if (!mod) return null;
  const ok = mod.status === "live" || mod.status === "testnet";
  if (ok) return null;
  return (
    <div className={`notice ${ok ? "good" : "warn"}`}>
      <span className={`dot ${ok ? "good" : "warn"}`} style={{ marginTop: 7 }} aria-hidden="true" />
      <div>
        <strong>{STATUS_LABEL[mod.status]}</strong>
        <p style={{ margin: "4px 0 0" }}>{mod.reason}</p>
        {RISK[id] && (
          <p className="small" style={{ margin: "6px 0 0" }}>
            {RISK[id]} <Link to="/docs" search={{ page: "risks" }}>Read the risks</Link>
          </p>
        )}
      </div>
    </div>
  );
}

/** The status notice while availability loads: a dot, a label and one line. */
export function StatusSkeleton() {
  return (
    <div className="notice" aria-busy="true">
      <Loading label="Checking availability" />
      <Sk w={8} h={8} style={{ borderRadius: "50%", marginTop: 7, flex: "none" }} />
      <div style={{ flex: 1 }}><Sk w="8ch" /><Sk block w="70%" style={{ marginTop: 8 }} /></div>
    </div>
  );
}

/** Where indexed data stands, so numbers are never shown without their freshness. */
export function IndexerNote() {
  const { data } = useStatus();
  const ix = data?.indexer;
  if (!ix) return null;
  if (ix.status === "not_started") return <p className="small muted">The market indexer has not started yet. Pool lists fill in once it runs.</p>;
  const text =
    ix.status === "ok"
      ? `Indexed to block ${ix.indexedBlock?.toLocaleString("en-US")}`
      : ix.status === "lagging"
        ? `Indexer is ${ix.lagBlocks?.toLocaleString("en-US")} blocks behind; recent trades may be missing`
        : "Indexer is stalled; figures may be out of date";
  return (
    <p className="small muted index-note">
      <span className={`dot ${ix.status === "ok" ? "good" : "warn"}`} aria-hidden="true" /> {text}
    </p>
  );
}
