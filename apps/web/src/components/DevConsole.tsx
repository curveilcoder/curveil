import { useEffect, useState, type ReactNode } from "react";
import { Loading, Sk, SkRows } from "./Skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS, type Delivery, type Webhook } from "@curveil/sdk";
import { isAddress } from "viem";
import { WalletAction } from "./WalletAction";
import { useSession, type Session } from "../lib/session";

/** Sign-in gate for the developer console: keys and webhooks belong to a wallet. */
export function SignedIn({ children, what }: { children: (s: Session) => ReactNode; what: string }) {
  const session = useSession();
  return (
    <WalletAction verb={`manage ${what}`}>
      {session.signedIn ? (
        <div className="stack">{children(session)}</div>
      ) : (
        <div className="wallet-gate">
          <p className="small muted" style={{ margin: 0 }}>
            Sign in with your wallet to manage {what}. You sign a plain-text message (Sign-In with Ethereum); it is not a transaction and costs nothing.
          </p>
          <button className="btn btn-primary" onClick={session.signIn} disabled={session.signingIn}>{session.signingIn ? "Check your wallet…" : "Sign in with your wallet"}</button>
          {session.error && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{session.error}</p>}
        </div>
      )}
    </WalletAction>
  );
}

/**
 * The message for a failed session query. A 401 also ends the session, which updates other
 * components, so that part runs in an effect rather than during render.
 */
function useQueryError(s: Session, error: unknown): string | null {
  const { handle } = s;
  useEffect(() => {
    if (error) handle(error);
  }, [error, handle]);
  return error ? (error instanceof Error ? error.message : String(error)) : null;
}

