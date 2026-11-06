/**
 * Transaction helpers: each returns { to, data } (and value 0) for any wallet to send, so the
 * SDK never holds keys. Reads take a viem PublicClient. Contract addresses come from the
 * manifest (client.manifest()) or the factory endpoint (client.factory()).
 */
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export type Tx = { to: Address; data: Hex; value: 0n };
const tx = (to: Address, data: Hex): Tx => ({ to, data, value: 0n });

export const launchpadRegistryAbi = parseAbi([
  "function register(string slug, string brandURI, uint16 shareBps, uint64 templateMask, address[] recipients, uint16[] weights) returns (address)",
  "function predictOperator(string slug) view returns (address)",
  "function setBrand(address operator, string brandURI)",
  "function setShare(address operator, uint16 shareBps)",
  "function setTemplates(address operator, uint64 templateMask)",
  "function setActive(address operator, bool active)",
  "function setRecipients(address operator, address[] recipients, uint16[] weights, address[] tokens)",
  "function transferAdmin(address operator, address newAdmin)",
  "function acceptAdmin(address operator)",
  "function maxShareBps() view returns (uint16)",
  "function operatorTerms(address operator, uint256 templateId) view returns (bool allowed, uint16 shareBps)",
  "function operatorBySlug(bytes32 slugHash) view returns (address)",
  "event OperatorRegistered(address indexed operator, address indexed admin, string slug, uint16 shareBps, uint64 templateMask, string brandURI)",
]);

export const feeSplitterAbi = parseAbi([
  "function collect(address[] curves, address token) returns (uint256)",
  "function distribute(address token) returns (uint256)",
  "function release(address token, address recipient) returns (uint256)",
  "function pending(address token) view returns (uint256)",
  "function owed(address token, address recipient) view returns (uint256)",
  "function released(address token, address recipient) view returns (uint256)",
  "function recipients() view returns (address[], uint16[])",
]);

export const launchFactoryAbi = parseAbi([
  "struct CreateParams { uint256 templateId; string name; string symbol; string metadataURI; address creatorRecipient; address operator; uint256 initialBuy; uint256 minTokensOut; uint256 deadline; }",
  "function createLaunch(CreateParams p) returns (address token, address curve)",
  "event LaunchCreated(address indexed token, address indexed curve, address indexed creator, uint256 templateId, string name, string symbol, string metadataURI, address creatorRecipient)",
]);

export const bondingCurveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address to, uint256 deadline) returns (uint256 tokensOut, uint256 quoteUsed)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address to, uint256 deadline) returns (uint256 quoteOut)",
  "function quoteBuy(uint256 quoteIn) view returns (uint256 tokensOut, uint256 fee, uint256 quoteUsed)",
  "function quoteSell(uint256 tokensIn) view returns (uint256 quoteOut, uint256 fee)",
  "function operator() view returns (address)",
  "function operatorFees() view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const routerAbi = parseAbi([
  "struct Hop { address pool; address tokenIn; address tokenOut; }",
  "function swapExactIn(Hop[] hops, uint256 amountIn, uint256 minOut, address to, uint256 deadline) returns (uint256 amountOut)",
]);

// ------------------------------------------------------------------ launchpads

export type Recipient = { address: Address; weightBps: number };
export type BrandInput = { name: string; tagline?: string; accent?: string; url?: string; logo?: string };

export const SLUG_RULE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
export const isValidSlug = (slug: string) => SLUG_RULE.test(slug);

/** Bit i allows template i. */
export const templateMask = (ids: number[]) => ids.reduce((m, i) => m | (1n << BigInt(i)), 0n);

/** An inline brand (data: JSON URI), at most 2048 bytes, which the API parses for frontends. */
export function encodeBrandURI(b: BrandInput): string {
  const clean = Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, (v as string).trim()]));
  const uri = `data:application/json,${encodeURIComponent(JSON.stringify(clean))}`;
  if (new TextEncoder().encode(uri).length > 2048) throw new Error("The brand is too long (2048 bytes at most). Host it and pass an https URI instead.");
  return uri;
}

function splitRecipients(rs: Recipient[]) {
  const sum = rs.reduce((s, r) => s + r.weightBps, 0);
  if (rs.length === 0 || rs.length > 8 || sum !== 10_000) throw new Error("1 to 8 recipients whose weights add up to 10000 (100%).");
  return { recipients: rs.map((r) => r.address), weights: rs.map((r) => r.weightBps) };
}

export function registerOperatorTx(o: { registry: Address; slug: string; brandURI: string; shareBps: number; templates: number[]; recipients: Recipient[] }): Tx {
  if (!isValidSlug(o.slug)) throw new Error("Slug: 3 to 32 characters, a-z, 0-9 and '-', not starting or ending with '-'.");
  const { recipients, weights } = splitRecipients(o.recipients);
  return tx(o.registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "register", args: [o.slug, o.brandURI, o.shareBps, templateMask(o.templates), recipients, weights] }));
}
export const setBrandTx = (registry: Address, operator: Address, brandURI: string) =>
  tx(registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "setBrand", args: [operator, brandURI] }));
