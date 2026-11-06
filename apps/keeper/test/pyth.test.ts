import { describe, expect, it } from "vitest";
import { decodeAbiParameters, keccak256, toBytes, type Hex } from "viem";
import { encodeReport, firstAfter, hermesUrl, latest, latestEach, parseHermes, pythToWad } from "../src/pyth";

const ETH = { feedId: keccak256(toBytes("ETH/USD")), pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as Hex };
const BTC = { feedId: keccak256(toBytes("BTC/USD")), pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" as Hex };

const body = (publishTime = 1793724528) => ({
  binary: { encoding: "hex", data: ["504e4155deadbeef"] },
  parsed: [
    { id: ETH.pythId.slice(2), price: { price: "228586524124", conf: "98765432", expo: -8, publish_time: publishTime }, metadata: { prev_publish_time: publishTime - 1 } },
    { id: BTC.pythId.slice(2), price: { price: "7733348091109", conf: "3000000000", expo: -8, publish_time: publishTime } },
  ],
});

const fakeFetch = (status: number, json: unknown, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;

describe("pyth", () => {
  it("scales Pyth prices to 18 decimals", () => {
    expect(pythToWad("228586524124", -8)).toBe(2285865241240000000000n);
    expect(pythToWad("5", 0)).toBe(5n * 10n ** 18n);
    expect(pythToWad("123", -20)).toBe(1n);
    expect(pythToWad("-1", -8)).toBeNull();
    expect(pythToWad("1", 2)).toBeNull();
  });

  it("builds Hermes URLs and keeps a provider's own query", () => {
    expect(hermesUrl(undefined, "/v2/updates/price/latest", [ETH.pythId])).toBe(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${ETH.pythId.slice(2)}&encoding=hex&parsed=true`,
    );
    expect(hermesUrl("https://pyth.example.com/hermes/?key=abc", "/v2/updates/price/100", [ETH.pythId])).toBe(
      `https://pyth.example.com/hermes/v2/updates/price/100?ids[]=${ETH.pythId.slice(2)}&encoding=hex&parsed=true&key=abc`,
    );
  });

  it("wraps the update as the report PythReportVerifier decodes", () => {
    const [eth, btc] = parseHermes(body(), [ETH, BTC]);
    expect(eth!.priceWad).toBe(2285865241240000000000n);
    expect(eth!.prevPublishTime).toBe(1793724527);
    expect(btc!.priceWad).toBe(77333480911090000000000n);
    const [feedId, data] = decodeAbiParameters([{ type: "bytes32" }, { type: "bytes[]" }], eth!.report);
    expect(feedId).toBe(ETH.feedId);
    expect(data).toEqual(["0x504e4155deadbeef"]);
    expect(eth!.report).toBe(encodeReport(ETH.feedId, ["0x504e4155deadbeef"]));
  });

  it("leaves out feeds Hermes did not price and refuses an empty answer", () => {
    const sol = { feedId: keccak256(toBytes("SOL/USD")), pythId: "0x01" as Hex };
    expect(parseHermes(body(), [sol])).toEqual([]);
    expect(() => parseHermes({ binary: { encoding: "hex", data: [] } }, [ETH])).toThrow();
  });

  it("asks for every feed at once for the latest prices", async () => {
    const seen: string[] = [];
    const got = await latest(undefined, [ETH, BTC], fakeFetch(200, body(), seen));
    expect(got).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/v2/updates/price/latest?");
  });

  it("fetches the first update at or after a time, or null while there is none", async () => {
    const seen: string[] = [];
    const p = await firstAfter(undefined, ETH, 1793724528, fakeFetch(200, body(), seen));
    expect(seen[0]).toContain("/v2/updates/price/1793724528?");
    expect(p!.publishTime).toBe(1793724528);
    expect(await firstAfter(undefined, ETH, 1793724600, fakeFetch(404, { message: "not found" }))).toBeNull();
    // an answer from before the time is not the first after it
    expect(await firstAfter(undefined, ETH, 1793724529, fakeFetch(200, body(1793724528)))).toBeNull();
    await expect(firstAfter(undefined, ETH, 1, fakeFetch(500, {}))).rejects.toThrow("Hermes answered 500");
  });

  it("sends the Pyth API key as a Bearer token, and none when there is no key", async () => {
    const auth: (string | null)[] = [];
    const spy = (async (_url: string, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify(body()), { status: 200 });
    }) as unknown as typeof fetch;
    await latest({ url: "https://pyth.dourolabs.app/hermes", key: "k123" }, [ETH], spy);
    await firstAfter({ key: "k123" }, ETH, 1793724528, spy);
    await latest(undefined, [ETH], spy);
    expect(auth).toEqual(["Bearer k123", "Bearer k123", null]);
  });

  it("asks feed by feed when Hermes refuses the batch, so a feed outside the plan does not stop the rest", async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => {
      seen.push(url);
      const btc = url.includes(BTC.pythId.slice(2));
      return btc ? new Response("Not entitled: feed", { status: 403 }) : new Response(JSON.stringify(body()), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await latestEach({ key: "k" }, [ETH, BTC], spy);
    expect(seen).toHaveLength(3);
    expect(r.prices.map((p) => p.feedId)).toEqual([ETH.feedId]);
    expect(r.errors.get(BTC.feedId.toLowerCase())).toBe("Hermes answered 403: Not entitled: feed");
    // Other failures still fail the whole call.
    await expect(latestEach({ key: "k" }, [ETH, BTC], fakeFetch(500, {}))).rejects.toThrow(/500/);
  });
});
