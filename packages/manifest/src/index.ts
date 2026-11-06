export * from "./schema";
import { Manifest, type NetworkName } from "./schema";

/** Parse and validate a manifest. Throws with a readable message if it is invalid. */
export function parseManifest(input: unknown): Manifest {
  const r = Manifest.safeParse(input);
  if (!r.success) {
    throw new Error(`Invalid Curveil manifest: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

/** Throws if the connected chain is not the one the manifest describes. */
export function assertChain(m: Manifest, chainId: number): void {
  if (m.chainId !== chainId) {
    throw new Error(`Connected to chain ${chainId}, but the Curveil ${m.network} manifest is for chain ${m.chainId}.`);
  }
}

export function contractAddress(m: Manifest, name: string): `0x${string}` {
  const c = m.contracts[name];
  if (!c) throw new Error(`Contract ${name} is not deployed on ${m.network}`);
  return c.address as `0x${string}`;
}

export function networkOf(chainId: number): NetworkName | null {
  if (chainId === 46630) return "testnet";
  if (chainId === 4663) return "mainnet";
  return null;
}
