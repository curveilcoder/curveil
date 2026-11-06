/**
 * Shielded liquidity positions. The API lists every position (they are public: market, holder
 * contract, amounts); this browser matches its own share notes to them locally, so the server
 * never learns which positions an account holds.
 */
import { useQuery } from "@tanstack/react-query";
import { shareResource } from "@curveil/vault-core";
import { getAddress, type Address } from "viem";
import { getJson } from "../api";
import { balances } from "./store";
import type { StoredNote, VaultStatus } from "./store";

export type ApiPosition = {
  positionId: string;
  adapter: Address;
  kind: "damm" | "dlmm";
  market: Address;
  holder: Address;
  used0: string;
  used1: string;
  remainingUnits: string;
  blockNumber: number;
  txHash: string;
  timestamp: number;
};

export type OwnedPosition = ApiPosition & {
  id: bigint;
  resource: string;
  /** Units this account can spend now, and units tied up in a pending action. */
  spendable: bigint;
  spending: bigint;
  incoming: bigint;
};

export function usePositionList(enabled: boolean) {
  return useQuery({
    queryKey: ["vault-positions"],
    enabled,
    refetchInterval: 15_000,
    queryFn: async () => {
      const all: ApiPosition[] = [];
      let from = 0;
      for (let i = 0; i < 50; i++) {
        const page = await getJson<{ items: ApiPosition[]; done: boolean }>(`/v1/vault/positions?fromBlock=${from}`);
        const seen = new Set(all.map((p) => p.positionId));
        all.push(...page.items.filter((p) => !seen.has(p.positionId)));
        if (page.done || page.items.length === 0) break;
        from = page.items[page.items.length - 1]!.blockNumber;
      }
      return all;
    },
  });
}

/**
 * This account's positions, from its share notes. `unmatched` counts share notes the index does
 * not list yet; `ignore` holds resources that are not liquidity shares (perps claims).
 */
export function ownedPositions(list: ApiPosition[] | undefined, notes: StoredNote[], status: VaultStatus, ignore?: ReadonlySet<string> | ReadonlyMap<string, unknown>) {
  const assetResources = new Set(status.assets.map((a) => a.resource));
  const shareNotes = notes.filter((n) => !n.spent && !assetResources.has(n.resource) && n.amount !== "0" && !ignore?.has(n.resource));
  const mine = new Set(shareNotes.map((n) => n.resource));
  const owned: OwnedPosition[] = [];
  const matched = new Set<string>();
  for (const p of list ?? []) {
    const id = BigInt(p.positionId);
    const resource = shareResource(getAddress(p.adapter), id).toString();
    if (!mine.has(resource)) continue;
    matched.add(resource);
    const b = balances(resource);
    owned.push({ ...p, id, resource, spendable: b.spendable, spending: b.spending, incoming: b.incoming });
  }
  const unmatched = shareNotes.filter((n) => !matched.has(n.resource)).length;
  return { owned, unmatched };
}

/** Share notes are labelled by the position they belong to. */
export function positionLabel(p: { kind: "damm" | "dlmm"; positionId: string }) {
  return `${p.kind === "damm" ? "DAMM" : "DLMM"} position ${p.positionId.slice(0, 6)}…${p.positionId.slice(-4)}`;
}
