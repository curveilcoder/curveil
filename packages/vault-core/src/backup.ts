/**
 * Encrypted backup file and on-device storage envelope (docs/vault-spec.md 7).
 *
 * The envelope encrypts JSON with AES-256-GCM under a key derived from the user's vault
 * passphrase with PBKDF2-SHA256 (600,000 iterations). The same envelope protects the account
 * in the browser's IndexedDB and in the downloadable backup file. Only WebCrypto is used, so
 * it works in browsers, workers and Node 20+.
 */
export const BACKUP_FORMAT = "curveil-vault-backup";
export const PBKDF2_ITERATIONS = 600_000;

export type Envelope = {
  format: typeof BACKUP_FORMAT;
  version: 1;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string };
  ciphertext: string;
};

export type BackupContents = { entropy: string; createdAt: string };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveStorageKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealWithKey(key: CryptoKey, salt: Uint8Array, data: unknown, iterations = PBKDF2_ITERATIONS): Promise<Envelope> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: { name: "PBKDF2-SHA256", iterations, salt: b64(salt) },
    cipher: { name: "AES-256-GCM", iv: b64(iv) },
    ciphertext: b64(ct),
  };
}

export async function seal(passphrase: string, data: unknown): Promise<{ envelope: Envelope; key: CryptoKey; salt: Uint8Array }> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await deriveStorageKey(passphrase, salt);
  return { envelope: await sealWithKey(key, salt, data), key, salt };
}

export function parseEnvelope(raw: unknown): Envelope {
  const e = raw as Partial<Envelope> | null;
  if (!e || e.format !== BACKUP_FORMAT || e.version !== 1) throw new Error("This is not a Curveil vault backup file.");
  if (e.kdf?.name !== "PBKDF2-SHA256" || typeof e.kdf.iterations !== "number" || e.kdf.iterations < 100_000 || typeof e.kdf.salt !== "string")
    throw new Error("Unsupported backup key settings.");
  if (e.cipher?.name !== "AES-256-GCM" || typeof e.cipher.iv !== "string" || typeof e.ciphertext !== "string") throw new Error("Unsupported backup cipher.");
  return e as Envelope;
}

export async function openWithKey<T>(key: CryptoKey, envelope: Envelope): Promise<T> {
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.cipher.iv) }, key, unb64(envelope.ciphertext));
  } catch {
    throw new Error("Wrong passphrase, or the file is damaged.");
  }
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export async function open<T>(passphrase: string, raw: unknown): Promise<{ data: T; key: CryptoKey; salt: Uint8Array }> {
  const envelope = parseEnvelope(raw);
  const salt = unb64(envelope.kdf.salt);
  const key = await deriveStorageKey(passphrase, salt, envelope.kdf.iterations);
  return { data: await openWithKey<T>(key, envelope), key, salt };
}
