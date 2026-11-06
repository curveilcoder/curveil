import { describe, expect, it } from "vitest";
import { nextDelay, RETRY_WINDOW_SECONDS } from "../src/retry";
import { decryptSecret, encryptSecret, newSigningSecret } from "../src/secrets";

describe("retry schedule", () => {
  it("doubles from 30 seconds, caps at 12 hours and ends at 24 hours", () => {
    const start = 1_000_000;
    let t = start;
    const delays: number[] = [];
    for (;;) {
      const d = nextDelay(start, t);
      if (d === null) break;
      delays.push(d);
      t += d;
    }
    expect(delays.slice(0, 6)).toEqual([30, 30, 60, 120, 240, 480]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(43_200);
    expect(t - start).toBe(RETRY_WINDOW_SECONDS);
    expect(delays.length).toBeLessThan(20);
  });
});

describe("secrets at rest", () => {
  const master = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  it("round-trips, and only for the same subscription", async () => {
    const s = newSigningSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const sealed = await encryptSecret(s, "whk_a", master);
    expect(await decryptSecret(sealed, "whk_a", master)).toBe(s);
    await expect(decryptSecret(sealed, "whk_b", master)).rejects.toThrow();
  });
});
