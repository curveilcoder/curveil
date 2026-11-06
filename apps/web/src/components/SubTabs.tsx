import type { ReactNode } from "react";

/** The second row of tabs inside a profile section. */
export function SubTabs<T extends string>({ items, value, onChange, label }: { items: [T, ReactNode, (number | null)?][]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="pf-subtabs" role="tablist" aria-label={label}>
      {items.map(([id, text, n]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {text}
          {n !== undefined && n !== null && <span className="tk-count">{n.toLocaleString("en-US")}</span>}
        </button>
      ))}
    </div>
  );
}
