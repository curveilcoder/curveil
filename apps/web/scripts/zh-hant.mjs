// Builds src/lib/zh-hant.json: every run of Simplified Chinese text in src/, converted to
// Traditional Chinese (Taiwan phrasing) with OpenCC. Only runs that change are kept.
// Run `node scripts/zh-hant.mjs` after editing Chinese text; `--check` fails if the file is stale.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OpenCC from "opencc-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../src");
const out = join(root, "lib/zh-hant.json");
const RUN = /[　-〿㐀-鿿＀-￯]+/g;
const convert = OpenCC.Converter({ from: "cn", to: "twp" });

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const map = {};
for (const f of files(root)) {
  for (const [run] of readFileSync(f, "utf8").matchAll(RUN)) {
    const t = convert(run);
    if (t !== run) map[run] = t;
  }
}
const json = JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))), null, 0).replace(/","/g, '",\n"') + "\n";
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(out, "utf8"); } catch { /* missing */ }
  if (cur !== json) { console.error("src/lib/zh-hant.json is out of date: run node scripts/zh-hant.mjs"); process.exit(1); }
} else {
  writeFileSync(out, json);
  console.log(`zh-hant.json: ${Object.keys(map).length} runs`);
}
