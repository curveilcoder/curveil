// Builds @curveil/sdk and packs it into public/sdk/ so the site serves an installable tarball
// (npm install <site>/sdk/curveil-sdk-<version>.tgz) until the package is on npm.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(here, "../../../packages/sdk");
const target = resolve(here, "../public/sdk");
const { version } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
mkdirSync(target, { recursive: true });
for (const f of readdirSync(target)) if (f.endsWith(".tgz")) rmSync(join(target, f));
execFileSync("pnpm", ["pack", "--pack-destination", target], { cwd: sdk, stdio: ["ignore", "ignore", "inherit"] });
const out = readdirSync(target).filter((f) => f.endsWith(".tgz"));
if (out.length !== 1 || out[0] !== `curveil-sdk-${version}.tgz`) throw new Error(`unexpected pack output: ${out.join(", ")}`);
console.log(`sdk: public/sdk/${out[0]}`);
