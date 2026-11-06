// Copies the proving artifacts (circuit wasm and zkey) into public/circuits/<network>/ so the
// site serves them same-origin. Each file is checked against the setup record first; the
// prover checks them again in the browser against the hashes in the deployment manifest.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../../packages/circuits/artifacts");
const target = resolve(here, "../public/circuits");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

for (const network of readdirSync(source)) {
  const setupPath = join(source, network, "setup.json");
  if (!existsSync(setupPath)) continue;
  const setup = JSON.parse(readFileSync(setupPath, "utf8"));
  mkdirSync(join(target, network), { recursive: true });
  for (const [name, c] of Object.entries(setup.circuits)) {
    for (const ext of ["wasm", "zkey"]) {
      const from = join(source, network, `${name}.${ext}`);
      const to = join(target, network, `${name}.${ext}`);
      if (sha256(from) !== c[ext]) throw new Error(`${from} does not match its setup hash`);
      if (existsSync(to) && sha256(to) === c[ext]) continue;
      copyFileSync(from, to);
      console.log(`circuits: ${network}/${name}.${ext}`);
    }
  }
}
