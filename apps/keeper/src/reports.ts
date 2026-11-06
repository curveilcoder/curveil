/**
 * Signed price reports for SignedReportVerifier (testnet price source):
 * report = abi.encode(bytes32 feedId, uint256 price, uint64 timestamp, bytes signature), where
 * the signature is EIP-712 over PriceReport(feedId, price, timestamp) in the
 * "Curveil Price Reports" v1 domain of the verifier contract.
 */
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex, type LocalAccount } from "viem";

export const feedIdOf = (feed: string): Hex => keccak256(toBytes(feed));

export const REPORT_TYPES = {
  PriceReport: [
    { name: "feedId", type: "bytes32" },
    { name: "price", type: "uint256" },
    { name: "timestamp", type: "uint64" },
  ],
} as const;

export const reportDomain = (chainId: number, verifier: Address) =>
  ({ name: "Curveil Price Reports", version: "1", chainId, verifyingContract: verifier }) as const;

export type ReportInput = { feedId: Hex; price: bigint; timestamp: number };

export async function signReport(signer: LocalAccount, chainId: number, verifier: Address, r: ReportInput): Promise<Hex> {
  const signature = await signer.signTypedData({
    domain: reportDomain(chainId, verifier),
    types: REPORT_TYPES,
    primaryType: "PriceReport",
    message: { feedId: r.feedId, price: r.price, timestamp: BigInt(r.timestamp) },
  });
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes" }],
    [r.feedId, r.price, BigInt(r.timestamp), signature],
  );
}
