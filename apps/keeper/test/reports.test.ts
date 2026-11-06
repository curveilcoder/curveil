import { describe, expect, it } from "vitest";
import { decodeAbiParameters, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REPORT_TYPES, feedIdOf, reportDomain, signReport } from "../src/reports";

// Throwaway key for this test only.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const verifier = "0x15f7954E15DdA7758472657B91C536AB6A954784";

describe("reports", () => {
  it("encodes a report the verifier can recover", async () => {
    const feedId = feedIdOf("ETH/USD");
    expect(feedId).toBe("0x0b43555ace6b39aae1b894097d0a9fc17f504c62fea598fa206cc6f5088e6e45");
    const report = await signReport(signer, 46630, verifier, { feedId, price: 3_500n * 10n ** 18n, timestamp: 1_793_622_944 });
    const [f, price, ts, sig] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes" }], report);
    expect([f, price, ts]).toEqual([feedId, 3_500n * 10n ** 18n, 1_793_622_944n]);
    const who = await recoverTypedDataAddress({
      domain: reportDomain(46630, verifier),
      types: REPORT_TYPES,
      primaryType: "PriceReport",
      message: { feedId, price, timestamp: ts },
      signature: sig as Hex,
    });
    expect(who).toBe(signer.address);
  });
});
