/**
 * Curveil perps keeper Worker. The Keeper Durable Object does the work on an alarm loop; this
 * Worker serves its status and current price reports (Pyth updates, or the testnet signer's
 * reports) that anyone can use to execute liquidations and orders or record a price themselves.
 * Requests fill only at the first price after them: fetch that one from Hermes. It also posts operational alerts
 * (src/alerts.ts) when ALERT_WEBHOOK_URL is set.
 *
 *   GET  /health          plain "ok"
 *   GET  /v1/status       keeper health: last tick, gas balance, prices, sources, recent actions
 *   GET  /v1/prices       current prices with reports anyone can submit
 *   POST /v1/kick         wake the keeper now (after submitting a request)
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { keeperStub } from "./keeper";
import type { Env } from "./env";

export { Keeper } from "./keeper";

const app = new Hono<{ Bindings: Env }>();

app.use("/v1/*", async (c, next) =>
  cors({
    origin: (origin) => {
      const allowed = c.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  })(c, next),
);

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

app.get("/health", (c) => c.text("ok"));

app.get("/v1/status", async (c) => {
  const stub = keeperStub(c.env);
  c.executionCtx.waitUntil(stub.kick());
  const s = await stub.getStatus();
  const age = s.lastTickAt ? (Date.now() - s.lastTickAt) / 1000 : null;
  const overdue = s.alarmAt !== null && Date.now() - s.alarmAt > 60_000;
  const health = !s.lastTickAt ? (overdue ? "stalled" : "starting") : age! > 120 || overdue ? "stalled" : s.consecutiveErrors > 3 ? "erroring" : s.gasLow ? "low_gas" : "ok";
  c.header("Cache-Control", "no-store");
  return c.json(json({ health, secondsSinceTick: age, ...s }));
});

app.get("/v1/prices", async (c) => {
  const stub = keeperStub(c.env);
  // Every read also restarts a stopped alarm loop (there is no cron trigger on this account).
  c.executionCtx.waitUntil(stub.kick());
  const out = await stub.signedPrices();
  c.header("Cache-Control", "no-store");
  if (!out.ok) return c.json({ error: "unavailable", message: out.error }, 503);
  return c.json(json({ network: c.env.NETWORK, ...out }));
});

app.post("/v1/kick", async (c) => c.json(await keeperStub(c.env).kick()));

app.notFound((c) => c.json({ error: "not_found", message: `No route for ${c.req.method} ${c.req.path}` }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: "The keeper hit an error. Please retry." }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(keeperStub(env).kick());
  },
} satisfies ExportedHandler<Env>;
