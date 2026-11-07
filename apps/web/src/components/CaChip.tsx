import { useState } from "react";
import { manifest, explorerAddress, shortAddress } from "../lib/config";
import { useT } from "../lib/i18n";

/** CURVEIL contract address chip. Hides copy and links until the address is set in the manifest (FR-02). */
export function CaChip() {
  const t = useT();
  const ca = manifest.token.address;
  const [copied, setCopied] = useState(false);
  if (!ca) {
    return (
      <span className="chip" title={t("The CURVEIL token has not launched. No address is published yet.", "CURVEIL 代币尚未发行，还没有公布地址。")}>
        <span className="dot" aria-hidden="true" />
        <span>{t("CA: not launched yet", "CA：尚未发行")}</span>
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
        aria-label={t("Copy CURVEIL contract address", "复制 CURVEIL 合约地址")}
      >
        {copied ? t("Copied", "已复制") : t("Copy", "复制")}
      </button>
    </span>
  );
}
