/**
 * Note discovery (docs/vault-spec.md 6). The client downloads every public commitment and
 * ciphertext in leaf order and trial-decrypts them locally, so no server learns which notes
 * belong to whom. A decrypted note counts only if it re-opens the on-chain commitment.
 */
import { bytesToHex, type Hex } from "viem";
import { encryptNote, tryDecryptNote } from "./encryption";
import { commitment, nullifier, ownerHash, type Note } from "./note";
import { randomField } from "./field";
import type { VaultKeys } from "./keys";
import type { SpendableNote } from "./actions";

export type PublicCommitment = { leafIndex: number; commitment: bigint; encryptedNote: Uint8Array };

export type OwnedNote = SpendableNote & { commitment: bigint; nullifier: bigint };

export function scanCommitments(keys: VaultKeys, domain: bigint, items: readonly PublicCommitment[]): OwnedNote[] {
  const found: OwnedNote[] = [];
  for (const item of items) {
    const p = tryDecryptNote(item.encryptedNote, keys.viewingPrivate, keys.viewingPublic);
    if (!p) continue;
    const note: Note = { resource: p.resource, amount: p.amount, ownerKey: keys.ownerKey, blinding: p.blinding };
    let cm: bigint;
    try {
      cm = commitment(note, domain);
    } catch {
      continue;
    }
    // A ciphertext that does not open its commitment is ignored (wrong owner key or forged).
    if (cm !== item.commitment) continue;
    found.push({
      leafIndex: item.leafIndex,
      resource: p.resource,
      amount: p.amount,
      blinding: p.blinding,
      commitment: cm,
      nullifier: nullifier(keys.spendingKey, cm, item.leafIndex),
    });
  }
  return found;
}

/** Arguments for ShieldedPool.shield: the pool builds the commitment from the amount it receives. */
export function planShield(keys: Pick<VaultKeys, "ownerKey" | "viewingPublic">, resource: bigint, amount: bigint) {
  const blinding = randomField();
  const note: Note = { resource, amount, ownerKey: keys.ownerKey, blinding };
  return {
    ownerHash: ownerHash(keys.ownerKey, blinding),
    encryptedNote: bytesToHex(encryptNote({ resource, amount, blinding }, keys.viewingPublic)) as Hex,
    note,
  };
}

/**
 * Picks at most two notes covering `target`: one note if any is large enough (the smallest
 * such), otherwise the pair with the smallest sufficient total. Returns null when no one or
 * two notes cover it, in which case the caller offers to combine notes first.
 */
export function selectNotes<T extends { amount: bigint }>(notes: readonly T[], target: bigint): T[] | null {
  const sorted = [...notes].filter((n) => n.amount > 0n).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  const single = sorted.find((n) => n.amount >= target);
  if (single) return [single];
  let best: [T, T] | null = null;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const sum = sorted[i]!.amount + sorted[j]!.amount;
      if (sum >= target && (!best || sum < best[0].amount + best[1].amount)) best = [sorted[i]!, sorted[j]!];
    }
  }
  return best;
}
