import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useSignMessage } from "wagmi";
import { CurveilClient, CurveilApiError } from "@curveil/sdk";
import { API_URL, NETWORK } from "./config";
import { tNow } from "./i18n";

/**
 * Sign-In with Ethereum for the developer console and launchpad settings. The session token is
 * kept in this browser only (localStorage, per address) and sent as a bearer token. It is not a
 * cookie, so other sites can not use it, and it expires after seven days.
 */
type Stored = { token: string; expiresAt: string };
const key = (address: string) => `curveil.session.${NETWORK}.${address.toLowerCase()}`;

function read(address: string | undefined): Stored | null {
  if (!address) return null;
  try {
    const s = JSON.parse(localStorage.getItem(key(address)) ?? "null") as Stored | null;
    return s && Date.parse(s.expiresAt) > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

// Every useSession() on the page shares one sign-in: a change in one notifies the others.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function useSession() {
  const { address } = useConnection();
  const sign = useSignMessage();
  const [stored, setStoredState] = useState<Stored | null>(() => read(address));
  const [memory, setMemory] = useState<Stored | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    const sync = () => setStoredState(read(address) ?? (memory && address ? memory : null));
    sync();
    listeners.add(sync);
    return () => void listeners.delete(sync);
  }, [address, memory]);
  const setStored = (s: Stored | null) => {
    setMemory(s);
    setStoredState(s);
    notify();
  };

  const client = useMemo(() => new CurveilClient({ baseUrl: API_URL, network: NETWORK, sessionToken: stored?.token }), [stored?.token]);

  const signIn = useCallback(async () => {
    if (!address) return;
    setError(null);
    setSigningIn(true);
    try {
      const c = new CurveilClient({ baseUrl: API_URL, network: NETWORK });
      const s = await c.signIn({
        address,
        domain: window.location.host,
        uri: window.location.origin,
        sign: (message) => sign.mutateAsync({ message }),
      });
      const next = { token: s.token, expiresAt: s.expiresAt };
      try {
        localStorage.setItem(key(address), JSON.stringify(next));
      } catch {
        /* private mode: the session lasts for this page only */
      }
      setStored(next);
    } catch (e) {
      setError(e instanceof CurveilApiError ? e.message : /reject|denied/i.test(String(e)) ? tNow("You cancelled the signature. Nothing was shared.", "你取消了签名。没有共享任何内容。") : tNow("Sign-in failed. Try again.", "登录失败，请重试。"));
    } finally {
      setSigningIn(false);
    }
  }, [address, sign]);

  const signOut = useCallback(async () => {
    if (!address) return;
    await client.signOut().catch(() => undefined);
    try {
      localStorage.removeItem(key(address));
    } catch {
      /* ignore */
    }
    setStored(null);
  }, [address, client]);

  /** A 401 means the session ended (expired or signed out elsewhere): forget it. */
  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof CurveilApiError && e.status === 401 && address) {
        try {
          localStorage.removeItem(key(address));
        } catch {
          /* ignore */
        }
        setStored(null);
      }
      return e instanceof Error ? e.message : String(e);
    },
    [address],
  );

  return { address, signedIn: Boolean(stored), expiresAt: stored?.expiresAt ?? null, client, signIn, signOut, signingIn, error, handle };
}

export type Session = ReturnType<typeof useSession>;
