/**
 * Site language: English, Simplified Chinese or Traditional Chinese. Texts sit next to each other in
 * the components, as t("English", "简体中文"), so a change to one is easy to see in the other.
 *
 * Traditional Chinese is not written by hand: scripts/zh-hant.mjs converts every Simplified text in
 * src/ with OpenCC (Taiwan phrasing) into src/lib/zh-hant.json, which loads only for 繁體 readers.
 *
 * The choice comes from ?lang=en|zh|zh-Hant, then the visitor's last pick, then the browser language.
 */
import { cloneElement, isValidElement, useSyncExternalStore, type ReactElement, type ReactNode } from "react";

export type Locale = "en" | "zh" | "zh-Hant";
/** Which text to show: Chinese covers both scripts. */
export type Lang = "en" | "zh";

export const LOCALES: readonly { id: Locale; label: string; short: string; html: string }[] = [
  { id: "en", label: "English", short: "EN", html: "en" },
  { id: "zh", label: "简体中文", short: "简", html: "zh-CN" },
  { id: "zh-Hant", label: "繁體中文", short: "繁", html: "zh-TW" },
];

const KEY = "curveil-lang";
const isLocale = (v: unknown): v is Locale => v === "en" || v === "zh" || v === "zh-Hant";

function initial(): Locale {
  if (typeof window === "undefined") return "en";
  const q = new URLSearchParams(window.location.search).get("lang");
  if (isLocale(q)) {
    try { localStorage.setItem(KEY, q); } catch { /* private mode */ }
    return q;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (isLocale(saved)) return saved;
  } catch { /* private mode */ }
  for (const l of navigator.languages ?? []) {
    if (/^zh-(hant|tw|hk|mo)\b/i.test(l)) return "zh-Hant";
    if (/^zh\b/i.test(l)) return "zh";
  }
  return "en";
}

let current: Locale = initial();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

/* ---------- Traditional Chinese ---------- */

let hant: Record<string, string> | null = null;
let loading: Promise<void> | null = null;
function loadHant() {
  loading ??= import("./zh-hant.json").then(
    (m) => { hant = m.default as Record<string, string>; notify(); },
    () => { loading = null; },
  );
}

/** Runs of Chinese text, the unit the conversion map is keyed by. */
export const CJK_RUN = /[　-〿㐀-鿿＀-￯]+/g;

/** Simplified → Traditional, using the generated map. Text stays Simplified until the map loads. */
export function toHant(s: string): string {
  if (!hant) return s;
  const map = hant;
  return s.replace(CJK_RUN, (run) => map[run] ?? run);
}

/** Converts strings, arrays, plain objects and React elements (their children and text props). */
function deepHant<T>(v: T): T {
  if (typeof v === "string") return (/[\u3400-\u9fff]/.test(v) ? toHant(v) : v) as T;
  if (Array.isArray(v)) return v.map(deepHant) as T;
  if (isValidElement(v)) {
    const el = v as ReactElement<Record<string, unknown>>;
    // Every prop but functions and refs: only Chinese characters change, so ids, links and classes are safe.
    const next: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(el.props)) {
      if (k === "children" || k === "ref" || typeof x === "function") continue;
      const y = deepHant(x);
      if (y !== x) next[k] = y;
    }
    const kids = el.props.children;
    // Children passed as arguments, not as an array, so React does not ask for keys JSX never needed.
    if (Array.isArray(kids)) return cloneElement(el, next, ...(kids.map(deepHant) as ReactNode[])) as T;
    if (kids !== undefined) return cloneElement(el, next, deepHant(kids) as ReactNode) as T;
    return cloneElement(el, next) as T;
  }
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepHant(x)])) as T;
  }
  return v;
}

/* ---------- Store ---------- */

function apply(locale: Locale) {
  if (typeof document !== "undefined") document.documentElement.lang = LOCALES.find((l) => l.id === locale)!.html;
  if (locale === "zh-Hant") loadHant();
}
apply(current);

export function setLocale(locale: Locale) {
  if (locale === current) return;
  current = locale;
  try { localStorage.setItem(KEY, locale); } catch { /* private mode */ }
  apply(locale);
  notify();
}

export const getLocale = () => current;
/** Changes when the locale changes or the Traditional map arrives, so readers re-render. */
const snapshot = () => (current === "zh-Hant" && hant ? "zh-Hant+" : current);

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function useLocale(): Locale {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return current;
}

/** "en" or "zh" (either script). */
export function useLang(): Lang {
  return useLocale() === "en" ? "en" : "zh";
}

export type T = <V>(en: V, zh: V) => V;

/** Pick the text for the current language: t("Swap", "兑换"). Works for any value, not only strings. */
export function useT(): T {
  const locale = useLocale();
  if (locale === "en") return (en) => en;
  if (locale === "zh") return (_en, zh) => zh;
  return (_en, zh) => deepHant(zh);
}

/** For a whole Chinese tree written in Simplified: converts it for 繁體 readers. */
export function useZh(): <V>(tree: V) => V {
  const locale = useLocale();
  return (tree) => (locale === "zh-Hant" ? deepHant(tree) : tree);
}

/** For text outside components (titles, toasts): reads the locale at call time. */
export const tNow: T = (en, zh) => (current === "en" ? en : current === "zh" ? zh : deepHant(zh));

/** Page titles in Chinese, keyed by the English title a route sets. */
export const TITLES_ZH: Record<string, string> = {
  "Curveil · Open markets. Private participation.": "Curveil · 公开市场，私密参与。",
  "Docs · Curveil": "文档 · Curveil",
  "Add liquidity · Curveil": "添加流动性 · Curveil",
  "Create a pool · Curveil": "创建资金池 · Curveil",
  "Create a token · Curveil": "创建代币 · Curveil",
  "Launches · Curveil": "代币发行 · Curveil",
  "Perps · Curveil": "永续合约 · Curveil",
  "Pool · Curveil": "资金池 · Curveil",
  "Pools · Curveil": "资金池 · Curveil",
  "Profile · Curveil": "个人资料 · Curveil",
  "Sign the handover · Curveil": "签署交接 · Curveil",
  "Swap · Curveil": "兑换 · Curveil",
  "Token · Curveil": "代币 · Curveil",
  "Vault · Curveil": "金库 · Curveil",
};
