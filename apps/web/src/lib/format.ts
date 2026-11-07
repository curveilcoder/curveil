import { formatUnits, parseUnits } from "viem";
import { tNow } from "./i18n";

/** Token amount for display: grouped, trimmed, never in scientific notation. */
export function fmtAmount(raw: bigint | string | null | undefined, decimals: number, maxFraction = 4): string {
  if (raw === null || raw === undefined) return "–";
  const v = typeof raw === "string" ? BigInt(raw) : raw;
  const s = formatUnits(v, decimals);
  const [int, frac = ""] = s.split(".");
  const grouped = BigInt(int!).toLocaleString("en-US");
  const neg = s.startsWith("-") && !grouped.startsWith("-") ? "-" : "";
  const trimmed = frac.slice(0, maxFraction).replace(/0+$/, "");
  if (!trimmed && v !== 0n && BigInt(int!) === 0n) return maxFraction > 0 ? `<0.${"0".repeat(maxFraction - 1)}1` : "<1";
  return `${neg}${grouped}${trimmed ? `.${trimmed}` : ""}`;
}

export function fmtNumber(n: number | null | undefined, maxFraction = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n !== 0 && Math.abs(n) < 10 ** -maxFraction) return `<${(10 ** -maxFraction).toFixed(maxFraction)}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFraction });
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** Prices keep significant digits whatever their size. */
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  // Tiny prices count their leading zeros: 0.00000057494 reads as 0.0₆5749.
  if (n > 0 && n < 0.001) {
    let zeros = Math.floor(-Math.log10(n));
    let digits = Math.round(n * 10 ** (zeros + 4));
    if (digits >= 10_000) [zeros, digits] = [zeros - 1, 1000];
    const sig = String(digits).replace(/0+$/, "");
    if (zeros < 4) return `0.${"0".repeat(zeros)}${sig}`;
    return `0.0${String(zeros).split("").map((d) => SUB[Number(d)]).join("")}${sig}`;
  }
  return n.toPrecision(5).replace(/0+$/, "").replace(/\.$/, "");
}

export const fmtBps = (bps: number | null | undefined) => (bps === null || bps === undefined ? "–" : `${(bps / 100).toFixed(2)}%`);

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "–";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return tNow(`${s}s ago`, `${s} 秒前`);
  if (s < 3600) return tNow(`${Math.floor(s / 60)}m ago`, `${Math.floor(s / 60)} 分钟前`);
  if (s < 86_400) return tNow(`${Math.floor(s / 3600)}h ago`, `${Math.floor(s / 3600)} 小时前`);
  return tNow(`${Math.floor(s / 86_400)}d ago`, `${Math.floor(s / 86_400)} 天前`);
}

/** Parses user input into base units. Returns null for empty or invalid input. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const t = input.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === ".") return null;
  const frac = t.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

/** amount * (10000 - bps) / 10000, rounded down. */
export const withSlippage = (amount: bigint, bps: number) => (amount * BigInt(10_000 - Math.round(bps))) / 10_000n;

/** Short form for big figures: 950, 1.8K, 72.7K, 1.25M, 3B. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a < 1000) return n.toLocaleString("en-US", { maximumFractionDigits: a < 10 ? 2 : a < 100 ? 1 : 0 });
  const units = ["K", "M", "B", "T"] as const;
  let i = Math.min(units.length - 1, Math.floor(Math.log10(a) / 3) - 1);
  let v = n / 1000 ** (i + 1);
  // 999,960 rounds to 1000K: show 1M instead.
  if (Math.abs(Number(v.toFixed(Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0))) >= 1000 && i < units.length - 1) {
    i += 1;
    v = n / 1000 ** (i + 1);
  }
  const av = Math.abs(v);
  return `${Number(v.toFixed(av < 10 ? 2 : av < 100 ? 1 : 0)).toLocaleString("en-US")}${units[i]}`;
}

/** True for a dollar-pegged quote token (tUSDG, USDC…), whose amounts read best as $. */
export const isUsd = (symbol: string | null | undefined) => Boolean(symbol && /usd/i.test(symbol));

/** A quote-token figure in short form: "$1.8K" for a dollar token, else "1.8K" plus the symbol. */
export function fmtQuote(n: number | null | undefined, symbol: string): { text: string; unit: string | null } {
  // Small ETH figures (a 0.0016 ETH volume) would round to 0 at two decimals.
  if (!isUsd(symbol) && n !== null && n !== undefined && Number.isFinite(n) && n !== 0 && Math.abs(n) < 1) return { text: fmtNumber(n, 4), unit: symbol };
  const c = fmtCompact(n);
  return isUsd(symbol) && c !== "–" ? { text: `${n! < 0 ? "-$" + c.slice(1) : "$" + c}`, unit: null } : { text: c, unit: symbol };
}
