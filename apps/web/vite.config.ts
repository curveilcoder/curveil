import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * public/_headers lists the testnet hosts in its Content-Security-Policy. For a mainnet build,
 * point them at the mainnet API and broadcaster (the VITE_API_URL and VITE_BROADCASTER_URL of
 * .env.mainnet) and RPC, and drop the localhost entries, so the browser lets the site reach its
 * own network's API.
 */
function networkHeaders(mode: string): Plugin {
  let outDir = resolve(import.meta.dirname, "dist");
  return {
    name: "curveil-network-headers",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (mode !== "mainnet") return;
      const file = resolve(outDir, "_headers");
      if (!existsSync(file)) return;
      const env = loadEnv(mode, import.meta.dirname, "VITE_");
      if (!env.VITE_API_URL || !env.VITE_BROADCASTER_URL) throw new Error(".env.mainnet needs VITE_API_URL and VITE_BROADCASTER_URL");
      const out = readFileSync(file, "utf8")
        .replaceAll("https://curveil-api-testnet.zeronym.workers.dev", new URL(env.VITE_API_URL).origin)
        .replaceAll("https://curveil-broadcaster-testnet.zeronym.workers.dev", new URL(env.VITE_BROADCASTER_URL).origin)
        .replaceAll("https://rpc.testnet.chain.robinhood.com", "https://rpc.mainnet.chain.robinhood.com")
        .replace(/ http:\/\/localhost:\d+/g, "");
      if (out.includes("testnet")) throw new Error("dist/_headers still names a testnet host in a mainnet build");
      writeFileSync(file, out);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), networkHeaders(mode)],
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/viem") || id.includes("node_modules/wagmi") || id.includes("@wagmi")) return "web3";
          if (id.includes("node_modules/react") || id.includes("@tanstack")) return "framework";
          return undefined;
        },
      },
    },
  },
}));
