import { useQuery } from "@tanstack/react-query";
import { CurveilClient, type Operator } from "@curveil/sdk";
import { API_URL, NETWORK, explorerAddress } from "./config";

export const api = new CurveilClient({ baseUrl: API_URL, network: NETWORK });
export type { Operator };

/** A launchpad (operator) by address or slug, as the API indexes it from the registry. */
export function useOperator(id: string | undefined) {
  return useQuery({ queryKey: ["operator", id], queryFn: () => api.operator(id!), enabled: Boolean(id), refetchInterval: 10_000, retry: (n, e) => !(e as { status?: number }).status && n < 2 });
}

/**
 * Where a launchpad's name links: its own website when the brand names an https URL, otherwise the
 * operator's address on the explorer. Brands are written by anyone who registers, so nothing else
 * (javascript:, data:, http:) is ever used as a link.
 */
export function padHref(op: Pick<Operator, "brand"> | undefined, address: string) {
  const url = op?.brand?.url?.trim();
  try {
    if (url && new URL(url).protocol === "https:") return url;
  } catch {
    /* not a URL */
  }
  return explorerAddress(address);
}
