import { describe, expect, it } from "vitest";
import { hashTypedData, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { findSignatures, normalizeSig, packSignatures, safeTypedData, signer } from "./safe";

const SAFE = "0x2968bFEB9273411Bd2A8cF6996F19d5aeCc01E4C" as const;
const tx = { to: "0xC865861EdBfb4A36d69F0D5110b23ce91A2619c2" as const, value: 0n, data: "0x1234" as const, nonce: 0n };
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);

describe("safe signatures", () => {
  it("accepts wallets that end signatures with v = 0 or 1", async () => {
    const sig = await owner.signTypedData(safeTypedData(SAFE, 4663, tx));
    const hash = hashTypedData(safeTypedData(SAFE, 4663, tx));
    const low = `${sig.slice(0, 130)}0${parseInt(sig.slice(130), 16) - 27}`;
    expect(normalizeSig(low)).toBe(sig);
    expect(await signer(hash, low)).toBe(owner.address);
  });

  it("reads signatures out of a shared link", async () => {
    const a = await owner.signTypedData(safeTypedData(SAFE, 4663, tx));
    const b = await owner.signTypedData(safeTypedData(SAFE, 4663, { ...tx, nonce: 1n }));
    expect(findSignatures(`https://curveil.app/safe#sigs=${a},${b}`)).toEqual([a, b]);
  });

  it("orders packed signatures by owner address", () => {
    const s1 = `0x${"aa".repeat(65)}` as const;
    const s2 = `0x${"bb".repeat(65)}` as const;
    expect(packSignatures([{ owner: "0xff00000000000000000000000000000000000000", sig: s1 }, { owner: zeroAddress, sig: s2 }])).toBe(`0x${"bb".repeat(65)}${"aa".repeat(65)}`);
  });
});
