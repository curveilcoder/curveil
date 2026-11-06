// Multi-party trusted setup (phase 2) for the vault circuits.
//
// Groth16 is sound as long as one contributor destroys their randomness. The ceremony starts
// from a public phase-1 file (Powers of Tau) that many people already contributed to, then
// each contributor adds randomness to every circuit's key in turn, a public random beacon
// closes it, and anyone can re-check the whole chain from the published files.
//
//   init        node scripts/ceremony.mjs init --dir <d> --ptau <file> --ptau-sha256 <hex> --ptau-source "<where it is published>"
//   contribute  node scripts/ceremony.mjs contribute --dir <d> --name "<public name>"
//   import      node scripts/ceremony.mjs import --dir <d> --name "<public name>" --transfer <zkey> --withdraw <zkey>
//               (a contribution made elsewhere, such as the site's /ceremony page)
//   verify      node scripts/ceremony.mjs verify --dir <d>
//   beacon      node scripts/ceremony.mjs beacon --dir <d> --hash <hex> --source "<e.g. Ethereum block N hash>" [--iterations 10]
//   finalize    node scripts/ceremony.mjs finalize --dir <d> --network mainnet [--out artifacts/mainnet] [--verifiers <contracts dir>] [--label "<text>"]
//
// The directory holds the keys (<circuit>_<nnnn>.zkey) and transcript.json. Contributors
// receive the directory, run `contribute` on their own machine, and send it back; their
// contribution hash is printed so they can publish it where others can see it.
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CIRCUITS = [
  { name: "transfer", contract: "TransferVerifier", schema: "transfer/v1" },
  { name: "withdraw", contract: "WithdrawVerifier", schema: "withdraw/v1" },
];
const quiet = { log: () => {}, info: () => {}, debug: () => {}, warn: console.warn, error: console.error };
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

function args() {
  const out = {};
  const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) throw new Error(`unexpected argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
    i++;
  }
  return out;
}

const need = (o, k) => {
  if (!o[k]) throw new Error(`--${k} is required`);
  return o[k];
};
const tPath = (dir) => join(dir, "transcript.json");
const load = (dir) => JSON.parse(readFileSync(tPath(dir), "utf8"));
const save = (dir, t) => writeFileSync(tPath(dir), JSON.stringify(t, null, 2) + "\n");
const zkeyName = (c, i) => `${c}_${String(i).padStart(4, "0")}.zkey`;
const r1csOf = (c) => join(root, "build", c, `${c}.r1cs`);
const latest = (t, c) => t.circuits[c].contributions.at(-1);

async function init(o) {
  const dir = resolve(need(o, "dir"));
  const ptau = resolve(need(o, "ptau"));
  const expected = need(o, "ptau-sha256").toLowerCase();
  if (existsSync(tPath(dir))) throw new Error(`${dir} already holds a ceremony`);
  const got = sha256(ptau);
  if (got !== expected) throw new Error(`phase-1 file sha256 is ${got}, expected ${expected}`);
  mkdirSync(dir, { recursive: true });
  const t = {
    schema: "curveil-ceremony/1",
    startedAt: new Date().toISOString(),
    snarkjs: "0.7.6",
    compiler: "circom 2.2.3 (circom2 npm 0.2.23)",
    ptau: { file: ptau, sha256: got, source: need(o, "ptau-source") },
    circuits: {},
    beacon: null,
    finalized: null,
  };
  for (const c of CIRCUITS) {
    const r1cs = r1csOf(c.name);
    const z0 = join(dir, zkeyName(c.name, 0));
    await snarkjs.zKey.newZKey(r1cs, ptau, z0, quiet);
    t.circuits[c.name] = {
      schema: c.schema,
      r1cs: sha256(r1cs),
      contributions: [{ index: 0, name: "initial (no randomness)", zkey: sha256(z0), hash: null, at: t.startedAt }],
    };
    console.log(`${c.name}: initial key ${sha256(z0).slice(0, 16)}…`);
  }
  save(dir, t);
  console.log(`Ceremony ready in ${dir}. Next: contribute.`);
}

async function contribute(o) {
  const dir = resolve(need(o, "dir"));
  const name = need(o, "name");
  const t = load(dir);
  if (t.beacon) throw new Error("the beacon has closed this ceremony");
  await checkFiles(dir, t);
  const receipts = [];
  for (const c of CIRCUITS) {
    const prev = latest(t, c.name);
    const next = prev.index + 1;
    const out = join(dir, zkeyName(c.name, next));
    // Fresh randomness per circuit, held only in memory and dropped when the process exits.
    const hash = await snarkjs.zKey.contribute(join(dir, zkeyName(c.name, prev.index)), out, name, randomBytes(64).toString("hex"), quiet);
    t.circuits[c.name].contributions.push({ index: next, name, zkey: sha256(out), hash: hex(hash), at: new Date().toISOString() });
    receipts.push(`${c.name} #${next}: ${hex(hash)}`);
  }
  save(dir, t);
  console.log(`Thank you, ${name}. Publish these contribution hashes so anyone can check them:`);
  for (const r of receipts) console.log(`  ${r}`);
}

