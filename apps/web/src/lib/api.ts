import { useQuery } from "@tanstack/react-query";
import { API_URL } from "./config";

export type ModuleStatus = {
  id: string;
  name: string;
  status: "live" | "testnet" | "not_live" | "degraded" | "paused";
  phase: number;
  reason: string;
  updated_at: string;
};

export type Status = {
  network: string;
  chainId: number;
  manifestVersion: string;
  chain: { status: "ok"; headBlock: number; rpcChainId: number } | { status: "wrong_chain"; headBlock: number; rpcChainId: number } | { status: "unavailable"; error: string };
  indexer: { status: string; lagBlocks: number | null; indexedBlock?: number; finalizedBlock?: number | null; lastError?: string | null };
  modules: ModuleStatus[];
  generatedAt: string;
};

export class ApiError extends Error {}

export async function getJson<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError("The Curveil API could not be reached.");
  }
  if (!r.ok) throw new ApiError(`The Curveil API answered ${r.status}.`);
  return (await r.json()) as T;
}

/** Live protocol status. Refreshes every 15 s. Never substitutes defaults on failure. */
export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => getJson<Status>("/v1/status"), refetchInterval: 15_000, retry: 2 });
}

export function moduleById(status: Status | undefined, id: string): ModuleStatus | undefined {
  return status?.modules.find((m) => m.id === id);
}

export const STATUS_LABEL: Record<ModuleStatus["status"], string> = {
  live: "Live",
  testnet: "Live on testnet",
  not_live: "Not live yet",
  degraded: "Degraded",
  paused: "Paused",
};

export const STATUS_LABEL_ZH: Record<ModuleStatus["status"], string> = {
  live: "已上线",
  testnet: "已在测试网上线",
  not_live: "尚未上线",
  degraded: "运行降级",
  paused: "已暂停",
};
