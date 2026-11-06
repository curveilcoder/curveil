/** BN254 scalar field helpers. Every circuit value and every note field lives in this field. */
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, toBytes, type Hex } from "viem";

/** BN254 scalar field modulus r (the SNARK field). */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Note amounts, fees and withdrawals are 128-bit in the circuits. */
export const MAX_AMOUNT = (1n << 128n) - 1n;

export const mod = (x: bigint) => ((x % FIELD) + FIELD) % FIELD;

export function isField(x: bigint): boolean {
  return x >= 0n && x < FIELD;
}

/** Big-endian bytes to bigint. */
export function bytesToBig(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

/** bigint to fixed-length big-endian bytes. Throws if it does not fit. */
export function bigToBytes(x: bigint, length: number): Uint8Array {
  if (x < 0n) throw new Error("negative value");
  const out = new Uint8Array(length);
  let v = x;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`value does not fit in ${length} bytes`);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Uniform random field element (64 random bytes reduced mod r; bias below 2^-250). */
export function randomField(): bigint {
  return bytesToBig(randomBytes(64)) % FIELD;
}

/** keccak256 of a UTF-8 label, reduced into the field. Used for fixed public constants. */
export function labelToField(label: string): bigint {
  return BigInt(keccak256(toBytes(label))) % FIELD;
}

/** keccak256(abi.encode(...)) reduced into the field, as the contracts compute it. */
export function abiHashToField(types: readonly { type: string }[], values: readonly unknown[]): bigint {
  return BigInt(keccak256(encodeAbiParameters(types, values as never))) % FIELD;
}

export const toHex32 = (x: bigint): Hex => bytesToHex(bigToBytes(x, 32));
export const fromHex = (h: Hex): Uint8Array => hexToBytes(h);
