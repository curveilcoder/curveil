import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useConnection, useDisconnect, useSwitchChain } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { curveilChain, shortAddress } from "../lib/config";

/** Opens the wallet dialog, shows the address, switches to the Curveil chain. Never signs anything by itself. */
export function ConnectButton() {
  const { address, chainId, isConnected, status } = useConnection();
  const { open } = useAppKit();
  const switchChain = useSwitchChain();
  const [error, setError] = useState<string | null>(null);

  if (!isConnected || !address) {
    return (
      <div className="connect">
        <button
          className="btn btn-primary btn-sm"
          disabled={status === "connecting" || status === "reconnecting"}
          onClick={() => {
            setError(null);
            void open({ view: "Connect" });
          }}
        >
          {status === "connecting" ? "Check your wallet…" : "Connect wallet"}
        </button>
      </div>
    );
  }

  if (chainId !== curveilChain.id) {
    return (
      <div className="connect">
        <button
          className="btn btn-sm"
          style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
          disabled={switchChain.isPending}
          onClick={() => {
            setError(null);
            switchChain.mutate(
              { chainId: curveilChain.id },
              { onError: (e) => setError(e.name === "UserRejectedRequestError" ? "Network switch was cancelled." : `Could not switch network: ${e.message.split("\n")[0]}`) },
            );
          }}
        >
          {switchChain.isPending ? "Switching…" : `Switch to ${curveilChain.name}`}
        </button>
        {error && <p className="connect-error" role="alert">{error}</p>}
      </div>
    );
  }

  return <AccountMenu address={address} />;
}

/** Connected: the address opens a small menu: profile, vault, copy address, disconnect. */
function AccountMenu({ address }: { address: `0x${string}` }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const disconnect = useDisconnect();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setShown(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setShown(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [shown]);
  return (
    <div className="connect" ref={box}>
      <button className="chip mono" aria-expanded={shown} aria-haspopup="menu" onClick={() => setShown((v) => !v)}>
        <span className="dot good" aria-hidden="true" />
        {shortAddress(address)}
        <span className="sr-only">Connected. Open the account menu.</span>
      </button>
      {shown && (
        <div className="nav-menu account-menu" role="menu">
          <Link to="/app/profile/$address" params={{ address }} role="menuitem" onClick={() => setShown(false)}>
            <MenuIcon d="M8 8a2.75 2.75 0 1 0 0-5.5A2.75 2.75 0 0 0 8 8Zm-5 5.5c.6-2.4 2.6-3.75 5-3.75s4.4 1.35 5 3.75" />Profile
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard?.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => { setCopied(false); setShown(false); }, 900);
              });
            }}
          >
            {copied
              ? <><MenuIcon d="m3.5 8.5 3 3 6-7" />Copied</>
              : <><MenuIcon d="M5.5 5.5h8v8h-8zM10.5 3.5V2.5h-8v8h1" />Copy address</>}
          </button>
          <button type="button" role="menuitem" className="menu-danger" onClick={() => { setShown(false); disconnect.mutate(); }}>
            <MenuIcon d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10.5 11l3-3-3-3M13.5 8H6" />Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function MenuIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="menu-icon">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
