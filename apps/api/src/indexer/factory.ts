/**
 * Launchpad operators (Phase 6): decoding of LaunchpadRegistry and FeeSplitter events into
 * rows, and the reads that keep each operator's current terms fresh. Decoding is pure; see
 * factory.test.ts. All public chain data.
 *
 * Operators are event-sourced into `operator_events` and `fee_distributions` (both carry
 * block_number and block_hash, so a reorg deletes rows above the common ancestor). The
 * `operators` table holds current terms, read from the registry whenever an event touches an
 * operator: the registry is the source of truth and the read is one multicall.
 */
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import registryAbiJson from "@curveil/manifest/abis/LaunchpadRegistry.json";
import splitterAbiJson from "@curveil/manifest/abis/FeeSplitter.json";
import { multicall, type Call, type RpcLog } from "./rpc";

export const launchpadRegistryAbi = registryAbiJson as Abi;
export const feeSplitterAbi = splitterAbiJson as Abi;

const operatorCurveAbi = [
  { type: "function", name: "operator", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "operatorShareBps", inputs: [], outputs: [{ type: "uint16" }], stateMutability: "view" },
] as const satisfies Abi;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Meta = { txHash: string; logIndex: number; blockNumber: number; blockHash: string; timestamp: number };

export type OperatorEventKind =
  | "registered"
  | "brand_set"
  | "share_set"
  | "templates_set"
  | "active_set"
  | "suspended"
  | "admin_transfer_started"
  | "admin_transferred"
  | "max_share_set"
  | "recipients_set";

export type OperatorEventRow = Meta & { operator: string | null; kind: OperatorEventKind; data: Record<string, unknown> };
export type FeeDistributionRow = Meta & { operator: string; kind: "distributed" | "released"; token: string; recipient: string | null; amount: string };

export type FactoryRows = {
  events: OperatorEventRow[];
  distributions: FeeDistributionRow[];
  /** New operators in this range: their splitters' logs must be read from now on. */
  registered: { operator: string; slug: string; blockNumber: number; txHash: string; blockHash: string; timestamp: number }[];
  /** Operators whose current terms must be read again. */
  touched: Set<string>;
};

const num = (h: string) => Number(BigInt(h));

function meta(log: RpcLog, timestamps: Map<number, number>): Meta {
  const blockNumber = num(log.blockNumber);
  return { txHash: log.transactionHash, logIndex: num(log.logIndex), blockNumber, blockHash: log.blockHash, timestamp: timestamps.get(blockNumber) ?? 0 };
}

function tryDecode(abi: Abi, log: RpcLog): { eventName: string; args: unknown } | null {
  try {
    return decodeEventLog({ abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }) as { eventName: string; args: unknown };
  } catch {
    return null;
  }
}

/**
 * Registry events (from `registry`) and splitter events (from any address in `splitters`, plus
 * splitters registered earlier in the same range).
 */
