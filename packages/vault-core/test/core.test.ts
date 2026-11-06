import { poseidon2 } from "poseidon-lite";
import { describe, expect, it } from "vitest";
import {
  FIELD,
  NoteTree,
  ZEROS,
  backup,
  commitment,
  decodeAddress,
  deriveKeys,
  encodeAddress,
  encryptNote,
  entropyToPhrase,
  fungibleResource,
  newEntropy,
  noteDomain,
  phraseToEntropy,
  planShield,
  rootFromPath,
  scanCommitments,
  selectNotes,
  tryDecryptNote,
  NOTE_CIPHERTEXT_LENGTH,
  protocolWithdrawFee,
} from "../src";
import { hexToBytes } from "viem";

const POOL = "0x00000000000000000000000000000000000000a1";
const TOKEN = "0xB80877C55B95A3998412cb0ddf40E643EDa3F102";

describe("keys and addresses", () => {
  it("round-trips the recovery phrase and derives the same keys", () => {
    const entropy = newEntropy();
    const phrase = entropyToPhrase(entropy);
    expect(phrase.split(" ")).toHaveLength(24);
    const back = phraseToEntropy(`  ${phrase.toUpperCase().replace(/ /g, "   ")} `);
    expect(back).toEqual(entropy);
    const a = deriveKeys(entropy);
    const b = deriveKeys(back);
    expect(a.spendingKey).toBe(b.spendingKey);
    expect(a.ownerKey).toBe(b.ownerKey);
    expect(a.viewingPublic).toEqual(b.viewingPublic);
    expect(a.spendingKey < FIELD).toBe(true);
  });

  it("rejects a phrase with a changed word", () => {
    const words = entropyToPhrase(newEntropy()).split(" ");
    words[3] = words[3] === "abandon" ? "ability" : "abandon";
    expect(() => phraseToEntropy(words.join(" "))).toThrow();
    expect(() => phraseToEntropy("abandon abandon")).toThrow(/24 words/);
  });

  it("encodes and decodes shielded addresses and catches typos", () => {
    const k = deriveKeys(newEntropy());
    const addr = encodeAddress(k);
    expect(addr.startsWith("cvl1")).toBe(true);
    const d = decodeAddress(addr);
    expect(d.ownerKey).toBe(k.ownerKey);
    expect(d.viewingPublic).toEqual(k.viewingPublic);
    const typo = addr.slice(0, 10) + (addr[10] === "q" ? "p" : "q") + addr.slice(11);
    expect(() => decodeAddress(typo)).toThrow();
  });
});

describe("note encryption", () => {
  it("opens only for the recipient and detects tampering", () => {
    const alice = deriveKeys(newEntropy());
    const bob = deriveKeys(newEntropy());
    const p = { resource: fungibleResource(TOKEN), amount: 123_456_789n, blinding: 42n };
    const ct = encryptNote(p, bob.viewingPublic);
    expect(ct.length).toBe(NOTE_CIPHERTEXT_LENGTH);
    expect(tryDecryptNote(ct, bob.viewingPrivate, bob.viewingPublic)).toEqual(p);
    expect(tryDecryptNote(ct, alice.viewingPrivate, alice.viewingPublic)).toBeNull();
    const bad = ct.slice();
    bad[80] = bad[80]! ^ 1;
    expect(tryDecryptNote(bad, bob.viewingPrivate, bob.viewingPublic)).toBeNull();
  });

  it("scanning keeps only notes that re-open their commitment", () => {
    const me = deriveKeys(newEntropy());
    const other = deriveKeys(newEntropy());
    const domain = noteDomain(46630, POOL);
    const resource = fungibleResource(TOKEN);
    const s1 = planShield(me, resource, 5_000_000n);
    const s2 = planShield(other, resource, 7n);
    const cm1 = commitment(s1.note, domain);
    const cm2 = commitment(s2.note, domain);
    const items = [
      { leafIndex: 0, commitment: cm1, encryptedNote: hexToBytes(s1.encryptedNote) },
      { leafIndex: 1, commitment: cm2, encryptedNote: hexToBytes(s2.encryptedNote) },
      // My ciphertext attached to someone else's commitment is ignored.
      { leafIndex: 2, commitment: cm2, encryptedNote: hexToBytes(s1.encryptedNote) },
    ];
    const found = scanCommitments(me, domain, items);
    expect(found).toHaveLength(1);
    expect(found[0]!.leafIndex).toBe(0);
    expect(found[0]!.amount).toBe(5_000_000n);
  });
});

describe("note tree", () => {
  it("matches the empty root and verifies paths after incremental and bulk appends", () => {
    expect(new NoteTree().root()).toBe(ZEROS[24]);
    const leaves = Array.from({ length: 37 }, (_, i) => BigInt(i + 1) * 1000003n);
    const bulk = new NoteTree(leaves);
    const inc = new NoteTree();
    for (const l of leaves.slice(0, 5)) inc.append([l]);
    inc.append(leaves.slice(5, 20));
    inc.append(leaves.slice(20));
    expect(inc.root()).toBe(bulk.root());
    for (const i of [0, 1, 16, 36]) expect(rootFromPath(leaves[i]!, i, bulk.path(i))).toBe(bulk.root());
    // Small manual check at depth 1.
    const t = new NoteTree([5n], 1);
    expect(t.root()).toBe(poseidon2([5n, ZEROS[0]!]));
  });
});

describe("selection and fees", () => {
  it("picks the smallest sufficient note, else the tightest pair, else null", () => {
    const n = (amount: bigint, id: number) => ({ amount, id });
    const notes = [n(10n, 1), n(50n, 2), n(30n, 3), n(5n, 4)];
    expect(selectNotes(notes, 25n)!.map((x) => x.id)).toEqual([3]);
    expect(selectNotes(notes, 70n)!.map((x) => x.id).sort()).toEqual([2, 3]);
    expect(selectNotes(notes, 100n)).toBeNull();
  });

  it("rounds the protocol fee up", () => {
    expect(protocolWithdrawFee(1_000_000n, 10)).toBe(1000n);
    expect(protocolWithdrawFee(1_000_001n, 10)).toBe(1001n);
    expect(protocolWithdrawFee(0n, 10)).toBe(0n);
  });
});

describe("backup envelope", () => {
  it("round-trips and rejects the wrong passphrase", async () => {
    const data = { entropy: "ab".repeat(32), createdAt: "2026-11-02T00:00:00Z" };
    const { envelope } = await backup.seal("correct horse battery staple", data);
    const raw = JSON.parse(JSON.stringify(envelope));
    const { data: back } = await backup.open<typeof data>("correct horse battery staple", raw);
    expect(back).toEqual(data);
    await expect(backup.open("wrong", raw)).rejects.toThrow(/Wrong passphrase/);
    expect(() => backup.parseEnvelope({ format: "x" })).toThrow();
  }, 30_000);
});
