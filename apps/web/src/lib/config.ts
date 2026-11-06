import { defineChain } from "viem";
import { parseManifest, type Manifest } from "@curveil/manifest";

export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
/** Curveil-operated vault broadcaster. Users can always self-submit instead. */
export const BROADCASTER_URL: string = import.meta.env.VITE_BROADCASTER_URL ?? "http://localhost:8788";
/** The example launchpad built only on the SDK, when deployed for this network. */
export const EXAMPLE_URL: string | undefined = import.meta.env.VITE_EXAMPLE_URL;
export const NETWORK = (import.meta.env.VITE_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const IS_TESTNET = NETWORK === "testnet";

/** Manifest bundled at build time. The API serves the same file; the app checks they agree. */
// Every manifest in the package; the build picks the one for VITE_NETWORK and fails without it.
const manifests = import.meta.glob<{ default: unknown }>("../../../../packages/manifest/manifests/*.json", { eager: true });
const bundled = Object.entries(manifests).find(([path]) => path.endsWith(`/${NETWORK}.json`))?.[1];
if (!bundled) throw new Error(`No ${NETWORK} manifest is bundled`);
export const manifest: Manifest = parseManifest(bundled.default);
if (manifest.network !== NETWORK) throw new Error(`Bundled manifest is for ${manifest.network}, the build is for ${NETWORK}`);

export const curveilChain = defineChain({
  id: manifest.chainId,
  name: manifest.network === "testnet" ? "Robinhood Chain Testnet" : "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: manifest.rpc.public } },
  blockExplorers: { default: { name: "Explorer", url: manifest.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: manifest.network === "testnet",
});

export const explorerAddress = (a: string) => `${manifest.explorer}/address/${a}`;
export const explorerTx = (h: string) => `${manifest.explorer}/tx/${h}`;

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;


const contract = (name: string) => manifest.contracts[name]?.address as `0x${string}` | undefined;
export const ROUTER = contract("CurveilRouter");
export const DAMM_FACTORY = contract("DammFactory");
export const DLMM_FACTORY = contract("DlmmFactory");
export const LAUNCH_FACTORY = contract("LaunchFactory");
export const LP_ESCROW = contract("LpEscrow");
export const SHIELDED_POOL = contract("ShieldedPool");
/** The quote token in which values are shown: USDG, or tUSDG on testnet. */
export const QUOTE = manifest.assets.find((a) => a.label === "USDG");
