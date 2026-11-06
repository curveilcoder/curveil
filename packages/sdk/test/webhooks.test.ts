import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { signWebhook, verifyWebhook, WebhookVerificationError } from "../src/webhooks";
import { encodeBrandURI, isValidSlug, launchpadRegistryAbi, registerOperatorTx, templateMask, createLaunchTx, launchFactoryAbi } from "../src/tx";
import { siweMessage } from "../src/client";

const secret = "whsec_test_secret";
const body = JSON.stringify({ id: "evt_1", type: "swap", data: { amountIn: "1" } });

describe("webhook signatures", () => {
  it("verifies what it signs", async () => {
    const sig = await signWebhook(secret, body, 1_800_000_000);
    expect(sig).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    const e = await verifyWebhook({ secret, body, signature: sig, now: 1_800_000_010 });
    expect(e.id).toBe("evt_1");
  });

  it("rejects a changed body, a wrong secret, an old timestamp and junk", async () => {
    const sig = await signWebhook(secret, body, 1_800_000_000);
    await expect(verifyWebhook({ secret, body: body.replace('"1"', '"2"'), signature: sig, now: 1_800_000_000 })).rejects.toThrow(WebhookVerificationError);
    await expect(verifyWebhook({ secret: "whsec_other", body, signature: sig, now: 1_800_000_000 })).rejects.toThrow("No signature matches");
    await expect(verifyWebhook({ secret, body, signature: sig, now: 1_800_000_301 })).rejects.toThrow("tolerance");
    await expect(verifyWebhook({ secret, body, signature: "nope", now: 1_800_000_000 })).rejects.toThrow("Malformed");
    await expect(verifyWebhook({ secret, body, signature: null })).rejects.toThrow("Missing");
  });

  it("accepts any matching v1 value (for rotation)", async () => {
    const sig = await signWebhook(secret, body, 1_800_000_000);
    const both = `t=1800000000,v1=${"0".repeat(64)},${sig.split(",")[1]}`;
    await expect(verifyWebhook({ secret, body, signature: both, now: 1_800_000_000 })).resolves.toBeTruthy();
  });
});

describe("transaction helpers", () => {
  it("encodes a launchpad registration", () => {
    const t = registerOperatorTx({
      registry: "0xDE74faf148b1E6a74045874EfCc846C8311B030a",
      slug: "petal-pad",
      brandURI: encodeBrandURI({ name: "Petal Pad", accent: "#ff6699" }),
      shareBps: 4000,
      templates: [0, 1],
      recipients: [
        { address: "0x00000000000000000000000000000000000000A1", weightBps: 7000 },
        { address: "0x00000000000000000000000000000000000000b2", weightBps: 3000 },
      ],
    });
    const d = decodeFunctionData({ abi: launchpadRegistryAbi, data: t.data });
    expect(d.functionName).toBe("register");
    expect(d.args[0]).toBe("petal-pad");
    expect(d.args[3]).toBe(3n);
    expect(decodeURIComponent(String(d.args[1]).split(",")[1]!)).toBe('{"name":"Petal Pad","accent":"#ff6699"}');
  });

  it("checks slugs, weights and brand size", () => {
    expect(isValidSlug("petal-pad")).toBe(true);
    expect(isValidSlug("-bad")).toBe(false);
    expect(isValidSlug("Ab")).toBe(false);
    expect(templateMask([0, 2])).toBe(5n);
    expect(() => registerOperatorTx({ registry: "0x0000000000000000000000000000000000000001", slug: "ok-pad", brandURI: "", shareBps: 0, templates: [0], recipients: [{ address: "0x0000000000000000000000000000000000000002", weightBps: 9999 }] })).toThrow();
    expect(() => encodeBrandURI({ name: "x".repeat(3000) })).toThrow("too long");
  });

  it("puts the operator into createLaunch", () => {
    const op = "0x00000000000000000000000000000000000000c3";
    const t = createLaunchTx({ factory: "0x8085E9791787e50A2049e76c97d1F5bde50f4045", templateId: 1, name: "A", symbol: "A", metadataURI: "", creatorRecipient: op, operator: op, deadline: 1n });
    const d = decodeFunctionData({ abi: launchFactoryAbi, data: t.data });
    expect((d.args[0] as { operator: string }).operator.toLowerCase()).toBe(op);
  });

  it("builds an EIP-4361 message", () => {
    const m = siweMessage({ domain: "curveil.example", address: "0x00000000000000000000000000000000000000A1", uri: "https://curveil.example", nonce: "abc12345", chainId: 46630, statement: "Sign in", issuedAt: new Date("2026-11-02T00:00:00Z") });
    expect(m.split("\n")[0]).toBe("curveil.example wants you to sign in with your Ethereum account:");
    expect(m).toContain("Chain ID: 46630");
  });
});