export function decodeLaunchpadLogs(logs: RpcLog[], registry: string, splitters: Set<string>, timestamps: Map<number, number>): FactoryRows {
  const out: FactoryRows = { events: [], distributions: [], registered: [], touched: new Set() };
  const reg = getAddress(registry);
  const known = new Set([...splitters].map((s) => getAddress(s)));
  const sorted = [...logs].sort((a, b) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex));
  for (const log of sorted) {
    if (log.removed) continue;
    const at = getAddress(log.address);
    const m = meta(log, timestamps);
    if (at === reg) {
      const ev = tryDecode(launchpadRegistryAbi, log);
      if (!ev) continue;
      const a = ev.args as Record<string, any>;
      const op = a.operator ? getAddress(a.operator) : null;
      const push = (kind: OperatorEventKind, data: Record<string, unknown>) => {
        out.events.push({ ...m, operator: op, kind, data });
        if (op) out.touched.add(op);
      };
      switch (ev.eventName) {
        case "OperatorRegistered":
          push("registered", {
            admin: getAddress(a.admin),
            slug: String(a.slug),
            shareBps: Number(a.shareBps),
            templateMask: String(a.templateMask),
            brandURI: String(a.brandURI),
          });
          out.registered.push({ operator: op!, slug: String(a.slug), blockNumber: m.blockNumber, txHash: m.txHash, blockHash: m.blockHash, timestamp: m.timestamp });
          known.add(op!);
          break;
        case "BrandSet":
          push("brand_set", { brandURI: String(a.brandURI) });
          break;
        case "ShareSet":
          push("share_set", { shareBps: Number(a.shareBps) });
          break;
        case "TemplatesSet":
          push("templates_set", { templateMask: String(a.templateMask) });
          break;
        case "ActiveSet":
          push("active_set", { active: Boolean(a.active) });
          break;
        case "Suspended":
          push("suspended", { suspended: Boolean(a.suspended) });
          break;
        case "AdminTransferStarted":
          push("admin_transfer_started", { pendingAdmin: getAddress(a.pendingAdmin) });
          break;
        case "AdminTransferred":
          push("admin_transferred", { admin: getAddress(a.admin) });
          break;
        case "MaxShareSet":
          push("max_share_set", { maxShareBps: Number(a.maxShareBps) });
          break;
      }
      continue;
    }
    if (!known.has(at)) continue;
    const ev = tryDecode(feeSplitterAbi, log);
    if (!ev) continue;
    const a = ev.args as Record<string, any>;
    switch (ev.eventName) {
      case "RecipientsSet":
        out.events.push({
          ...m,
          operator: at,
          kind: "recipients_set",
          data: { recipients: (a.recipients as string[]).map((r, i) => ({ address: getAddress(r), weightBps: Number(a.weights[i]) })) },
        });
        out.touched.add(at);
        break;
      case "Distributed":
        out.distributions.push({ ...m, operator: at, kind: "distributed", token: getAddress(a.token), recipient: null, amount: String(a.amount) });
        break;
      case "Released":
        out.distributions.push({ ...m, operator: at, kind: "released", token: getAddress(a.token), recipient: getAddress(a.recipient), amount: String(a.amount) });
        break;
    }
  }
  return out;
}

export type OperatorState = {
  address: string;
  slug: string;
  admin: string;
  pendingAdmin: string | null;
  shareBps: number;
  active: boolean;
  suspended: boolean;
  templateMask: string;
  brandURI: string;
  createdAt: number;
  recipients: { address: string; weightBps: number }[];
};

/** Current terms of each operator, read from the registry and its splitter at `blockTag`. */
export async function readOperators(rpcUrl: string, registry: string, operators: string[], blockTag = "latest"): Promise<OperatorState[]> {
  if (operators.length === 0) return [];
  const calls: Call[] = operators.flatMap((op) => [
    { target: registry, data: encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "operatorInfo", args: [op as Hex] }) },
    { target: op, data: encodeFunctionData({ abi: feeSplitterAbi, functionName: "recipients" }) },
  ]);
  const res = await multicall(rpcUrl, calls, blockTag);
  return operators.map((op, i) => {
    const o = decodeFunctionResult({ abi: launchpadRegistryAbi, functionName: "operatorInfo", data: res[2 * i]! }) as Record<string, any>;
    const [rs, ws] = decodeFunctionResult({ abi: feeSplitterAbi, functionName: "recipients", data: res[2 * i + 1]! }) as [string[], number[]];
    const pending = getAddress(o.pendingAdmin);
    return {
      address: getAddress(op),
      slug: String(o.slug),
      admin: getAddress(o.admin),
      pendingAdmin: pending === ZERO_ADDRESS ? null : pending,
      shareBps: Number(o.shareBps),
      active: Boolean(o.active),
      suspended: Boolean(o.suspended),
      templateMask: String(o.templateMask),
      brandURI: String(o.brandURI),
      createdAt: Number(o.createdAt),
      recipients: rs.map((r, k) => ({ address: getAddress(r), weightBps: Number(ws[k]) })),
    };
  });
}

/** Which operator each curve pays, and its share: fixed in the curve at creation. */
export async function readCurveOperators(rpcUrl: string, curves: string[], blockTag = "latest"): Promise<Map<string, { operator: string; shareBps: number }>> {
  const calls: Call[] = curves.flatMap((c) => [
    { target: c, data: encodeFunctionData({ abi: operatorCurveAbi, functionName: "operator" }) },
    { target: c, data: encodeFunctionData({ abi: operatorCurveAbi, functionName: "operatorShareBps" }) },
  ]);
  const res = await multicall(rpcUrl, calls, blockTag);
  return new Map(
    curves.map((c, i) => [
      getAddress(c),
      {
        operator: getAddress(decodeFunctionResult({ abi: operatorCurveAbi, functionName: "operator", data: res[2 * i]! }) as string),
        shareBps: Number(decodeFunctionResult({ abi: operatorCurveAbi, functionName: "operatorShareBps", data: res[2 * i + 1]! })),
      },
    ]),
  );
}

