/**
 * Signing a Safe transaction without the Safe app. Each owner signs the transaction's EIP-712
 * message in their own wallet (free, nothing is sent). Once enough owners have signed, any wallet
 * with a little ETH sends `execTransaction` with the signatures. Nothing here can move funds or
 * act without the owners' signatures: the Safe contract checks every one.
 */
import { concat, isHex, parseAbi, recoverAddress, zeroAddress, type Hex } from "viem";

export const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

export const timelockAbi = parseAbi([
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
]);

export type SafeTx = { to: `0x${string}`; value: bigint; data: Hex; nonce: bigint };

/** The EIP-712 message an owner signs. Its digest equals the Safe's `getTransactionHash`. */
export const safeTypedData = (safe: `0x${string}`, chainId: number, tx: SafeTx) => ({
  domain: { chainId, verifyingContract: safe },
  primaryType: "SafeTx" as const,
  types: {
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  },
  message: { to: tx.to, value: tx.value, data: tx.data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: tx.nonce },
});

/** The arguments of `execTransaction` for a plain call with no gas refund. */
export const execArgs = (tx: SafeTx, signatures: Hex) =>
  [tx.to, tx.value, tx.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] as const;

/**
 * Puts a signature in the form the Safe checks. Some wallets (Ledger and other hardware wallets
 * among them) end it with v = 0 or 1; the Safe reads those as a different kind of signature, so
 * they become 27 or 28.
 */
export function normalizeSig(sig: string): Hex {
  const s = sig.trim();
  if (!isHex(s) || s.length !== 132) return s as Hex;
  const v = parseInt(s.slice(130), 16);
  return (v === 0 || v === 1 ? `${s.slice(0, 130)}${(v + 27).toString(16)}` : s) as Hex;
}

/** The owner who made a signature over `hash`, or null if it is not a plain 65-byte signature. */
export async function signer(hash: Hex, sig: string): Promise<`0x${string}` | null> {
  const s = normalizeSig(sig);
  if (!isHex(s) || s.length !== 132) return null;
  const v = parseInt(s.slice(130), 16);
  if (v !== 27 && v !== 28) return null;
  try {
    return await recoverAddress({ hash, signature: s });
  } catch {
    return null;
  }
}

/** Joins signatures the way the Safe wants them: ordered by owner address, lowest first. */
export const packSignatures = (sigs: { owner: string; sig: Hex }[]): Hex =>
  concat([...sigs].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1)).map((s) => s.sig));

/** Finds every 65-byte signature in pasted text. */
export const findSignatures = (text: string): Hex[] => (text.match(/0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/g) ?? []).map(normalizeSig);