/** Every key file listed in the transcript is present and unchanged. */
async function checkFiles(dir, t) {
  for (const c of CIRCUITS) {
    if (sha256(r1csOf(c.name)) !== t.circuits[c.name].r1cs) throw new Error(`${c.name}: the compiled circuit differs from the one this ceremony started with`);
    const last = latest(t, c.name);
    const file = join(dir, zkeyName(c.name, last.index));
    if (!existsSync(file) || sha256(file) !== last.zkey) throw new Error(`${c.name}: ${zkeyName(c.name, last.index)} does not match the transcript`);
  }
}

async function verify(o) {
  const dir = resolve(need(o, "dir"));
  const t = load(dir);
  await checkFiles(dir, t);
  if (sha256(t.ptau.file) !== t.ptau.sha256) throw new Error("the phase-1 file changed");
  let ok = true;
  for (const c of CIRCUITS) {
    const last = latest(t, c.name);
    const lines = [];
    const capture = { ...quiet, info: (m) => lines.push(String(m)) };
    const valid = await snarkjs.zKey.verifyFromR1cs(r1csOf(c.name), t.ptau.file, join(dir, zkeyName(c.name, last.index)), capture);
    // snarkjs recomputes each contribution's hash from the key itself (newest first); every
    // one must match the hash the contributor published, at the same position.
    const found = new Map();
    for (const l of lines) {
      const m = /^contribution #(\d+)[^:]*:\s*([\s\S]*)$/.exec(l);
      if (m) found.set(Number(m[1]), m[2].replace(/\s+/g, "").toLowerCase());
    }
    const listed = t.circuits[c.name].contributions.filter((x) => x.hash);
    const hashesMatch = found.size === listed.length && listed.every((x) => found.get(x.index) === x.hash.toLowerCase());
    console.log(`${c.name}: ${valid ? "valid" : "INVALID"}, ${listed.length} contributions${t.beacon ? " including the beacon" : ""}, transcript ${hashesMatch ? "matches" : "DOES NOT MATCH"}`);
    for (const x of listed) console.log(`  #${x.index} ${x.name}: ${x.hash.slice(0, 32)}…`);
    ok &&= valid && hashesMatch;
  }
  if (!ok) {
    console.error("Verification failed.");
    process.exitCode = 1;
  } else console.log("The whole chain verifies.");
  return ok;
}

/**
 * Adds a contribution made outside this tool (the site's browser page runs the same snarkjs
 * call). Each new key must verify against the circuit and the phase-1 file, keep every earlier
 * contribution, and add exactly one new one; its hash is read back from the key itself.
 */
async function importContribution(o) {
  const dir = resolve(need(o, "dir"));
  const name = need(o, "name");
  const t = load(dir);
  if (t.beacon) throw new Error("the beacon has closed this ceremony");
  await checkFiles(dir, t);
  const staged = [];
  for (const c of CIRCUITS) {
    const src = resolve(need(o, c.name));
    const prev = latest(t, c.name);
    const next = prev.index + 1;
    const lines = [];
    const capture = { ...quiet, info: (m) => lines.push(String(m)) };
    const valid = await snarkjs.zKey.verifyFromR1cs(r1csOf(c.name), t.ptau.file, src, capture);
    if (!valid) throw new Error(`${c.name}: the new key does not verify`);
    const found = new Map();
    for (const l of lines) {
      const m = /^contribution #(\d+)[^:]*:\s*([\s\S]*)$/.exec(l);
      if (m) found.set(Number(m[1]), m[2].replace(/\s+/g, "").toLowerCase());
    }
    const listed = t.circuits[c.name].contributions.filter((x) => x.hash);
    if (found.size !== listed.length + 1 || !listed.every((x) => found.get(x.index) === x.hash.toLowerCase()) || !found.has(next))
      throw new Error(`${c.name}: the new key does not extend this ceremony by exactly one contribution`);
    staged.push({ c, src, next, hash: found.get(next) });
  }
  for (const { c, src, next, hash } of staged) {
    const out = join(dir, zkeyName(c.name, next));
    copyFileSync(src, out);
    t.circuits[c.name].contributions.push({ index: next, name, zkey: sha256(out), hash, at: new Date().toISOString(), via: "browser" });
    console.log(`${c.name} #${next}: ${hash}`);
  }
  save(dir, t);
  console.log(`Imported the contribution by ${name}.`);
}

