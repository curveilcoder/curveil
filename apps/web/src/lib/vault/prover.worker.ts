/// <reference lib="webworker" />
/**
 * Proof generation off the main thread. Circuit artifacts are fetched from this site and
 * checked against the SHA-256 hashes in the deployment manifest before use. Inputs (which
 * include the spending key) never leave this worker except as the finished proof.
 */
import * as snarkjs from "snarkjs";

type Artifact = { url: string; sha256: string };
type Request = { id: number; input: Record<string, unknown>; wasm: Artifact; zkey: Artifact };

const cache = new Map<string, Uint8Array>();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function load(a: Artifact): Promise<Uint8Array> {
  const want = a.sha256.replace(/^0x/, "").toLowerCase();
  const hit = cache.get(want);
  if (hit) return hit;
  for (const mode of ["force-cache", "reload"] as RequestCache[]) {
    const r = await fetch(a.url, { cache: mode });
    if (!r.ok) throw new Error(`Could not download ${a.url} (${r.status}).`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if ((await sha256Hex(bytes)) === want) {
      cache.set(want, bytes);
      return bytes;
    }
  }
  throw new Error("A circuit file does not match the hash in the deployment manifest. Proving stopped.");
}

const post = (m: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, input, wasm, zkey } = e.data;
  try {
    post({ id, stage: "loading" });
    const [w, z] = await Promise.all([load(wasm), load(zkey)]);
    post({ id, stage: "proving" });
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input as never,
      { type: "mem", data: w } as never,
      { type: "mem", data: z } as never,
      undefined,
      undefined,
      { singleThread: true },
    );
    post({ id, done: true, proof, publicSignals, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
