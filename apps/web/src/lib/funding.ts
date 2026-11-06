/**
 * Funding account for Swap and Liquidity: the connected public wallet, or the shielded vault
 * account in this browser. Remembered per browser (a convenience, not a security setting).
 */
import { useSyncExternalStore } from "react";
import { manifest } from "./config";

export type Funding = "public" | "shielded";
const KEY = "curveil:funding";
/** Shielded funding needs the execution-capable pool and its adapters. */
export const SHIELDED_EXECUTION = Boolean(manifest.contracts.ShieldedSwapAdapter && manifest.contracts.ShieldedLiquidityAdapter);

function read(): Funding {
  try {
    return SHIELDED_EXECUTION && localStorage.getItem(KEY) === "shielded" ? "shielded" : "public";
  } catch {
    return "public";
  }
}

let current: Funding = read();
const listeners = new Set<() => void>();

export function setFunding(f: Funding) {
  current = SHIELDED_EXECUTION ? f : "public";
  try {
    localStorage.setItem(KEY, current);
  } catch {
    /* private mode: keep it for this session only */
  }
  for (const l of listeners) l();
}

export function useFunding(): Funding {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
