/**
 * Notes, commitments, nullifiers, resource IDs and the note domain (docs/vault-spec.md 2-4).
 *
 *   ownerKey   = Poseidon1(spendingKey)
 *   ownerHash  = Poseidon2(ownerKey, blinding)
 *   commitment = Poseidon4(resource, amount, ownerHash, domain)
 *   nullifier  = Poseidon3(spendingKey, commitment, leafIndex)
 */
import { poseidon1, poseidon2, poseidon3, poseidon4 } from "poseidon-lite";
import { getAddress, keccak256, toBytes, type Address } from "viem";
import { FIELD, MAX_AMOUNT, abiHashToField, isField } from "./field";

export type Note = {
  /** Resource ID (which asset or share class the note holds). */
  resource: bigint;
  /** Amount in the asset's base units, below 2^128. */
  amount: bigint;
  /** Owner key of the recipient: Poseidon1(spendingKey). */
  ownerKey: bigint;
  /** Random blinding factor, a field element. */
  blinding: bigint;
};

const RESOURCE_FUNGIBLE_TAG = keccak256(toBytes("curveil.resource.fungible.v1"));
const RESOURCE_SHARE_TAG = keccak256(toBytes("curveil.resource.share.v1"));
const NOTE_DOMAIN_TAG = keccak256(toBytes("curveil.note.v1"));

/** Resource ID of a fungible ERC-20 held by the vault. */
export function fungibleResource(token: Address): bigint {
  return abiHashToField([{ type: "bytes32" }, { type: "address" }], [RESOURCE_FUNGIBLE_TAG, getAddress(token)]);
}

/**
 * Resource ID of a share issued by a shielded adapter (for example one liquidity position).
 * The pool derives it from the adapter's address, so an adapter can only issue its own shares.
 */
export function shareResource(adapter: Address, shareId: bigint): bigint {
  return abiHashToField(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [RESOURCE_SHARE_TAG, getAddress(adapter), shareId],
  );
}

/** Note domain: binds every note to one chain and one ShieldedPool deployment. */
export function noteDomain(chainId: number | bigint, pool: Address): bigint {
  return abiHashToField(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [NOTE_DOMAIN_TAG, BigInt(chainId), getAddress(pool)],
  );
}

export function ownerKeyOf(spendingKey: bigint): bigint {
  return poseidon1([spendingKey]);
}

export function ownerHash(ownerKey: bigint, blinding: bigint): bigint {
  return poseidon2([ownerKey, blinding]);
}

export function checkNote(note: Note): void {
  if (note.amount < 0n || note.amount > MAX_AMOUNT) throw new Error("note amount out of range");
  for (const k of ["resource", "ownerKey", "blinding"] as const) {
    if (!isField(note[k])) throw new Error(`note ${k} is not a field element`);
  }
}

export function commitment(note: Note, domain: bigint): bigint {
  checkNote(note);
  return poseidon4([note.resource, note.amount, ownerHash(note.ownerKey, note.blinding), domain]);
}

export function nullifier(spendingKey: bigint, commitmentValue: bigint, leafIndex: number): bigint {
  return poseidon3([spendingKey, commitmentValue, BigInt(leafIndex)]);
}

export { FIELD };
