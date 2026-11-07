import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Traditional Chinese map", () => {
  it("is up to date with the Simplified texts in src/", () => {
    expect(() => execFileSync("node", ["scripts/zh-hant.mjs", "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
