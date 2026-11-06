/**
 * Note encryption (docs/vault-spec.md 4). Every new note is published on-chain as a
 * ciphertext that only the recipient's viewing key opens.
 *
 *   esk, epk     = fresh X25519 key pair per note
 *   shared       = X25519(esk, recipientViewingPublic)
 *   key          = HKDF-SHA256(shared, salt = epk || recipientViewingPublic, info "curveil/note/v1", 32)
 *   ciphertext   = 0x01 || epk || ChaCha20-Poly1305(key, nonce = 0^12, plaintext, aad = 0x01 || epk)
 *   plaintext    = resource (32) || amount (16) || blinding (32)          (80 bytes)
 *
 * The key is single-use, so a fixed nonce is safe. Total size: 1 + 32 + 80 + 16 = 129 bytes.
 *
 * Version 2 is for notes whose amount is only known on-chain (outputs of shielded execution).
 * The client seals the same 80-byte plaintext with amount 0 and version byte 0x02; the pool
 * appends the settled amount as 16 big-endian bytes when it publishes the note, so the
 * published payload is 145 bytes. The amount is public in that event anyway (spec 8.4).
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bigToBytes, bytesToBig, isField, randomBytes } from "./field";

export const NOTE_CIPHERTEXT_VERSION = 1;
export const OPEN_NOTE_CIPHERTEXT_VERSION = 2;
export const NOTE_CIPHERTEXT_LENGTH = 129;
/** A version 2 ciphertext as published: the 129 sealed bytes plus the 16-byte amount. */
export const OPEN_NOTE_PAYLOAD_LENGTH = 145;
const INFO = new TextEncoder().encode("curveil/note/v1");
const NONCE = new Uint8Array(12);

export type NotePlaintext = { resource: bigint; amount: bigint; blinding: bigint };

function noteKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(recipient, 32);
  return hkdf(sha256, shared, salt, INFO, 32);
}

function seal(version: number, p: NotePlaintext, recipientViewingPublic: Uint8Array): Uint8Array {
  const plaintext = new Uint8Array(80);
  plaintext.set(bigToBytes(p.resource, 32), 0);
  plaintext.set(bigToBytes(p.amount, 16), 32);
  plaintext.set(bigToBytes(p.blinding, 32), 48);
  const esk = randomBytes(32);
  const epk = x25519.getPublicKey(esk);
  const key = noteKey(x25519.getSharedSecret(esk, recipientViewingPublic), epk, recipientViewingPublic);
  const header = new Uint8Array(33);
  header[0] = version;
  header.set(epk, 1);
  const sealed = chacha20poly1305(key, NONCE, header).encrypt(plaintext);
  const out = new Uint8Array(33 + sealed.length);
  out.set(header, 0);
  out.set(sealed, 33);
  return out;
}

export function encryptNote(p: NotePlaintext, recipientViewingPublic: Uint8Array): Uint8Array {
  return seal(NOTE_CIPHERTEXT_VERSION, p, recipientViewingPublic);
}

/** Ciphertext for a note whose amount the pool sets on-chain (version 2, amount sealed as 0). */
export function encryptOpenNote(p: { resource: bigint; blinding: bigint }, recipientViewingPublic: Uint8Array): Uint8Array {
  return seal(OPEN_NOTE_CIPHERTEXT_VERSION, { resource: p.resource, amount: 0n, blinding: p.blinding }, recipientViewingPublic);
}

/**
 * Returns the plaintext if this note is addressed to the viewing key, otherwise null.
 * Accepts a 129-byte version 1 ciphertext or a 145-byte published version 2 payload.
 */
export function tryDecryptNote(ciphertext: Uint8Array, viewingPrivate: Uint8Array, viewingPublic: Uint8Array): NotePlaintext | null {
  let version: number;
  if (ciphertext.length === NOTE_CIPHERTEXT_LENGTH && ciphertext[0] === NOTE_CIPHERTEXT_VERSION) version = NOTE_CIPHERTEXT_VERSION;
  else if (ciphertext.length === OPEN_NOTE_PAYLOAD_LENGTH && ciphertext[0] === OPEN_NOTE_CIPHERTEXT_VERSION) version = OPEN_NOTE_CIPHERTEXT_VERSION;
  else return null;
  const header = ciphertext.slice(0, 33);
  const epk = ciphertext.slice(1, 33);
  let plaintext: Uint8Array;
  try {
    const key = noteKey(x25519.getSharedSecret(viewingPrivate, epk), epk, viewingPublic);
    plaintext = chacha20poly1305(key, NONCE, header).decrypt(ciphertext.slice(33, NOTE_CIPHERTEXT_LENGTH));
  } catch {
    return null;
  }
  const resource = bytesToBig(plaintext.slice(0, 32));
  let amount = bytesToBig(plaintext.slice(32, 48));
  const blinding = bytesToBig(plaintext.slice(48, 80));
  if (!isField(resource) || !isField(blinding)) return null;
  if (version === OPEN_NOTE_CIPHERTEXT_VERSION) {
    if (amount !== 0n) return null;
    amount = bytesToBig(ciphertext.slice(NOTE_CIPHERTEXT_LENGTH));
  }
  return { resource, amount, blinding };
}
