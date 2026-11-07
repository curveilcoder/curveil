/** Main-thread handle on the prover worker. One proof at a time. */
import type { Groth16Proof } from "@curveil/vault-core";
import { tNow } from "../i18n";

export type ProveStage = "loading" | "proving";
export type Artifact = { url: string; sha256: string };

let worker: Worker | null = null;
let nextId = 1;

export function prove(
  input: Record<string, unknown>,
  artifacts: { wasm: Artifact; zkey: Artifact },
  onStage?: (s: ProveStage) => void,
): Promise<{ proof: Groth16Proof; publicSignals: string[]; ms: number }> {
  worker ??= new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module", name: "curveil-prover" });
  const id = nextId++;
  const w = worker;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { id: number; stage?: ProveStage; done?: boolean; error?: string; proof?: Groth16Proof; publicSignals?: string[]; ms?: number };
      if (m.id !== id) return;
      if (m.stage) onStage?.(m.stage);
      if (m.error) {
        w.removeEventListener("message", onMessage);
        reject(new Error(m.error));
      } else if (m.done) {
        w.removeEventListener("message", onMessage);
        resolve({ proof: m.proof!, publicSignals: m.publicSignals!, ms: m.ms ?? 0 });
      }
    };
    w.addEventListener("message", onMessage);
    w.onerror = (ev) => reject(new Error(ev.message || tNow("The prover stopped unexpectedly.", "证明生成器意外停止。")));
    w.postMessage({ id, input, ...artifacts });
  });
}
