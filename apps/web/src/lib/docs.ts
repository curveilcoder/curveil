import { IS_TESTNET } from "./config";

/** The pages of /docs, in reading order, grouped as the sidebar shows them. */
const ALL_GROUPS = [
  {
    label: "Using Curveil", labelZh: "使用 Curveil",
    pages: [
      { id: "overview", title: "Overview", desc: "Everything Curveil does, what is live, and where to start." , titleZh: "概览", descZh: "Curveil 的全部功能、哪些已上线，以及从哪里开始。" },
      { id: "get-started", title: "Get started", desc: "A step-by-step walkthrough: connect, swap, earn, launch, trade perps and go private." , titleZh: "快速开始", descZh: "手把手教程：连接钱包、兑换、赚取收益、发币、交易永续合约以及进入隐私模式。" },
      { id: "markets", title: "Markets and liquidity", desc: "How DLMM and DAMM pools price assets and pay liquidity providers." , titleZh: "市场与流动性", descZh: "DLMM 和 DAMM 资金池如何为资产定价，以及如何向流动性提供者支付收益。" },
      { id: "swap", title: "Swaps", desc: "How swaps are routed and how slippage protects you." , titleZh: "兑换", descZh: "兑换如何路由，以及滑点保护如何保障你。" },
      { id: "vault", title: "Shielded Vault", desc: "Shield assets into private notes, send them, and withdraw." , titleZh: "隐私金库", descZh: "把资产存入隐私票据、转账和提取。" },
      { id: "launch", title: "Launches", desc: "How a token goes from bonding curve to graduated pool." , titleZh: "代币发行", descZh: "代币如何从联合曲线走到毕业后的资金池。" },
      { id: "launchpads", title: "Launchpads", desc: "Branded launch sites built on the same launch contracts." , titleZh: "发射台", descZh: "基于同一套发行合约搭建的品牌发行网站。" },
      { id: "perps", title: "Perpetuals", desc: "Leveraged ETH, BTC and SOL positions, margin, funding and liquidation." , titleZh: "永续合约", descZh: "ETH、BTC 和 SOL 杠杆仓位、保证金、资金费率和强平。" },
      { id: "token", title: "$CURVEIL", desc: "The proposed $CURVEIL token and what it does not promise." , titleZh: "$CURVEIL", descZh: "拟发行的 $CURVEIL 代币，以及它不作出的承诺。" },
      { id: "fees", title: "Fees", desc: "Every fee, who receives it, and worked examples." , titleZh: "费用", descZh: "每一项费用、由谁收取，以及计算示例。" },
      { id: "risks", title: "Risks", desc: "What can go wrong, and what Curveil cannot protect you from." , titleZh: "风险", descZh: "可能出现的问题，以及 Curveil 无法为你防范的风险。" },
    ],
  },
  {
    label: "Transparency", labelZh: "透明度",
    pages: [
      { id: "contracts", title: "Contracts", desc: "Every deployed contract, its source and its verification." , titleZh: "合约", descZh: "每个已部署的合约、源代码及其验证情况。" },
      { id: "admin", title: "Administration", desc: "Who controls the admin functions today, and the mainnet plan." , titleZh: "管理权限", descZh: "目前谁控制管理功能，以及主网计划。" },
      { id: "assets", title: "Admitted assets", desc: "The assets pools and the Vault accept." , titleZh: "准入资产", descZh: "资金池和金库接受的资产。" },
    ],
  },
  {
    label: "Developers", labelZh: "开发者",
    pages: [
      { id: "quickstart", title: "Quickstart", desc: "Install the SDK, read data, launch a token and receive webhooks." , titleZh: "开发者快速上手", descZh: "安装 SDK、读取数据、发行代币并接收 Webhook。" },
      { id: "launchpad-guide", title: "Run a launchpad", desc: "Register a launchpad, build its site and collect your fees." , titleZh: "运营发射台", descZh: "注册发射台、搭建网站并领取你的手续费。" },
      { id: "api", title: "API reference", desc: "Base URL, authentication, limits, errors and every endpoint." , titleZh: "API 参考", descZh: "基础 URL、认证、限额、错误码和全部接口。" },
      { id: "testnet", title: "Testnet tools", desc: "Test tokens, the Vault broadcaster and other testnet helpers." , titleZh: "测试网工具", descZh: "测试代币、金库广播器和其他测试网辅助工具。" },
    ],
  },
] as const;

export type DocPage = (typeof ALL_GROUPS)[number]["pages"][number]["id"];
type Group = { label: string; labelZh: string; pages: readonly { id: DocPage; title: string; desc: string; titleZh: string; descZh: string }[] };
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