export const setShareTx = (registry: Address, operator: Address, shareBps: number) =>
  tx(registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "setShare", args: [operator, shareBps] }));
export const setTemplatesTx = (registry: Address, operator: Address, templates: number[]) =>
  tx(registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "setTemplates", args: [operator, templateMask(templates)] }));
export const setActiveTx = (registry: Address, operator: Address, active: boolean) =>
  tx(registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "setActive", args: [operator, active] }));
/** `settleTokens`: fees in these tokens that already arrived go to the old recipients first. */
export function setRecipientsTx(registry: Address, operator: Address, rs: Recipient[], settleTokens: Address[]): Tx {
  const { recipients, weights } = splitRecipients(rs);
  return tx(registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "setRecipients", args: [operator, recipients, weights, settleTokens] }));
}
export const transferAdminTx = (registry: Address, operator: Address, newAdmin: Address) =>
  tx(registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "transferAdmin", args: [operator, newAdmin] }));
export const acceptAdminTx = (registry: Address, operator: Address) => tx(registry, encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "acceptAdmin", args: [operator] }));

/** Pulls the operator fees of `curves` into the splitter and allocates them. Anyone may send it. */
export const collectTx = (operator: Address, curves: Address[], token: Address) =>
  tx(operator, encodeFunctionData({ abi: feeSplitterAbi, functionName: "collect", args: [curves, token] }));
export const distributeTx = (operator: Address, token: Address) => tx(operator, encodeFunctionData({ abi: feeSplitterAbi, functionName: "distribute", args: [token] }));
/** Pays a recipient what it is owed. Anyone may send it; the money only goes to the recipient. */
export const releaseTx = (operator: Address, token: Address, recipient: Address) =>
  tx(operator, encodeFunctionData({ abi: feeSplitterAbi, functionName: "release", args: [token, recipient] }));

export const predictOperator = (client: PublicClient, registry: Address, slug: string) =>
  client.readContract({ address: registry, abi: launchpadRegistryAbi, functionName: "predictOperator", args: [slug] });

// ------------------------------------------------------------------ launches and trading

export type CreateLaunch = {
  factory: Address;
  templateId: number;
  name: string;
  symbol: string;
  metadataURI: string;
  creatorRecipient: Address;
  /** The launchpad this launch runs on (its operator address), or omit for none. */
  operator?: Address;
  /** Quote to buy with in the same transaction (approve the factory first). */
  initialBuy?: bigint;
  minTokensOut?: bigint;
  /** Unix seconds; defaults to 20 minutes from now. */
  deadline?: bigint;
};

export function createLaunchTx(o: CreateLaunch): Tx {
  return tx(
    o.factory,
    encodeFunctionData({
      abi: launchFactoryAbi,
      functionName: "createLaunch",
      args: [
        {
          templateId: BigInt(o.templateId),
          name: o.name,
          symbol: o.symbol,
          metadataURI: o.metadataURI,
          creatorRecipient: o.creatorRecipient,
          operator: o.operator ?? "0x0000000000000000000000000000000000000000",
          initialBuy: o.initialBuy ?? 0n,
          minTokensOut: o.minTokensOut ?? 0n,
          deadline: o.deadline ?? soon(),
        },
      ],
    }),
  );
}

const soon = (seconds = 1200) => BigInt(Math.floor(Date.now() / 1000) + seconds);

/** `slippageBps` is applied to the quote read with quoteBuy/quoteSell. */
export const withSlippage = (amount: bigint, slippageBps: number) => (amount * BigInt(10_000 - slippageBps)) / 10_000n;

export const approveTx = (token: Address, spender: Address, amount: bigint) => tx(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
export const buyTx = (o: { curve: Address; quoteIn: bigint; minTokensOut: bigint; to: Address; deadline?: bigint }) =>
  tx(o.curve, encodeFunctionData({ abi: bondingCurveAbi, functionName: "buy", args: [o.quoteIn, o.minTokensOut, o.to, o.deadline ?? soon()] }));
export const sellTx = (o: { curve: Address; tokensIn: bigint; minQuoteOut: bigint; to: Address; deadline?: bigint }) =>
  tx(o.curve, encodeFunctionData({ abi: bondingCurveAbi, functionName: "sell", args: [o.tokensIn, o.minQuoteOut, o.to, o.deadline ?? soon()] }));
export const swapExactInTx = (o: { router: Address; hops: { pool: Address; tokenIn: Address; tokenOut: Address }[]; amountIn: bigint; minOut: bigint; to: Address; deadline?: bigint }) =>
  tx(o.router, encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [o.hops, o.amountIn, o.minOut, o.to, o.deadline ?? soon()] }));

export async function quoteBuy(client: PublicClient, curve: Address, quoteIn: bigint) {
  const [tokensOut, fee, quoteUsed] = await client.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quoteBuy", args: [quoteIn] });
  return { tokensOut, fee, quoteUsed };
}
export async function quoteSell(client: PublicClient, curve: Address, tokensIn: bigint) {
  const [quoteOut, fee] = await client.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quoteSell", args: [tokensIn] });
  return { quoteOut, fee };
}
