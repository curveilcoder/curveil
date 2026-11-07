/**
 * The vault account in this browser: keys, owned notes, pending actions and sync state.
 *
 * Everything private (the account entropy, notes, pending actions) is kept in IndexedDB only
 * inside an AES-GCM envelope keyed by the user's vault passphrase. Public chain data (every
 * commitment, ciphertext and nullifier) is cached in the clear, since every client downloads
 * the same data. Nothing private is ever sent to a server.
 */
import { useSyncExternalStore } from "react";
import {
  NoteTree,
  backup,
  deriveKeys,
  encodeAddress,
  noteDomain,
  scanCommitments,
  type OwnedNote,
  type VaultKeys,
} from "@curveil/vault-core";
import { bytesToHex, hexToBytes, type Address } from "viem";
import { API_URL, NETWORK, manifest } from "../config";
import { idbDelete, idbGet, idbSet } from "./idb";
import { tNow } from "../i18n";

export type StoredNote = {
  leafIndex: number;
  resource: string;
  amount: string;
  blinding: string;
  commitment: string;
  nullifier: string;
  spent: boolean;
};

export type PendingAction = {
  id: string;
  kind: "shield" | "transfer" | "withdraw" | "execute";
  label: string;
  createdAt: number;
  /** Nullifiers this action spends; its input notes are reserved until they appear on-chain. */
  nullifiers: string[];
  /** Notes this account expects back (change, or a deposit), shown as pending until found. */
  incoming: { commitment: string; resource: string; amount: string }[];
  txHash?: string;
  broadcastId?: string;
  state: "proving" | "submitted" | "failed";
  error?: string;
};

type PoolState = { scannedLeaf: number; notes: StoredNote[]; pending: PendingAction[] };
type Secret = { v: 1; entropy: string; createdAt: string; backupConfirmed: boolean; backupFileAt: string | null; pools: Record<string, PoolState> };
type PublicCache = { commitments: string[]; ciphertexts: string[]; nullifiers: string[]; nullifierBlock: number };

export type VaultStatus = {
  network: string;
  chainId: number;
  pool: Address;
  /** 2 for the execution-capable pool. */
  version?: number;
  /** The previous pool, still open for withdrawals (alternative client). */
  legacyPool?: Address | null;
  adapters?: { name: string; address: Address; status: "none" | "active" | "exit_only" }[];
  deployBlock: number;
  root: string;
  leafCount: number;
  withdrawFeeBps: number;
  shieldPaused: boolean;
  spendPaused: boolean;
  noteDomain: string;
  indexed: { leaves: number; lastLeaf: number | null; block: number | null };
  assets: {
    address: Address;
    symbol: string;
    label: string;
    decimals: number;
    resource: string;
    shieldingEnabled: boolean;
    maxDeposit: string;
    shieldedBalance: string;
  }[];
  circuits: { name: string; version: string; wasmHash: string; zkeyHash: string }[];
  setup: string;
};

export type SyncState =
  | { kind: "idle" }
  | { kind: "syncing"; leaves: number; of: number }
  | { kind: "synced"; leaves: number; at: number; rootMatches: boolean }
  | { kind: "error"; message: string };

export type VaultState = {
  phase: "loading" | "none" | "locked" | "unlocked" | "unavailable";
  error: string | null;
  address: string | null;
  backupConfirmed: boolean;
  backupFileAt: string | null;
  status: VaultStatus | null;
  sync: SyncState;
  notes: StoredNote[];
  pending: PendingAction[];
};

const ACCOUNT_KEY = `account:${NETWORK}`;
const publicKey = (pool: string) => `public:${NETWORK}:${pool.toLowerCase()}`;

// ---------------------------------------------------------------- in-memory session

let keys: VaultKeys | null = null;
let secret: Secret | null = null;
let storageKey: CryptoKey | null = null;
let storageSalt: Uint8Array | null = null;
let tree: NoteTree | null = null;
let treePool: string | null = null;
let cache: PublicCache | null = null;
let nullifierSet = new Set<string>();

