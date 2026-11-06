import { IS_TESTNET } from "./config";

/** The pages of /docs, in reading order, grouped as the sidebar shows them. */
const ALL_GROUPS = [
  {
    label: "Using Curveil",
    pages: [
      { id: "overview", title: "Overview", desc: "Everything Curveil does, what is live, and where to start." },
      { id: "get-started", title: "Get started", desc: "A step-by-step walkthrough: connect, swap, earn, launch, trade perps and go private." },
      { id: "markets", title: "Markets and liquidity", desc: "How DLMM and DAMM pools price assets and pay liquidity providers." },
      { id: "swap", title: "Swaps", desc: "How swaps are routed and how slippage protects you." },
      { id: "vault", title: "Shielded Vault", desc: "Shield assets into private notes, send them, and withdraw." },
      { id: "launch", title: "Launches", desc: "How a token goes from bonding curve to graduated pool." },
      { id: "launchpads", title: "Launchpads", desc: "Branded launch sites built on the same launch contracts." },
      { id: "perps", title: "Perpetuals", desc: "Leveraged ETH, BTC and SOL positions, margin, funding and liquidation." },
      { id: "token", title: "$CURVEIL", desc: "The proposed $CURVEIL token and what it does not promise." },
      { id: "fees", title: "Fees", desc: "Every fee, who receives it, and worked examples." },
      { id: "risks", title: "Risks", desc: "What can go wrong, and what Curveil cannot protect you from." },
    ],
  },
  {
    label: "Transparency",
    pages: [
      { id: "contracts", title: "Contracts", desc: "Every deployed contract, its source and its verification." },
      { id: "admin", title: "Administration", desc: "Who controls the admin functions today, and the mainnet plan." },
      { id: "assets", title: "Admitted assets", desc: "The assets pools and the Vault accept." },
    ],
  },
  {
    label: "Developers",
    pages: [
      { id: "quickstart", title: "Quickstart", desc: "Install the SDK, read data, launch a token and receive webhooks." },
      { id: "launchpad-guide", title: "Run a launchpad", desc: "Register a launchpad, build its site and collect your fees." },
      { id: "api", title: "API reference", desc: "Base URL, authentication, limits, errors and every endpoint." },
      { id: "testnet", title: "Testnet tools", desc: "Test tokens, the Vault broadcaster and other testnet helpers." },
    ],
  },
] as const;

export type DocPage = (typeof ALL_GROUPS)[number]["pages"][number]["id"];
type Group = { label: string; pages: readonly { id: DocPage; title: string; desc: string }[] };
/** Testnet tools are listed only on testnet. */
export const DOC_GROUPS: readonly Group[] = ALL_GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => IS_TESTNET || p.id !== "testnet") }));
export const DOC_PAGES = DOC_GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.label })));
export const docPage = (id: unknown): DocPage | undefined => DOC_PAGES.find((p) => p.id === id)?.id;

/** Where the old /developers tabs now live. */
export const DEV_TAB_PAGE: Record<string, DocPage> = {
  start: "quickstart",
  launchpads: "launchpad-guide",
  reference: "api",
  testnet: IS_TESTNET ? "testnet" : "quickstart",
};
