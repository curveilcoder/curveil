import { useState } from "react";
import { manifest, explorerAddress, shortAddress } from "../lib/config";

/** CURVEIL contract address chip. Hides copy and links until the address is set in the manifest (FR-02). */
export function CaChip() {
  const ca = manifest.token.address;
  const [copied, setCopied] = useState(false);
  if (!ca) {
    return (
      <span className="chip" title="The CURVEIL token has not launched. No address is published yet.">
        <span className="dot" aria-hidden="true" />
        <span>CA: not launched yet</span>
      </span>
    );
  }
  return (
    <span className="chip mono">
      <span>CA</span>
      <a href={explorerAddress(ca)} target="_blank" rel="noreferrer">{shortAddress(ca)}</a>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(ca).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }, () => undefined);
        }}
        aria-label="Copy CURVEIL contract address"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
