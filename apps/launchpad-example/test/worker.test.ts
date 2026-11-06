import { describe, expect, it } from "vitest";
import { signWebhook } from "@curveil/sdk/webhooks";
import worker from "../worker/index";

const SECRET = "whsec_test_only";

function env() {
  const store = new Map<string, { value: string; metadata: unknown }>();
  const kv = {
    put: async (k: string, value: string, o?: { metadata?: unknown }) => void store.set(k, { value, metadata: o?.metadata }),
    list: async ({ prefix, limit }: { prefix: string; limit: number }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name, metadata: store.get(name)!.metadata })),
    }),
  };
  return {
    store,
    env: { ASSETS: { fetch: async () => new Response("asset") }, EVENTS: kv, LAUNCHPAD: "sprout", NETWORK: "testnet", API_URL: "https://api.example", WEBHOOK_SECRET: SECRET } as never,
  };
}

async function delivery(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  return new Request("https://pad.example/webhooks", { method: "POST", body, headers: { "Curveil-Signature": await signWebhook(secret, body, at) } });
}

const event = (id: string, createdAt = "2026-11-02T00:00:00.000Z") => JSON.stringify({ id, type: "launch.created", network: "testnet", chainId: 46630, createdAt, block: null, transactionHash: "0xabc", logIndex: 0, finality: "sequencer", data: { token: "0x1" } });

describe("launchpad example worker", () => {
  it("keeps each event once, newest first, even when deliveries arrive together", async () => {
    const { env: e } = env();
    const sent = await Promise.all([
      worker.fetch(await delivery(event("evt_1", "2026-11-02T00:00:01.000Z")), e),
      worker.fetch(await delivery(event("evt_1", "2026-11-02T00:00:01.000Z")), e),
      worker.fetch(await delivery(event("evt_2", "2026-11-02T00:00:02.000Z")), e),
      worker.fetch(await delivery(event("evt_3", "2026-11-02T00:00:03.000Z")), e),
    ]);
    expect(sent.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const { events } = (await (await worker.fetch(new Request("https://pad.example/webhooks/recent"), e)).json()) as { events: { id: string }[] };
    expect(events.map((x) => x.id)).toEqual(["evt_3", "evt_2", "evt_1"]);
  });

  it("refuses a wrong secret, a tampered body and an old timestamp", async () => {
    const { env: e, store } = env();
    expect((await worker.fetch(await delivery(event("evt_1"), "whsec_other"), e)).status).toBe(401);
    const good = await delivery(event("evt_1"));
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: event("evt_9") });
    expect((await worker.fetch(tampered, e)).status).toBe(401);
    expect((await worker.fetch(await delivery(event("evt_1"), SECRET, Math.floor(Date.now() / 1000) - 3600), e)).status).toBe(401);
    expect(store.size).toBe(0);
  });

  it("serves its config and falls through to the static site", async () => {
    const { env: e } = env();
    const cfg = (await (await worker.fetch(new Request("https://pad.example/config.json"), e)).json()) as { launchpad: string; webhooks: boolean };
    expect(cfg).toMatchObject({ launchpad: "sprout", webhooks: true });
    expect(await (await worker.fetch(new Request("https://pad.example/"), e)).text()).toBe("asset");
  });
});
