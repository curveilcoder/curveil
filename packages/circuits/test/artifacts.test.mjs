// The proving artifacts on disk must be exactly the ones the setup record and the deployment
// manifest name: the browser prover refuses anything else, so a mismatch breaks every proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(here, "../artifacts");
const manifests = resolve(here, "../../manifest/manifests");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

for (const network of readdirSync(artifacts)) {
  const setupPath = join(artifacts, network, "setup.json");
  if (!existsSync(setupPath)) continue;
  const setup = JSON.parse(readFileSync(setupPath, "utf8"));

  test(`${network}: wasm, zkey and vkey match the setup record`, () => {
    for (const [name, c] of Object.entries(setup.circuits)) {
      for (const ext of ["wasm", "zkey"]) assert.equal(sha256(join(artifacts, network, `${name}.${ext}`)), c[ext], `${name}.${ext}`);
      assert.equal(sha256(join(artifacts, network, `${name}.vkey.json`)), c.vkey, `${name}.vkey.json`);
    }
  });

  test(`${network}: the deployment manifest names the same artifacts`, () => {
    const path = join(manifests, `${network}.json`);
    assert.ok(existsSync(path), `no manifest for ${network}`);
    const m = JSON.parse(readFileSync(path, "utf8"));
    for (const [name, c] of Object.entries(setup.circuits)) {
      const entry = m.circuits.find((x) => x.name === name);
      assert.ok(entry, `manifest lists ${name}`);
      assert.equal(entry.version, c.schema);
      assert.equal(entry.wasmHash, `0x${c.wasm}`);
      assert.equal(entry.zkeyHash, `0x${c.zkey}`);
      assert.equal(entry.vkeyHash, `0x${c.vkey}`);
    }
  });
}
