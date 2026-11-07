import { useEffect, useSyncExternalStore } from "react";
import { explorerTx } from "../lib/config";
import { useT } from "../lib/i18n";

/**
 * Transaction progress lives in toasts in the corner of the screen, not under the form that
 * started it. A form publishes its phase with `useTxToast(id, entry)`; the toaster in the shell
 * shows every entry until it finishes (and a few seconds after) or the user closes it.
 */

export type ToastEntry = {
  /** What is being done, e.g. "Approve tUSDG (1 of 2)". */
  title: string;
  tone: "busy" | "good" | "bad";
  message: string;
  hash?: string | null;
};

type Item = ToastEntry & { id: string; at: number };

let items: Item[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function setToast(id: string, e: ToastEntry | null) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  if (!e) {
    items = items.filter((x) => x.id !== id);
  } else {
    const next = { ...e, id, at: Date.now() };
    items = items.some((x) => x.id === id) ? items.map((x) => (x.id === id ? next : x)) : [...items, next];
    // A finished success clears itself; a failure stays until it is closed.
    if (e.tone === "good") timers.set(id, setTimeout(() => setToast(id, null), 9000));
  }
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Publish this entry as a toast while it is not null. The toast outlives the component. */
export function useTxToast(id: string, entry: ToastEntry | null) {
  const key = entry ? JSON.stringify(entry) : "";
  useEffect(() => {
    // A form going back to idle does not close a finished toast; the timer or the user does.
    if (entry) setToast(id, entry);
  }, [id, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Icon({ tone }: { tone: ToastEntry["tone"] }) {
  if (tone === "busy") return <span className="txt-spin" aria-hidden="true" />;
  return (
    <svg viewBox="0 0 16 16" className={`txt-icon ${tone}`} aria-hidden="true">
      {tone === "good" ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
    </svg>
  );
}

export function TxToasts() {
  const t = useT();
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  if (list.length === 0) return null;
  return (
    <div className="txt-stack" aria-live="polite" aria-label={t("Transactions", "交易")}>
      {list.map((it) => (
        <div key={it.id} className={`txt txt-${it.tone}`} role={it.tone === "bad" ? "alert" : "status"}>
          <Icon tone={it.tone} />
          <div className="txt-body">
            <p className="txt-title">{it.title}</p>
            <p className="txt-msg">
              {it.message}
              {it.hash && <> <a href={explorerTx(it.hash)} target="_blank" rel="noreferrer">{t("View transaction ↗", "查看交易 ↗")}</a></>}
            </p>
          </div>
          <button type="button" className="txt-close" aria-label={t("Dismiss", "关闭")} onClick={() => setToast(it.id, null)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