async function beacon(o) {
  const dir = resolve(need(o, "dir"));
  const beaconHash = need(o, "hash").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(beaconHash)) throw new Error("--hash must be 32 bytes of hex");
  const iterations = Number(o.iterations ?? 10);
  const t = load(dir);
  if (t.beacon) throw new Error("the beacon was already applied");
  const people = t.circuits[CIRCUITS[0].name].contributions.filter((x) => x.hash).length;
  if (people < Number(o.min ?? 1)) throw new Error(`only ${people} contributions`);
  await checkFiles(dir, t);
  for (const c of CIRCUITS) {
    const prev = latest(t, c.name);
    const out = join(dir, zkeyName(c.name, prev.index + 1));
    const hash = await snarkjs.zKey.beacon(join(dir, zkeyName(c.name, prev.index)), out, "Final beacon", beaconHash, iterations, quiet);
    if (!hash) throw new Error(`${c.name}: beacon failed`);
    t.circuits[c.name].contributions.push({ index: prev.index + 1, name: "Final beacon", zkey: sha256(out), hash: hex(hash), at: new Date().toISOString() });
  }
  t.beacon = { hash: beaconHash, iterations, source: need(o, "source") };
  save(dir, t);
  console.log("Beacon applied. Next: verify, then finalize.");
}

async function finalize(o) {
  const dir = resolve(need(o, "dir"));
  const network = need(o, "network");
  const t = load(dir);
  if (!t.beacon) throw new Error("apply the beacon first");
  if (!(await verify({ dir }))) throw new Error("not finalizing a chain that does not verify");
  const out = resolve(o.out ?? join(root, "artifacts", network));
  const verifiers = o.verifiers ? resolve(o.verifiers) : null;
  mkdirSync(out, { recursive: true });
  const people = t.circuits[CIRCUITS[0].name].contributions.filter((x) => x.hash && x.name !== "Final beacon").length;
  const label = o.label ?? `Curveil ${network} ceremony (${people} contributors and a random beacon)`;
  const templates = { groth16: readFileSync(join(root, "node_modules", "snarkjs", "templates", "verifier_groth16.sol.ejs"), "utf8") };
  const record = { label, network, createdAt: new Date().toISOString(), compiler: t.compiler, snarkjs: t.snarkjs, ptau: { sha256: t.ptau.sha256, source: t.ptau.source }, beacon: t.beacon, contributors: people, circuits: {} };
  for (const c of CIRCUITS) {
    const last = latest(t, c.name);
    const zkey = join(out, `${c.name}.zkey`);
    copyFileSync(join(dir, zkeyName(c.name, last.index)), zkey);
    const vkey = await snarkjs.zKey.exportVerificationKey(zkey, quiet);
    writeFileSync(join(out, `${c.name}.vkey.json`), JSON.stringify(vkey, null, 2) + "\n");
    const wasm = join(root, "build", c.name, `${c.name}_js`, `${c.name}.wasm`);
    copyFileSync(wasm, join(out, `${c.name}.wasm`));
    if (verifiers) {
      mkdirSync(verifiers, { recursive: true });
      let sol = await snarkjs.zKey.exportSolidityVerifier(zkey, templates, quiet);
      sol = sol
        .replace("pragma solidity >=0.7.0 <0.9.0;", "pragma solidity 0.8.28;")
        .replace("contract Groth16Verifier {", `/// @notice Generated by snarkjs 0.7.6 from ${c.name}.zkey (${label}). Do not edit.\n///         Public-input schema: ${c.schema}.\ncontract ${c.contract} {`);
      writeFileSync(join(verifiers, `${c.contract}.sol`), sol);
    }
    record.circuits[c.name] = {
      schema: c.schema,
      nPublic: vkey.nPublic,
      r1cs: t.circuits[c.name].r1cs,
      wasm: sha256(wasm),
      zkey: sha256(zkey),
      vkey: sha256(join(out, `${c.name}.vkey.json`)),
      verifier: c.contract,
      contributions: t.circuits[c.name].contributions.filter((x) => x.hash).map(({ index, name, hash }) => ({ index, name, hash })),
    };
  }
  writeFileSync(join(out, "setup.json"), JSON.stringify(record, null, 2) + "\n");
  copyFileSync(tPath(dir), join(out, "transcript.json"));
  t.finalized = { at: record.createdAt, out };
  save(dir, t);
  console.log(`Wrote ${out}${verifiers ? ` and the verifiers in ${verifiers}` : ""}. Label: ${label}`);
}

const stages = { init, contribute, import: importContribution, verify, beacon, finalize };
const stage = stages[process.argv[2]];
if (!stage) throw new Error(`usage: ceremony.mjs ${Object.keys(stages).join("|")} [options]`);
await stage(args());
process.exit(process.exitCode ?? 0);
