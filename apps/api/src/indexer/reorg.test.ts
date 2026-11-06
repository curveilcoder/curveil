import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { commonAncestor } = await import("./indexer");

describe("reorg handling", () => {
  const stored = [
    { number: 105, hash: "0x105a" },
    { number: 103, hash: "0x103a" },
    { number: 100, hash: "0x100a" },
  ];

  it("keeps the cursor when nothing changed", () => {
    expect(commonAncestor(stored, [{ hash: "0x105a" }, { hash: "0x103a" }, { hash: "0x100a" }], 90)).toEqual({ number: 105, hash: "0x105a" });
  });

  it("rewinds to the highest block both sides agree on", () => {
    expect(commonAncestor(stored, [{ hash: "0x105b" }, { hash: "0x103a" }, { hash: "0x100a" }], 90)).toEqual({ number: 103, hash: "0x103a" });
    expect(commonAncestor(stored, [{ hash: "0x105b" }, { hash: "0x103b" }, { hash: "0x100a" }], 90)).toEqual({ number: 100, hash: "0x100a" });
  });

  it("restarts from the start block when no checkpoint survives", () => {
    expect(commonAncestor(stored, [{ hash: "x" }, null, { hash: "y" }], 90)).toEqual({ number: 89, hash: null });
  });
});
