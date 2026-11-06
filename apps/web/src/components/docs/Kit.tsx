import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { DocPage } from "../../lib/docs";

/** Building blocks for the docs pages: sections, steps, code with copy, tabs, callouts and cards. */

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  const anchor = id ?? slug(title);
  return (
    <section id={anchor} className="dk-section">
      <h2 className="dk-h2">
        <a href={`#${anchor}`} className="dk-anchor">{title}</a>
      </h2>
      {children}
    </section>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="dk-steps">{children}</ol>;
}

export function Step({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  const anchor = id ?? slug(title);
  return (
    <li className="dk-step" id={anchor}>
      <h3 className="dk-h3">
        <a href={`#${anchor}`} className="dk-anchor">{title}</a>
      </h3>
      <div className="dk-step-body">{children}</div>
    </li>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="dk-copy"
      onClick={() => navigator.clipboard?.writeText(text).then(() => setDone(true), () => {})}
      aria-label={done ? "Copied" : "Copy code"}
    >
      {done ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" /></svg>
      )}
      <span>{done ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function Code({ children, lang = "ts", title }: { children: string; lang?: string; title?: string }) {
  return (
    <div className="dk-code">
      <div className="dk-code-head">
        <span className="dk-code-title">{title ?? LANG[lang] ?? lang}</span>
        <CopyButton text={children} />
      </div>
      <pre tabIndex={0}><code>{children}</code></pre>
    </div>
  );
}

const LANG: Record<string, string> = { ts: "TypeScript", sh: "Terminal", json: "JSON", http: "HTTP", txt: "Text" };

export function CodeTabs({ tabs }: { tabs: { label: string; lang?: string; code: string }[] }) {
  const [at, setAt] = useState(0);
  const cur = tabs[at]!;
  return (
    <div className="dk-code">
      <div className="dk-code-head">
        <div className="dk-code-tabs" role="tablist">
          {tabs.map((t, i) => (
            <button key={t.label} type="button" role="tab" aria-selected={i === at} className={i === at ? "on" : ""} onClick={() => setAt(i)}>{t.label}</button>
          ))}
        </div>
        <CopyButton text={cur.code} />
      </div>
      <pre tabIndex={0}><code>{cur.code}</code></pre>
    </div>
  );
}

const CALLOUT_LABEL = { note: "Note", tip: "Tip", warn: "Important", example: "Example" } as const;

export function Callout({ kind = "note", title, children }: { kind?: keyof typeof CALLOUT_LABEL; title?: string; children: ReactNode }) {
  return (
    <div role="note" className={`dk-callout dk-${kind}`}>
      <p className="dk-callout-title">
        <CalloutIcon kind={kind} />
        {title ?? CALLOUT_LABEL[kind]}
      </p>
      <div className="dk-callout-body">{children}</div>
    </div>
  );
}

function CalloutIcon({ kind }: { kind: keyof typeof CALLOUT_LABEL }) {
  if (kind === "warn") return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.5 11.4H1.5z" /><path d="M8 6.2v3.3M8 11.3v.2" /></svg>;
  if (kind === "tip") return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.2v.6h4v-.6c0-.5.2-.9.6-1.2A4.5 4.5 0 0 0 8 1.5z" /></svg>;
  if (kind === "example") return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4.5 6.5h7M4.5 9.5h4" /></svg>;
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.2v4M8 4.8v.2" /></svg>;
}

/** A small table of label and value pairs, used for worked examples. */
export function Calc({ rows, total }: { rows: [string, ReactNode][]; total?: [string, ReactNode] }) {
  return (
    <dl className="dk-calc">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      {total && <div className="dk-calc-total"><dt>{total[0]}</dt><dd>{total[1]}</dd></div>}
    </dl>
  );
}

export function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-scroll dk-table">
      <table className="data">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Cards({ children, cols }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={`dk-cards${cols === 2 ? " two" : ""}`}>{children}</div>;
}

export function DocCard({ page, href, icon, title, children }: { page?: DocPage; href?: string; icon?: ReactNode; title: string; children: ReactNode }) {
  const body = (
    <>
      {icon && <span className="dk-card-icon" aria-hidden="true">{icon}</span>}
      <span className="dk-card-title">{title}<span className="dk-card-arrow" aria-hidden="true">→</span></span>
      <span className="dk-card-desc">{children}</span>
    </>
  );
  if (page) return <Link to="/docs" search={{ page }} className="dk-card">{body}</Link>;
  if (href?.startsWith("/")) return <a href={href} className="dk-card">{body}</a>;
  return <a href={href} target="_blank" rel="noreferrer" className="dk-card">{body}</a>;
}

/** Inline code. */
export const C = ({ children }: { children: ReactNode }) => <code className="dk-ic">{children}</code>;

/** Line icons for the cards, drawn on a 24px grid. */
export function Icon({ name }: { name: "swap" | "pool" | "launch" | "pad" | "vault" | "perps" | "code" | "api" | "contract" | "faucet" | "key" | "status" | "fees" | "risk" }) {
  const p: Record<string, ReactNode> = {
    swap: <><path d="M4 8h14l-3-3M20 16H6l3 3" /></>,
    pool: <><path d="M3 18h18M5 18V12M9 18V8M13 18V10M17 18V6" /></>,
    launch: <><path d="M12 3c3 2 5 5.5 5 9.5l-2.5 3h-5L7 12.5C7 8.5 9 5 12 3z" /><circle cx="12" cy="10" r="1.6" /><path d="M9.5 18.5L8 21M14.5 18.5L16 21" /></>,
    pad: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
    vault: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="12" cy="12" r="3.2" /><path d="M12 8.8V7M12 17v-1.8" /></>,
    perps: <><path d="M3 17l5-6 4 3 7-8" /><path d="M15 6h4v4" /></>,
    code: <><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15" /></>,
    api: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.3 10.9l7.4-3.8M8.3 13.1l7.4 3.8" /></>,
    contract: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 12h7M9 16h5" /></>,
    faucet: <><path d="M4 9h9a3 3 0 0 1 3 3v1M4 6v6M16 16c0 1.7-1.3 3-1.5 3S13 17.7 13 16s1.5-3 1.5-3 1.5 1.3 1.5 3z" /></>,
    key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l2.5 2.5M14.5 8.5L17 11" /></>,
    status: <><circle cx="12" cy="12" r="8.5" /><path d="M7.5 12.5l3 3 6-6.5" /></>,
    fees: <><circle cx="12" cy="12" r="8.5" /><path d="M14.8 9.2c-.5-1-1.6-1.7-2.8-1.7-1.6 0-2.8.9-2.8 2.2 0 3 5.6 1.6 5.6 4.6 0 1.3-1.2 2.2-2.8 2.2-1.3 0-2.4-.7-2.9-1.8M12 6v1.5M12 16.5V18" /></>,
    risk: <><path d="M12 3l9.5 16.5h-19z" /><path d="M12 10v4M12 17v.2" /></>,
  };
  return <svg viewBox="0 0 24 24" className="dk-icon">{p[name]}</svg>;
}
