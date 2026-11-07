import { useState } from "react";
import { explorerAddress, shortAddress } from "../lib/config";
import { tNow } from "../lib/i18n";

/** Copies an address and says so for a moment. */
export function CopyAddress({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="tk-addr">
      <a className="mono" href={explorerAddress(value)} target="_blank" rel="noreferrer" title={value}>{label ?? shortAddress(value)}</a>
      <button
        type="button"
        className="tk-copy"
        aria-label={tNow(`Copy ${value}`, `复制 ${value}`)}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        }}
      >
        {done ? (
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
        )}
      </button>
    </span>
  );
}
