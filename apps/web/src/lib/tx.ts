import { useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import type { TransactionReceipt } from "viem";
import type { TxPhase } from "../components/TxStatus";
import { describeError } from "./errors";

type WriteParams = Parameters<ReturnType<typeof useWriteContract>["mutateAsync"]>[0];
export type TxStep = { label: string; params: WriteParams };

/**
 * Runs approvals and the main transaction in order, showing each step's lifecycle. A step is
 * confirmed only on a successful receipt; any failure stops the sequence.
 */
export function useTxRunner() {
  const client = usePublicClient();
  const write = useWriteContract();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });

  async function run(steps: TxStep[]): Promise<TransactionReceipt | null> {
    if (!client) return null;
    let hash: `0x${string}` | undefined;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      const step = steps.length > 1 ? `${s.label} (${i + 1} of ${steps.length})` : s.label;
      hash = undefined;
      try {
        setPhase({ kind: "awaiting_wallet", step });
        hash = await write.mutateAsync(s.params);
        setPhase({ kind: "submitted", hash, step });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setPhase({ kind: "failed", message: `${s.label} reverted. Nothing after it was sent.`, hash, step });
          return null;
        }
        if (i === steps.length - 1) {
          setPhase({ kind: "confirmed", hash, block: receipt.blockNumber, step });
          return receipt;
        }
      } catch (e) {
        setPhase({ kind: "failed", message: describeError(e), hash, step });
        return null;
      }
    }
    return null;
  }

  const busy = phase.kind === "awaiting_wallet" || phase.kind === "submitted";
  return { phase, setPhase, run, busy };
}
