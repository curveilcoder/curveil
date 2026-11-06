/**
 * Vault account keys (docs/vault-spec.md 2).
 *
 * A vault account is 32 bytes of entropy, shown to the user as a 24-word recovery phrase
 * (BIP-39 English wordlist). It is generated in the browser and is independent of any
 * wallet: connecting a wallet never recovers a vault account.
 *
 *   spendingKey     = HKDF-SHA256(entropy, salt "curveil/vault", info "spend/v1", 64 bytes) mod r
 *   viewingPrivate  = HKDF-SHA256(entropy, salt "curveil/vault", info "view/v1", 32 bytes)  (X25519)
 *   ownerKey        = Poseidon1(spendingKey)
 *   viewingPublic   = X25519(viewingPrivate)
 *
 * The spending key authorises spends inside proofs. The viewing key only decrypts incoming
 * notes; it cannot spend.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { FIELD, bytesToBig, randomBytes } from "./field";
import { ownerKeyOf } from "./note";

export type VaultKeys = {
  spendingKey: bigint;
  ownerKey: bigint;
  viewingPrivate: Uint8Array;
  viewingPublic: Uint8Array;
};

const SALT = new TextEncoder().encode("curveil/vault");
const info = (s: string) => new TextEncoder().encode(s);

export function newEntropy(): Uint8Array {
  return randomBytes(32);
}

export function entropyToPhrase(entropy: Uint8Array): string {
  if (entropy.length !== 32) throw new Error("vault entropy must be 32 bytes");
  return entropyToMnemonic(entropy, wordlist);
}

/** Normalises spacing and case, then checks the words and checksum. */
export function phraseToEntropy(phrase: string): Uint8Array {
  const normalised = normalisePhrase(phrase);
  if (normalised.split(" ").length !== 24) throw new Error("A Curveil recovery phrase has 24 words.");
  if (!validateMnemonic(normalised, wordlist)) throw new Error("This phrase has a word that is not on the list, or its checksum does not match.");
  return mnemonicToEntropy(normalised, wordlist);
}

export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isPhraseWord(word: string): boolean {
  return wordlist.includes(word.trim().toLowerCase());
}

export function deriveKeys(entropy: Uint8Array): VaultKeys {
  if (entropy.length !== 32) throw new Error("vault entropy must be 32 bytes");
  const spendingKey = bytesToBig(hkdf(sha256, entropy, SALT, info("spend/v1"), 64)) % FIELD;
  if (spendingKey === 0n) throw new Error("degenerate spending key");
  const viewingPrivate = hkdf(sha256, entropy, SALT, info("view/v1"), 32);
  return {
    spendingKey,
    ownerKey: ownerKeyOf(spendingKey),
    viewingPrivate,
    viewingPublic: x25519.getPublicKey(viewingPrivate),
  };
}
