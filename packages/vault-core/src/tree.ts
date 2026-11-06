/**
 * The vault's note tree (docs/vault-spec.md 3.2): an append-only binary Poseidon Merkle
 * tree of depth 24. Empty leaves hold ZERO_LEAF; parent = Poseidon2(left, right).
 * The client rebuilds it from the public commitments in leaf order and checks the root
 * against the contract before proving.
 */
import { poseidon2 } from "poseidon-lite";
import { labelToField } from "./field";

export const TREE_LEVELS = 24;
export const ZERO_LEAF = labelToField("curveil.vault.zero");

export const ZEROS: readonly bigint[] = (() => {
  const z = [ZERO_LEAF];
  for (let i = 0; i < TREE_LEVELS; i++) z.push(poseidon2([z[i]!, z[i]!]));
  return z;
})();

export class NoteTree {
  readonly levels: number;
  /** layers[0] holds the leaves; layers[l] the filled nodes at height l. */
  private layers: bigint[][];

  constructor(leaves: readonly bigint[] = [], levels = TREE_LEVELS) {
    this.levels = levels;
    this.layers = Array.from({ length: levels + 1 }, () => []);
    if (leaves.length) this.append(leaves);
  }

  get size(): number {
    return this.layers[0]!.length;
  }

  leaf(index: number): bigint {
    const v = this.layers[0]![index];
    if (v === undefined) throw new Error(`leaf ${index} is not in the tree`);
    return v;
  }

  /** Appends leaves and recomputes only the affected nodes (about 2n hashes for n leaves). */
  append(leaves: readonly bigint[]): void {
    if (leaves.length === 0) return;
    const start = this.size;
    if (start + leaves.length > 2 ** this.levels) throw new Error("note tree is full");
    this.layers[0]!.push(...leaves);
    let from = start;
    let to = this.size - 1;
    for (let l = 0; l < this.levels; l++) {
      const layer = this.layers[l]!;
      const parent = this.layers[l + 1]!;
      const pFrom = from >> 1;
      const pTo = to >> 1;
      for (let p = pFrom; p <= pTo; p++) {
        const left = layer[2 * p] ?? ZEROS[l]!;
        const right = layer[2 * p + 1] ?? ZEROS[l]!;
        parent[p] = poseidon2([left, right]);
      }
      from = pFrom;
      to = pTo;
    }
  }

  root(): bigint {
    return this.layers[this.levels]![0] ?? ZEROS[this.levels]!;
  }

  /** Sibling path for the leaf at `index`, bottom to top. */
  path(index: number): bigint[] {
    if (index < 0 || index >= this.size) throw new Error(`leaf ${index} is not in the tree`);
    const out: bigint[] = [];
    let i = index;
    for (let l = 0; l < this.levels; l++) {
      out.push(this.layers[l]![i ^ 1] ?? ZEROS[l]!);
      i >>= 1;
    }
    return out;
  }
}

/** Recomputes a root from a leaf and its path (used to self-check before proving). */
export function rootFromPath(leaf: bigint, index: number, path: readonly bigint[]): bigint {
  let node = leaf;
  let i = index;
  for (const sibling of path) {
    node = i & 1 ? poseidon2([sibling, node]) : poseidon2([node, sibling]);
    i >>= 1;
  }
  return node;
}
