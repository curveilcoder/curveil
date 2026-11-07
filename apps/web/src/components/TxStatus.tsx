import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useId } from "react";
import { useTxToast, type ToastEntry } from "./TxToasts";
import { useT } from "../lib/i18n";

export type TxPhase =
  | { kind: "idle" }
  | { kind: "awaiting_wallet"; step?: string }
  | { kind: "submitted"; hash: string; step?: string }
  | { kind: "confirmed"; hash: string; block: bigint; step?: string }
  | { kind: "failed"; message: string; hash?: string; step?: string };

/** Latest block the chain reports as finalized (posted to and finalized on Ethereum). */
export function useFinalizedBlock(enabled = true) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["finalized-block"],
    queryFn: async () => (await client!.getBlock({ blockTag: "finalized" })).number,
    enabled: enabled && Boolean(client),
    refetchInterval: 30_000,
  });
}

/**
 * Shared transaction lifecycle. It shows in a small toast in the corner of the screen with one
 * status line, not in the form. A transaction shows as confirmed only once a receipt with status
 * success exists.
 */
export function TxStatus({ phase }: { phase: TxPhase }) {
  const t = useT();
  const id = useId();
  const step = "step" in phase && phase.step ? phase.step : t("Transaction", "交易");
  const entry: ToastEntry | null =
    phase.kind === "idle"
      ? null
      : {
          title: step,
          tone: phase.kind === "failed" ? "bad" : phase.kind === "confirmed" ? "good" : "busy",
          hash: "hash" in phase ? phase.hash : null,
          message:
            phase.kind === "awaiting_wallet"
              ? t("Confirm it in your wallet.", "请在钱包中确认。")
              : phase.kind === "submitted"
                ? t("Submitted. Waiting for confirmation.", "已提交，等待确认。")
                : phase.kind === "confirmed"
                  ? t(`Confirmed in block ${phase.block.toString()}.`, `已在区块 ${phase.block.toString()} 中确认。`)
                  : phase.message,
        };
  useTxToast(id, entry);
  return null;
}
