import { useEffect, useId, useRef, useState } from "react";
import type { Tok } from "../lib/tokens";
import { same, tokenLook } from "../lib/tokens";
import { TokenDisc } from "./TokenPair";

/**
 * Token chooser with each token's logo and full name. A button opens a list; arrow keys move,
 * Enter picks, Escape closes. Typing filters by symbol, name or address.
 */
export function TokenPicker({ tokens, value, onChange, label, wide }: { tokens: Tok[]; value: Tok | undefined; onChange: (address: `0x${string}`) => void; label: string; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? tokens.filter((t) => t.symbol.toLowerCase().includes(needle) || (tokenLook(t).name ?? "").toLowerCase().includes(needle) || t.address.toLowerCase() === needle)
    : tokens;

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, shown.findIndex((t) => same(t.address, value?.address))));
    search.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setOpen(false);
    setQ("");
    button.current?.focus();
  };
  const choose = (t: Tok) => {
    onChange(t.address);
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); choose(shown[active]!); }
  };

  return (
    <div className={`tpick${wide ? " wide" : ""}`} ref={root}>
      <button
        ref={button}
        type="button"
        className="tpick-btn"
        aria-label={`${label}: ${value ? value.symbol : "none"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {value ? <><TokenDisc token={value} size={22} /><span>{value.symbol}</span></> : <span>Select</span>}
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
      </button>
      {open && (
        <div className="tpick-pop" onKeyDown={onKey}>
          <input
            ref={search}
            className="tpick-search"
            placeholder="Search name or symbol"
            aria-label="Search tokens"
            aria-controls={listId}
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
          />
          <ul className="tpick-list" role="listbox" id={listId} aria-label={label}>
            {shown.map((t, i) => {
              const look = tokenLook(t);
              return (
                <li
                  key={t.address}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={same(t.address, value?.address)}
                  className={i === active ? "active" : undefined}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(t)}
                >
                  <TokenDisc token={t} size={28} />
                  <span className="tpick-sym">{t.symbol}</span>
                  {look.name && <span className="tpick-name">{look.name}</span>}
                </li>
              );
            })}
            {shown.length === 0 && <li className="tpick-none" aria-disabled="true">No token matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
