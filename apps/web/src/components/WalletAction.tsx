import { useId, type ReactNode } from "react";
import { useConnection } from "wagmi";
import { ConnectButton } from "./ConnectButton";
import { curveilChain } from "../lib/config";
import { useT } from "../lib/i18n";

/** Shows the action only once a wallet is connected on the Curveil chain. */
export function WalletAction({ verb, children }: { verb: string; children: ReactNode }) {
  const t = useT();
  const { isConnected, chainId } = useConnection();
  if (!isConnected) {
    return (
      <div className="wallet-gate">
        <p className="small muted" style={{ margin: 0 }}>{t(`Connect a wallet to ${verb}. Nothing is signed until you confirm a step.`, `连接钱包后即可${verb}。在你确认每一步之前，不会签署任何内容。`)}</p>
        <ConnectButton />
      </div>
    );
  }
  if (chainId !== curveilChain.id) {
    return (
      <div className="wallet-gate">
        <p className="small muted" style={{ margin: 0 }}>{t("Your wallet is on another network.", "你的钱包当前在其他网络上。")}</p>
        <ConnectButton />
      </div>
    );
  }
  return <>{children}</>;
}

/** Keeps only digits and one decimal point, and caps the decimals at what the token allows. */
export function cleanAmount(raw: string, decimals?: number): string {
  let v = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const dot = v.indexOf(".");
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
  if (v.startsWith(".")) v = "0" + v;
  if (decimals !== undefined && dot !== -1) v = v.slice(0, v.indexOf(".") + 1 + decimals);
  return v;
}

/**
 * Amount box: label and balance on top, a large number with the token beside it, and a line
 * underneath for a hint or an error. `error` marks the box red and says what is wrong.
 */
export function AmountField({ label, value, onChange, symbol, balance, balanceLabel, decimals, onMax, readOnly, hint, error, placeholder = "0", children }: {
  label: string;
  /** "Balance" by default; "Vault" when the amount comes from vault notes. */
  balanceLabel?: string;
  value: string;
  onChange?: (v: string) => void;
  symbol?: string;
  balance?: string;
  decimals?: number;
  onMax?: () => void;
  readOnly?: boolean;
  hint?: ReactNode;
  error?: string | null;
  placeholder?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const id = useId();
  balanceLabel ??= t("Balance", "余额");
  return (
    <div className="tbox" data-invalid={error ? "true" : undefined} data-readonly={readOnly ? "true" : undefined}>
      <div className="tbox-top">
        <label htmlFor={id}>{label}</label>
        {balance !== undefined && (
          <span className="tbox-bal">
            <span>{balanceLabel} <span className="mono">{balance}</span></span>
            {onMax && !readOnly && (
              <button type="button" className="tbox-max" onClick={onMax} aria-label={t(`Use the full ${balanceLabel.toLowerCase()}`, `使用全部${balanceLabel}`)}>{t("Max", "最大")}</button>
            )}
          </span>
        )}
      </div>
      <div className="tbox-main">
        <input
          id={id}
          className="tbox-input"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          aria-label={`${label}${symbol ? t(` in ${symbol}`, `（${symbol}）`) : ""}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-foot` : undefined}
          value={value}
          readOnly={readOnly}
          tabIndex={readOnly ? -1 : undefined}
          onChange={(e) => onChange?.(cleanAmount(e.target.value, decimals))}
          data-decimals={decimals}
        />
        {children}
      </div>
      {(error || hint) && <div id={`${id}-foot`} className={`tbox-foot${error ? " bad-text" : ""}`} role={error ? "alert" : undefined}>{error || hint}</div>}
    </div>
  );
}
