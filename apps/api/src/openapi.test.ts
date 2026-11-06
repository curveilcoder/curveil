/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describedRoutes, openapiDocument } from "./openapi";

const norm = (r: string) => r.replace(/:\w+/g, ":p");

/** Routes declared in the route files: sub-apps are mounted at /v1, index.ts declares full paths. */
function servedRoutes(): string[] {
  const dir = resolve(import.meta.dirname);
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const src = readFileSync(resolve(dir, f), "utf8");
    for (const m of src.matchAll(/^\w+\.(get|post|patch|delete)\("([^"]+)"/gm)) {
      const p = m[2]!.startsWith("/v1/") || m[2] === "/health" ? m[2]! : `/v1${m[2]}`;
      if (p.startsWith("/v1/")) out.push(`${m[1]!.toUpperCase()} ${p}`);
    }
  }
  return out;
}

describe("openapi", () => {
  it("describes every route the app serves, and nothing else", () => {
    const served = new Set(servedRoutes().map(norm));
    const described = new Set(describedRoutes.map(norm));
    expect(served.size).toBeGreaterThan(40);
    expect([...served].filter((r) => !described.has(r))).toEqual([]);
    expect([...described].filter((r) => !served.has(r))).toEqual([]);
  });
  it("is a 3.1 document with the webhook events", () => {
    const d = openapiDocument("https://api.example", "testnet") as any;
    expect(d.openapi).toBe("3.1.0");
    expect(d.webhooks["launch.created"]).toBeTruthy();
    expect(new Set(Object.values(d.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId))).size).toBe(describedRoutes.length);
  });
});
