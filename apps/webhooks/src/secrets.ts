/**
 * Webhook signing secrets at rest. Each subscription's secret is encrypted with AES-256-GCM under
 * the WEBHOOK_MASTER_KEY Worker secret (32 random bytes, base64), with the subscription id as
 * additional data so a ciphertext only decrypts for the row it was written to. The API encrypts
 * when it creates or rotates a secret; only the delivery Worker decrypts.
 */

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();

async function key(masterB64: string, usage: "encrypt" | "decrypt") {
  const raw = unb64(masterB64);
  if (raw.length !== 32) throw new Error("WEBHOOK_MASTER_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/** A new signing secret: whsec_ and 32 random bytes, base64url. */
export function newSigningSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export async function encryptSecret(secret: string, subscriptionId: string, masterB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(subscriptionId) }, await key(masterB64, "encrypt"), enc.encode(secret));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(sealed: string, subscriptionId: string, masterB64: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unknown secret format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(subscriptionId) }, await key(masterB64, "decrypt"), unb64(ct));
  return new TextDecoder().decode(pt);
}