function Secret({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice good" role="status">
      <div className="stack" style={{ gap: 8, width: "100%" }}>
        <strong className="small">{label}</strong>
        <span className="small">This is the only time it is shown. Store it somewhere safe now; if you lose it, create a new one.</span>
        <div className="field-row">
          <input className="text-input mono" readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
          <button
            className="btn btn-sm"
            onClick={() => {
              navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <button className="link-btn small" style={{ justifySelf: "start" }} onClick={onDone}>I stored it</button>
      </div>
    </div>
  );
}

export function ApiKeys() {
  return <SignedIn what="API keys">{(s) => <KeyList s={s} />}</SignedIn>;
}

function KeyList({ s }: { s: Session }) {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["keys", s.address], queryFn: () => s.client.keys() });
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = (keys.data?.keys ?? []).filter((k) => !k.revokedAt);
  const loadError = useQueryError(s, keys.error);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ["keys"] });
    } catch (e) {
      setError(s.handle(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Reads need no key: 300 requests a minute per IP. A key raises that to 3,000 a minute, counted per key. Send it as <span className="mono">X-API-Key</span> or{" "}
        <span className="mono">Authorization: Bearer</span>. Keys can read and manage webhooks but cannot create other keys. Up to 5 per wallet; Curveil stores only a hash.
      </p>
      {created && <Secret label="Your new API key" value={created} onDone={() => setCreated(null)} />}
      <div className="field-row">
        <input className="text-input" aria-label="Key label" placeholder="Label, e.g. production backend" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !label.trim() || live.length >= 5}
          onClick={() =>
            act(async () => {
              const k = await s.client.createKey(label.trim());
              setCreated(k.key);
              setLabel("");
            })
          }
        >
          Create key
        </button>
      </div>
      {error && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{error}</p>}
      {keys.isLoading && (
        <div className="table-scroll" aria-busy="true">
          <Loading label="Loading your keys" />
          <table className="data dev-table">
            <thead><tr><th>Label</th><th>Key</th><th>Limit</th><th>Created</th><th>Last used</th><th><span className="sr-only">Revoke</span></th></tr></thead>
            <tbody><SkRows cols={6} rows={2} /></tbody>
          </table>
        </div>
      )}
      {loadError && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{loadError}</p>}
      {keys.data && keys.data.keys.length === 0 && <p className="small muted" style={{ margin: 0 }}>No keys yet.</p>}
      {keys.data && keys.data.keys.length > 0 && (
        <div className="table-scroll" tabIndex={0}>
          <table className="data dev-table">
            <thead><tr><th>Label</th><th>Key</th><th>Limit</th><th>Created</th><th>Last used</th><th><span className="sr-only">Revoke</span></th></tr></thead>
            <tbody>
              {keys.data.keys.map((k) => (
                <tr key={k.id} style={k.revokedAt ? { opacity: 0.55 } : undefined}>
                  <td>{k.label}</td>
                  <td className="mono small">{k.prefix}…</td>
                  <td className="mono small">{k.requestsPerMinute.toLocaleString("en-US")}/min</td>
                  <td className="small muted">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="small muted">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}</td>
                  <td>
                    {k.revokedAt ? (
                      <span className="small muted">Revoked</span>
                    ) : (
                      <button className="btn btn-sm" disabled={busy} onClick={() => window.confirm(`Revoke "${k.label}"? Requests with it fail from now on.`) && act(async () => void (await s.client.revokeKey(k.id)))}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function WebhookConsole() {
  return <SignedIn what="webhooks">{(s) => <Webhooks s={s} />}</SignedIn>;
}

function Webhooks({ s }: { s: Session }) {
  const list = useQuery({ queryKey: ["webhooks", s.address], queryFn: () => s.client.webhooks(), refetchInterval: 10_000 });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const hooks = list.data?.webhooks ?? [];
  const loadError = useQueryError(s, list.error);

  return (
    <div className="stack">
      {secret && <Secret label="Signing secret for your new webhook" value={secret} onDone={() => setSecret(null)} />}
      {creating ? (
        <WebhookForm
          s={s}
          onCancel={() => setCreating(false)}
          onCreated={(w, sec) => {
            setCreating(false);
            setSecret(sec);
            setOpen(w.id);
          }}
        />
      ) : (
        <button className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} disabled={hooks.length >= 10} onClick={() => setCreating(true)}>Add an endpoint</button>
      )}
      {list.isLoading && <><Loading label="Loading your endpoints" /><Sk block w="100%" h={56} /><Sk block w="100%" h={56} /></>}
      {loadError && <p className="notice bad small" role="alert">{loadError}</p>}
      {list.data && hooks.length === 0 && !creating && <p className="small muted" style={{ margin: 0 }}>No endpoints yet. Add one, then send it a test event.</p>}
      {hooks.map((w) => (
        <WebhookCard key={w.id} s={s} w={w} open={open === w.id} onToggle={() => setOpen(open === w.id ? null : w.id)} onSecret={setSecret} />
      ))}
    </div>
  );
}

function WebhookForm({ s, onCancel, onCreated }: { s: Session; onCancel: () => void; onCreated: (w: Webhook, secret: string) => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["launch.created", "swap"]);
  const [addresses, setAddresses] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = addresses.split(/[\s,]+/).filter(Boolean);
  const urlOk = /^https:\/\/[^\s/]+\.[^\s]+$/.test(url.trim());
  const problems = [
    ...(!urlOk ? ["The URL must be a public https address."] : []),
    ...(events.length === 0 ? ["Pick at least one event."] : []),
    ...(list.some((a) => !isAddress(a)) ? ["Every filter entry must be an address."] : []),
    ...(list.length > 50 ? ["Up to 50 filter addresses."] : []),
  ];

  return (
    <div className="lock-card stack">
      <h4 style={{ margin: 0 }}>New endpoint</h4>
      <label className="field">
        <span className="field-label">URL</span>
        <input className="text-input mono" value={url} onChange={(e) => setUrl(e.target.value.trim())} placeholder="https://example.com/curveil/webhooks" aria-invalid={(url !== "" && !urlOk) || undefined} />
        {url !== "" && !urlOk ? <span className="field-error">Use a public https address.</span> : <span className="field-hint">Curveil sends a signed POST here for each event.</span>}
      </label>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
        <legend className="field-label" style={{ marginBottom: 6 }}>Events</legend>
        {WEBHOOK_EVENTS.map((e) => (
          <label key={e} className="check">
            <input type="checkbox" checked={events.includes(e)} onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))} />
            <span><span className="mono">{e}</span> <span className="small muted">{WEBHOOK_EVENT_DESCRIPTIONS[e]}</span></span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field-top"><span className="field-label">Only events that involve these addresses <span className="optional faint">optional</span></span><span className="field-count" data-over={list.length > 50 || undefined}>{list.length}/50</span></span>
        <textarea className="text-input text-area mono" rows={2} value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder="0x…" aria-invalid={list.some((a) => !isAddress(a)) || undefined} />
        {list.some((a) => !isAddress(a)) ? <span className="field-error">Every entry must be an address.</span> : <span className="field-hint">Tokens, pools, wallets or launchpads, separated by commas or spaces.</span>}
      </label>
      <label className="field">
        <span className="field-top"><span className="field-label">Description <span className="optional faint">optional</span></span><span className="field-count">{description.length}/140</span></span>
        <input className="text-input" value={description} maxLength={140} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {problems.length > 0 && url && urlOk && <ul className="small warn-text" style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {error && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{error}</p>}
      <div className="hero-actions" style={{ marginTop: 0 }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || problems.length > 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await s.client.createWebhook({ url: url.trim(), events, ...(list.length ? { filters: { addresses: list } } : {}), ...(description.trim() ? { description: description.trim() } : {}) });
              qc.invalidateQueries({ queryKey: ["webhooks"] });
              onCreated(r.webhook, r.secret);
            } catch (e) {
              setError(s.handle(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Create endpoint
        </button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const STATUS_CLASS: Record<Delivery["status"], string> = { delivered: "tag-live", pending: "tag-public", failed: "tag-warn", dead: "tag-warn" };

function WebhookCard({ s, w, open, onToggle, onSecret }: { s: Session; w: Webhook; open: boolean; onToggle: () => void; onSecret: (v: string) => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Delivery["status"] | "all">("all");
  const [testType, setTestType] = useState<string>(w.events[0] === "*" ? "swap" : (w.events[0] ?? "swap"));
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const deliveries = useQuery({
    queryKey: ["deliveries", w.id, filter],
    queryFn: () => s.client.deliveries(w.id, { limit: 25, ...(filter === "all" ? {} : { status: filter }) }),
    enabled: open,
    refetchInterval: open ? 4_000 : false,
  });
  const deliveriesError = useQueryError(s, deliveries.error);

  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ kind: "good", text });
      qc.invalidateQueries({ queryKey: ["webhooks"] });
      qc.invalidateQueries({ queryKey: ["deliveries", w.id] });
    } catch (e) {
      setMsg({ kind: "bad", text: s.handle(e) });
    } finally {
      setBusy(false);
    }
  }
  const d = w.deliveries;

  return (
    <div className="lock-card stack" style={{ gap: 10 }}>
      <button className="row-between" onClick={onToggle} aria-expanded={open} style={{ background: "none", border: 0, color: "inherit", padding: 0, cursor: "pointer", textAlign: "left", font: "inherit" }}>
        <span style={{ minWidth: 0 }}>
          <span className="mono" style={{ wordBreak: "break-all" }}>{w.url}</span>
          <span className="small muted" style={{ display: "block" }}>
            {w.events.join(", ")}{w.filters?.addresses.length ? ` · ${w.filters.addresses.length} address filter${w.filters.addresses.length === 1 ? "" : "s"}` : ""}{w.description ? ` · ${w.description}` : ""}
          </span>
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {!w.active && <span className="tag tag-illustration">Disabled</span>}
          {d && <span className="tag tag-live">{d.delivered} delivered</span>}
          {d && d.failing > 0 && <span className="tag tag-warn">{d.failing} retrying</span>}
          {d && d.dead > 0 && <span className="tag tag-warn">{d.dead} dead</span>}
        </span>
      </button>

      {open && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="wh-actions">
            <select className="token-select" aria-label="Test event type" value={testType} onChange={(e) => setTestType(e.target.value)}>
              {WEBHOOK_EVENTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <button className="btn btn-sm btn-primary" disabled={busy || !w.active} onClick={() => act(async () => (await s.client.testWebhook(w.id, testType), "Test event queued. It appears below within a few seconds."))}>
              Send test event
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => (await s.client.updateWebhook(w.id, { active: !w.active }), w.active ? "Disabled. Nothing is sent until you enable it." : "Enabled."))}>
              {w.active ? "Disable" : "Enable"}
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                window.confirm("Rotate the signing secret? The old secret stops working immediately.") &&
                act(async () => {
                  const r = await s.client.rotateWebhookSecret(w.id);
                  onSecret(r.secret);
                })
              }
            >
              Rotate secret
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => window.confirm("Delete this endpoint and its delivery history?") && act(async () => void (await s.client.deleteWebhook(w.id)))}>
              Delete
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Secret <span className="mono">{w.secretHint}</span>. Test events carry <span className="mono">"test": true</span> and sample data, signed like real ones.
          </p>
          {msg && <p className={`notice ${msg.kind} small`} role="status" style={{ margin: 0 }}>{msg.text}</p>}

          <div className="row-between">
            <div className="seg" role="group" aria-label="Delivery status" style={{ marginTop: 0 }}>
              {(["all", "delivered", "pending", "failed", "dead"] as const).map((f) => (
                <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "failed" ? "Retrying" : f[0]!.toUpperCase() + f.slice(1)}</button>
              ))}
            </div>
            {d && d.dead > 0 && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => `${(await s.client.replay(w.id, { status: "dead" })).replayed} deliveries queued again.`)}>
                Replay all dead
              </button>
            )}
          </div>
          {deliveries.isLoading && (
            <div className="table-scroll" aria-busy="true">
              <Loading label="Loading deliveries" />
              <table className="data dev-table">
                <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Last answer</th><th>When</th><th><span className="sr-only">Replay</span></th></tr></thead>
                <tbody><SkRows cols={6} rows={3} /></tbody>
              </table>
            </div>
          )}
          {deliveriesError && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{deliveriesError}</p>}
          {deliveries.data && deliveries.data.deliveries.length === 0 && <p className="small muted" style={{ margin: 0 }}>No deliveries{filter === "all" ? " yet" : " with that status"}.</p>}
          {deliveries.data && deliveries.data.deliveries.length > 0 && (
            <div className="table-scroll" tabIndex={0}>
              <table className="data dev-table">
                <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Last answer</th><th>When</th><th><span className="sr-only">Replay</span></th></tr></thead>
                <tbody>
                  {deliveries.data.deliveries.map((x) => (
                    <DeliveryRow key={x.id} x={x} busy={busy} onReplay={() => act(async () => (await s.client.replay(w.id, { deliveries: [x.id] }), "Queued again."))} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeliveryRow({ x, busy, onReplay }: { x: Delivery; busy: boolean; onReplay: () => void }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <tr>
        <td>
          <button className="link-btn mono small" onClick={() => setShow(!show)} aria-expanded={show}>{x.type}</button>
          {(x.payload as { test?: boolean } | null)?.test && <span className="tag tag-illustration" style={{ marginLeft: 6 }}>Test</span>}
        </td>
        <td><span className={`tag ${STATUS_CLASS[x.status]}`}>{x.status === "failed" ? "Retrying" : x.status}</span></td>
        <td className="mono small">{x.attempts}</td>
        <td className="mono small">{x.lastStatus ?? (x.lastError ? "error" : "–")}</td>
        <td className="small muted">{new Date(x.lastAttemptAt ?? x.createdAt).toLocaleString()}</td>
        <td>{(x.status === "dead" || x.status === "failed" || x.status === "delivered") && <button className="btn btn-sm" disabled={busy} onClick={onReplay}>Replay</button>}</td>
      </tr>
      {show && (
        <tr>
          <td colSpan={6}>
            <div className="stack" style={{ gap: 8 }}>
              <span className="small muted">
                Event <span className="mono">{x.eventId}</span> · delivery <span className="mono">{x.id}</span>
                {x.nextAttemptAt && x.status !== "delivered" && x.status !== "dead" && <> · next try {new Date(x.nextAttemptAt).toLocaleTimeString()}</>}
              </span>
              {x.history.length > 0 && (
                <ol className="small mono" style={{ margin: 0, paddingLeft: 18 }}>
                  {x.history.map((h) => (
                    <li key={h.attempt}>
                      {new Date(h.at).toLocaleTimeString()} · {h.status ?? "no answer"} · {h.durationMs} ms{h.error ? ` · ${h.error}` : ""}
                    </li>
                  ))}
                </ol>
              )}
              <pre className="code" tabIndex={0} style={{ maxHeight: 260, overflow: "auto" }}><code>{JSON.stringify(x.payload, null, 2)}</code></pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
