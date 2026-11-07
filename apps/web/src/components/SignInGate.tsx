import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useConnection, useDisconnect } from "wagmi";
import { useAppKitState } from "@reown/appkit/react";
import { useSession } from "../lib/session";
import { shortAddress } from "../lib/config";

/**
 * Once a wallet is connected, the app asks it to sign in before anything else. The dialog can not
 * be dismissed: it closes only when the wallet signs in or is disconnected. The session lives in
 * localStorage, so after a refresh a signed-in wallet goes straight through and an unsigned one
 * sees the dialog again. The Safe signing page skips it: owners there sign only the Safe
 * transaction, and the page never calls the API.
 */
export function SignInGate() {
  const { isConnected, address, status } = useConnection();
  const session = useSession();
  const disconnect = useDisconnect();
  // Wait for the wallet picker to close, so the gate never covers it mid-connect.
  const picker = useAppKitState();
  const onSafePage = useRouterState({ select: (s) => s.location.pathname.startsWith("/app/safe") });
  const open = !onSafePage && isConnected && status === "connected" && Boolean(address) && !session.signedIn && !picker.open;
  const box = useRef<HTMLDivElement>(null);

  // While the gate is up, the page behind it can not be clicked, tabbed to or read by screen readers.
  // A native modal <dialog> would do this too, but opening one cancels a wallet connection in progress.
  useEffect(() => {
    if (!open) return;
    const behind = [...document.querySelectorAll<HTMLElement>(".header, #main, .footer, .txt-stack")];
    behind.forEach((el) => el.setAttribute("inert", ""));
    document.body.classList.add("sig-lock");
    box.current?.querySelector<HTMLButtonElement>(".btn-primary")?.focus();
    return () => {
      behind.forEach((el) => el.removeAttribute("inert"));
      document.body.classList.remove("sig-lock");
    };
  }, [open]);

  if (!open || !address) return null;
  return (
    <div className="sig-overlay">
      <div ref={box} className="sig-dlg" role="dialog" aria-modal="true" aria-labelledby="sig-title" aria-describedby="sig-lead">
        <div className="sig-in">
          <div className="sig-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0 1 10 0v3" /><rect x="4.5" y="11" width="15" height="10" rx="2" /><path d="M12 15v2" /></svg>
          </div>
          <div className="sig-text">
            <h2 id="sig-title">Sign in to Curveil</h2>
            <p id="sig-lead">
              Sign a short message to prove you own this wallet. It is free: no transaction, no gas, and
              no access to your funds. The sign-in lasts seven days on this browser.
            </p>
          </div>
          <div className="sig-addr">
            <span className="dot good" aria-hidden="true" />
            <span className="mono">{shortAddress(address)}</span>
            <span className="sig-addr-note">connected</span>
          </div>
          {session.error && <p className="notice bad sig-err" role="alert">{session.error}</p>}
          <div className="sig-actions">
            <button type="button" className="btn btn-primary" onClick={() => void session.signIn()} disabled={session.signingIn}>
              {session.signingIn ? "Check your wallet…" : "Sign in"}
            </button>
            <button type="button" className="btn" onClick={() => disconnect.mutate()} disabled={session.signingIn}>
              Disconnect wallet
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