let state: VaultState = {
  phase: "loading",
  error: null,
  address: null,
  backupConfirmed: false,
  backupFileAt: null,
  status: null,
  sync: { kind: "idle" },
  notes: [],
  pending: [],
};
const listeners = new Set<() => void>();

function set(patch: Partial<VaultState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useVault(): VaultState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const vaultKeys = () => keys;
export const vaultTree = () => tree;
export const vaultState = () => state;

function poolState(pool: string): PoolState {
  if (!secret) throw new Error(tNow("The vault is locked.", "金库已锁定。"));
  const k = pool.toLowerCase();
  secret.pools[k] ??= { scannedLeaf: 0, notes: [], pending: [] };
  return secret.pools[k]!;
}

function publish() {
  const pool = state.status?.pool;
  const ps = pool && secret ? poolState(pool) : null;
  set({
    address: keys ? encodeAddress(keys) : null,
    backupConfirmed: secret?.backupConfirmed ?? false,
    backupFileAt: secret?.backupFileAt ?? null,
    notes: ps ? [...ps.notes].sort((a, b) => b.leafIndex - a.leafIndex) : [],
    pending: ps ? [...ps.pending] : [],
  });
}

async function persist() {
  if (!secret || !storageKey || !storageSalt) return;
  const envelope = await backup.sealWithKey(storageKey, storageSalt, secret);
  await idbSet(ACCOUNT_KEY, envelope);
}

// ---------------------------------------------------------------- account lifecycle

export async function init() {
  if (state.phase !== "loading") return;
  try {
    const stored = await idbGet(ACCOUNT_KEY);
    set({ phase: stored ? "locked" : "none" });
  } catch (e) {
    set({ phase: "unavailable", error: e instanceof Error ? e.message : tNow("This browser cannot store a vault account.", "此浏览器无法保存金库账户。") });
  }
  void refreshStatus();
}

/** Saves a new or recovered account. Called only after the phrase check passed. */
export async function createAccount(entropy: Uint8Array, passphrase: string, opts: { recovered: boolean }) {
  const s: Secret = {
    v: 1,
    entropy: bytesToHex(entropy),
    createdAt: new Date().toISOString(),
    // A recovered account was restored from its phrase, which proves the user holds it.
    backupConfirmed: true,
    backupFileAt: null,
    pools: {},
  };
  const sealed = await backup.seal(passphrase, s);
  await idbSet(ACCOUNT_KEY, sealed.envelope);
  secret = s;
  storageKey = sealed.key;
  storageSalt = sealed.salt;
  keys = deriveKeys(entropy);
  set({ phase: "unlocked", error: null });
  publish();
  void sync(opts.recovered ? "recovered" : "new");
}

export async function unlock(passphrase: string) {
  const stored = await idbGet(ACCOUNT_KEY);
  if (!stored) throw new Error(tNow("No vault account is stored in this browser.", "此浏览器中没有保存金库账户。"));
  const opened = await backup.open<Secret>(passphrase, stored);
  secret = opened.data;
  storageKey = opened.key;
  storageSalt = opened.salt;
  keys = deriveKeys(hexToBytes(secret.entropy as `0x${string}`));
  set({ phase: "unlocked", error: null });
  publish();
  void sync("unlock");
}

export function lock() {
  keys = null;
  secret = null;
  storageKey = null;
  storageSalt = null;
  set({ phase: "locked", notes: [], pending: [], address: null });
}

/** Deletes this browser's copy. The account survives only in the phrase or a backup file. */
export async function forgetDevice() {
  await idbDelete(ACCOUNT_KEY);
  lock();
  set({ phase: "none" });
}

/** Re-checks the passphrase before showing the phrase again or exporting a backup. */
export async function reveal(passphrase: string): Promise<Uint8Array> {
  const stored = await idbGet(ACCOUNT_KEY);
  const opened = await backup.open<Secret>(passphrase, stored);
  return hexToBytes(opened.data.entropy as `0x${string}`);
}

/** Encrypted backup file: the account entropy only, under the vault passphrase. */
export async function backupFile(passphrase: string): Promise<Blob> {
  const entropy = await reveal(passphrase);
  const { envelope } = await backup.seal(passphrase, { entropy: bytesToHex(entropy), createdAt: secret?.createdAt ?? new Date().toISOString() });
  if (secret) {
    secret.backupFileAt = new Date().toISOString();
    await persist();
    publish();
  }
  return new Blob([JSON.stringify({ ...envelope, network: NETWORK }, null, 2)], { type: "application/json" });
}

export async function readBackupFile(file: File, passphrase: string): Promise<Uint8Array> {
  if (file.size > 64_000) throw new Error(tNow("That file is too large to be a Curveil backup.", "该文件太大，不可能是 Curveil 备份。"));
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error(tNow("That file is not a Curveil vault backup.", "该文件不是 Curveil 金库备份。"));
  }
  const { data } = await backup.open<{ entropy: string }>(passphrase, raw);
  const bytes = hexToBytes(data.entropy as `0x${string}`);
  if (bytes.length !== 32) throw new Error(tNow("The backup file is damaged.", "备份文件已损坏。"));
  return bytes;
}

