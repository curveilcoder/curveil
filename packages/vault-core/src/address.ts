/**
 * Shielded addresses (docs/vault-spec.md 2.3): bech32m with prefix "cvl", carrying the
 * owner key (32 bytes) and the X25519 viewing public key (32 bytes). Senders need both:
 * the owner key goes inside the note commitment, the viewing key encrypts the note.
 */
import { bech32m } from "@scure/base";
import { bigToBytes, bytesToBig, isField } from "./field";

export const ADDRESS_PREFIX = "cvl";
const LIMIT = 200;

export type ShieldedAddress = { ownerKey: bigint; viewingPublic: Uint8Array };

export function encodeAddress(a: ShieldedAddress): string {
  if (a.viewingPublic.length !== 32) throw new Error("viewing key must be 32 bytes");
  const payload = new Uint8Array(65);
  payload[0] = 1; // address version
  payload.set(bigToBytes(a.ownerKey, 32), 1);
  payload.set(a.viewingPublic, 33);
  return bech32m.encode(ADDRESS_PREFIX, bech32m.toWords(payload), LIMIT);
}

export function decodeAddress(text: string): ShieldedAddress {
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(text.trim().toLowerCase() as `${string}1${string}`, LIMIT);
  } catch {
    throw new Error("This is not a Curveil shielded address (check for a missing or changed character).");
  }
  if (decoded.prefix !== ADDRESS_PREFIX) throw new Error("A Curveil shielded address starts with cvl1.");
  const payload = bech32m.fromWords(decoded.words);
  if (payload.length !== 65 || payload[0] !== 1) throw new Error("Unsupported shielded address version.");
  const ownerKey = bytesToBig(payload.slice(1, 33));
  if (!isField(ownerKey)) throw new Error("Shielded address has an invalid owner key.");
  return { ownerKey, viewingPublic: payload.slice(33, 65) };
}

export function isShieldedAddress(text: string): boolean {
  try {
    decodeAddress(text);
    return true;
  } catch {
    return false;
  }
}
