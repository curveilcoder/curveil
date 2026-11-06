// The wasm build of circom cannot open files through pnpm's symlinked node_modules, so the
// pinned circomlib sources are copied into build/vendor first.
// Compiles every circuit with the pinned circom (wasm build) into build/<name>/.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CIRCUITS = ["transfer", "withdraw"];

const vendor = join(root, "build", "vendor");
cpSync(join(realpathSync(join(root, "node_modules", "circomlib")), "circuits"), join(vendor, "circomlib", "circuits"), { recursive: true });

const only = process.argv.slice(2);
for (const name of CIRCUITS.filter((n) => only.length === 0 || only.includes(n))) {
  const out = join(root, "build", name);
  mkdirSync(out, { recursive: true });
  execFileSync(
    "npx",
    ["circom2", join(root, "circuits", `${name}.circom`), "--r1cs", "--wasm", "--sym", "-l", vendor, "-o", out, "--O2"],
    { stdio: "inherit", cwd: root },
  );
}