// ---------------------------------------------------------------- sync

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `The Curveil API answered ${r.status}.`);
  }
  return (await r.json()) as T;
}

export async function refreshStatus(): Promise<VaultStatus | null> {
  if (!manifest.contracts.ShieldedPool) return null;
  try {
    const status = await api<VaultStatus>("/v1/vault/status");
    set({ status });
    return status;
  } catch (e) {
    set({ sync: { kind: "error", message: e instanceof Error ? e.message : tNow("Vault status unavailable.", "无法获取金库状态。") } });
    return null;
  }
}

let syncing: Promise<void> | null = null;

/** Downloads new public data, extends the tree, finds this account's notes and spends. */
export function sync(_reason = "manual"): Promise<void> {
  syncing ??= doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  const status = await refreshStatus();
  if (!status) return;
  const pool = status.pool.toLowerCase();
  const domain = noteDomain(status.chainId, status.pool);
  if (domain.toString() !== status.noteDomain) {
    set({ sync: { kind: "error", message: tNow("The vault's note domain does not match this site's manifest. Stopped.", "金库的票据域与本网站的清单不匹配，已停止。") } });
    return;
  }

  if (treePool !== pool || !cache) {
    cache = (await idbGet<PublicCache>(publicKey(pool))) ?? { commitments: [], ciphertexts: [], nullifiers: [], nullifierBlock: 0 };
    tree = new NoteTree(cache.commitments.map(BigInt));
    treePool = pool;
    nullifierSet = new Set(cache.nullifiers);
  }
  const c = cache;
  const t = tree!;
  try {
    // Commitments in leaf order.
    for (;;) {
      set({ sync: { kind: "syncing", leaves: c.commitments.length, of: status.leafCount } });
      const page = await api<{ items: { leafIndex: number; commitment: string; encryptedNote: string }[]; nextLeaf: number; done: boolean }>(
        `/v1/vault/commitments?fromLeaf=${c.commitments.length}`,
      );
      if (page.items.length === 0) break;
      for (const it of page.items) {
        if (it.leafIndex !== c.commitments.length) throw new Error(tNow("Commitments arrived out of order. Try again.", "承诺数据到达顺序错乱，请重试。"));
        c.commitments.push(it.commitment);
        c.ciphertexts.push(it.encryptedNote);
      }
      t.append(page.items.map((i) => BigInt(i.commitment)));
      if (page.done) break;
    }
    // Nullifiers.
    for (;;) {
      const page = await api<{ items: { nullifier: string; blockNumber: number }[]; done: boolean; nextBlock: number | null }>(
        `/v1/vault/nullifiers?fromBlock=${c.nullifierBlock}`,
      );
      for (const n of page.items) {
        if (!nullifierSet.has(n.nullifier)) {
          nullifierSet.add(n.nullifier);
          c.nullifiers.push(n.nullifier);
        }
        c.nullifierBlock = Math.max(c.nullifierBlock, n.blockNumber);
      }
      if (page.done) break;
    }
    await idbSet(publicKey(pool), c);
  } catch (e) {
    set({ sync: { kind: "error", message: e instanceof Error ? e.message : tNow("Sync failed.", "同步失败。") } });
    return;
  }

  if (keys && secret) {
    const ps = poolState(pool);
    if (ps.scannedLeaf < c.commitments.length) {
      const items = [];
      for (let i = ps.scannedLeaf; i < c.commitments.length; i++) {
        items.push({ leafIndex: i, commitment: BigInt(c.commitments[i]!), encryptedNote: hexToBytes(c.ciphertexts[i] as `0x${string}`) });
      }
      const found: OwnedNote[] = scanCommitments(keys, domain, items);
      const known = new Set(ps.notes.map((n) => n.leafIndex));
      for (const n of found) {
        if (known.has(n.leafIndex)) continue;
        ps.notes.push({
          leafIndex: n.leafIndex,
          resource: n.resource.toString(),
          amount: n.amount.toString(),
          blinding: n.blinding.toString(),
          commitment: n.commitment.toString(),
          nullifier: n.nullifier.toString(),
          spent: false,
        });
      }
      ps.scannedLeaf = c.commitments.length;
    }
    for (const n of ps.notes) n.spent = nullifierSet.has(n.nullifier);
    // A pending action is done once its nullifiers (or, for a shield, its note) are on-chain.
    const owned = new Set(ps.notes.map((n) => n.commitment));
    ps.pending = ps.pending.filter((p) => {
      if (p.state === "failed") return Date.now() - p.createdAt < 10 * 60_000;
      if (p.nullifiers.length > 0) return !p.nullifiers.every((n) => nullifierSet.has(n));
      return !p.incoming.every((i) => owned.has(i.commitment));
    });
    await persist();
    publish();
  }
  const rootMatches = c.commitments.length === status.leafCount ? t.root().toString() === status.root : false;
  set({ sync: { kind: "synced", leaves: c.commitments.length, at: Date.now(), rootMatches } });
}

