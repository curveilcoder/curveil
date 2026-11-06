import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "@reown/appkit/networks";
import { http } from "wagmi";
import { curveilChain } from "./config";

/**
 * Wallet connection through Reown AppKit: browser extensions (EIP-6963), WalletConnect
 * (QR code on desktop, deep links into wallet apps on phones) and Coinbase. Wallet names
 * and logos come from the WalletConnect registry or from the wallet itself.
 */
const projectId = import.meta.env.VITE_REOWN_PROJECT_ID as string;
if (!projectId) throw new Error("VITE_REOWN_PROJECT_ID is not set");

const network = defineChain({
  ...curveilChain,
  caipNetworkId: `eip155:${curveilChain.id}`,
  chainNamespace: "eip155",
});

const adapter = new WagmiAdapter({
  projectId,
  networks: [network],
  transports: { [curveilChain.id]: http() },
  ssr: false,
});

// WalletConnect registry ids, shown first in the dialog.
const FEATURED = [
  "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96", // MetaMask
  "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1", // Rabby
  "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa", // Coinbase (Base)
  "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369", // Rainbow
  "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0", // Trust Wallet
  "971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709", // OKX Wallet
];

const origin = typeof window !== "undefined" ? window.location.origin : "https://curveil.xyz";

export const appKit = createAppKit({
  adapters: [adapter],
  networks: [network],
  defaultNetwork: network,
  projectId,
  metadata: {
    name: "Curveil",
    description: "Open markets. Private participation.",
    url: origin,
    icons: [`${origin}/favicon.svg`],
  },
  featuredWalletIds: FEATURED,
  allWallets: "SHOW",
  enableWalletGuide: true,
  // Wallets only: no email or social sign-in, no swaps, on-ramp or tracking.
  features: {
    analytics: false,
    email: false,
    socials: false,
    swaps: false,
    onramp: false,
    history: false,
    send: false,
    receive: false,
    pay: false,
    reownAuthentication: false,
  },
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent": "#2563ff",
    "--w3m-color-mix": "#080c16",
    "--w3m-color-mix-strength": 45,
    "--w3m-font-family": '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
    "--w3m-border-radius-master": "2px",
    "--w3m-z-index": 1000,
  },
});

export const wagmiConfig = adapter.wagmiConfig;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