export type Brand = { name?: string; tagline?: string; accent?: string; url?: string; logo?: string };

/**
 * The brand from an operator's brand URI, when it is an inline JSON data URI. Other URIs
 * (https, ipfs) are passed through for the client to fetch. Only known fields of the expected
 * types are kept, and strings are capped, so a brand can not inject anything unexpected.
 */
export function parseBrand(uri: string): Brand | null {
  const m = /^data:application\/json(;charset=utf-8)?(;base64)?,(.*)$/is.exec(uri);
  if (!m) return null;
  let text: string;
  try {
    text = m[2] ? atob(m[3]!) : decodeURIComponent(m[3]!);
  } catch {
    text = m[3]!;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const brand: Brand = {
    name: str(r.name, 48),
    tagline: str(r.tagline, 140),
    accent: typeof r.accent === "string" && /^#[0-9a-f]{6}$/i.test(r.accent) ? r.accent.toLowerCase() : undefined,
    url: typeof r.url === "string" && /^https:\/\/[^\s]{1,200}$/i.test(r.url) ? r.url : undefined,
    logo: typeof r.logo === "string" && /^(https:\/\/|ipfs:\/\/)[^\s]{1,300}$/i.test(r.logo) ? r.logo : undefined,
  };
  return Object.fromEntries(Object.entries(brand).filter(([, v]) => v !== undefined)) as Brand;
}

/** Template ids allowed by a mask (bit i allows template i). */
export function templatesOf(mask: string | bigint): number[] {
  const m = BigInt(mask);
  const out: number[] = [];
  for (let i = 0; i < 64; i++) if ((m >> BigInt(i)) & 1n) out.push(i);
  return out;
}

/**
 * The operator's part of one curve fee, exactly as BondingCurve._bookFee splits it: the creator
 * takes its share first, the operator takes its share of the rest, the protocol the remainder.
 */
export function operatorPart(fee: bigint, creatorShareBps: number, operatorShareBps: number): bigint {
  const creator = (fee * BigInt(creatorShareBps)) / 10_000n;
  return ((fee - creator) * BigInt(operatorShareBps)) / 10_000n;
}

export function factoryStatements(db: D1Database, rows: FactoryRows): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const e of rows.events) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO operator_events (tx_hash, log_index, block_number, block_hash, timestamp, operator, kind, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(e.txHash, e.logIndex, e.blockNumber, e.blockHash, e.timestamp, e.operator, e.kind, JSON.stringify(e.data)),
    );
  }
  for (const d of rows.distributions) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO fee_distributions (tx_hash, log_index, block_number, block_hash, timestamp, operator, kind, token, recipient, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(d.txHash, d.logIndex, d.blockNumber, d.blockHash, d.timestamp, d.operator, d.kind, d.token, d.recipient, d.amount),
    );
  }
  return stmts;
}

export function operatorStatements(
  db: D1Database,
  states: OperatorState[],
  created: Map<string, { blockNumber: number; txHash: string; blockHash: string }>,
  block: number,
): D1PreparedStatement[] {
  const now = new Date().toISOString();
  return states
    .filter((s) => s.admin !== ZERO_ADDRESS)
    .map((s) => {
      const c = created.get(s.address);
      return db
        .prepare(
          `INSERT INTO operators (address, slug, admin, pending_admin, share_bps, active, suspended, template_mask, brand_uri, brand,
             recipients, created_block, created_tx, created_at, block_hash, updated_block, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (address) DO UPDATE SET admin = excluded.admin, pending_admin = excluded.pending_admin,
             share_bps = excluded.share_bps, active = excluded.active, suspended = excluded.suspended,
             template_mask = excluded.template_mask, brand_uri = excluded.brand_uri, brand = excluded.brand,
             recipients = excluded.recipients, updated_block = excluded.updated_block, updated_at = excluded.updated_at`,
        )
        .bind(
          s.address,
          s.slug,
          s.admin,
          s.pendingAdmin,
          s.shareBps,
          s.active ? 1 : 0,
          s.suspended ? 1 : 0,
          s.templateMask,
          s.brandURI,
          JSON.stringify(parseBrand(s.brandURI)),
          JSON.stringify(s.recipients),
          c?.blockNumber ?? 0,
          c?.txHash ?? "",
          s.createdAt,
          c?.blockHash ?? "",
          block,
          now,
        );
    });
}