// ---------------------------------------------------------------- notes and pending actions

export function spendableNotes(resource: string): (StoredNote & { amountBig: bigint })[] {
  const reserved = new Set(state.pending.filter((p) => p.state !== "failed").flatMap((p) => p.nullifiers));
  return state.notes
    .filter((n) => !n.spent && n.resource === resource && !reserved.has(n.nullifier) && BigInt(n.amount) > 0n)
    .map((n) => ({ ...n, amountBig: BigInt(n.amount) }));
}

export function balances(resource: string) {
  const spendable = spendableNotes(resource).reduce((s, n) => s + n.amountBig, 0n);
  const reserved = new Set(state.pending.filter((p) => p.state !== "failed").flatMap((p) => p.nullifiers));
  const spending = state.notes.filter((n) => !n.spent && n.resource === resource && reserved.has(n.nullifier)).reduce((s, n) => s + BigInt(n.amount), 0n);
  const owned = new Set(state.notes.map((n) => n.commitment));
  const incoming = state.pending
    .filter((p) => p.state !== "failed")
    .flatMap((p) => p.incoming)
    .filter((i) => i.resource === resource && !owned.has(i.commitment))
    .reduce((s, i) => s + BigInt(i.amount), 0n);
  return { spendable, spending, incoming };
}

export async function addPending(pool: string, p: PendingAction) {
  const ps = poolState(pool);
  ps.pending = [...ps.pending.filter((x) => x.id !== p.id), p];
  await persist();
  publish();
}

export async function updatePending(pool: string, id: string, patch: Partial<PendingAction>) {
  const ps = poolState(pool);
  ps.pending = ps.pending.map((p) => (p.id === id ? { ...p, ...patch } : p));
  await persist();
  publish();
}

export async function dismissPending(pool: string, id: string) {
  const ps = poolState(pool);
  ps.pending = ps.pending.filter((p) => p.id !== id);
  await persist();
  publish();
}

export async function confirmBackup() {
  if (!secret) return;
  secret.backupConfirmed = true;
  await persist();
  publish();
}
