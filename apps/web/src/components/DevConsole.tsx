import { useEffect, useState, type ReactNode } from "react";
import { Loading, Sk, SkRows } from "./Skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS, type Delivery, type Webhook } from "@curveil/sdk";
import { isAddress } from "viem";
import { WalletAction } from "./WalletAction";
import { useSession, type Session } from "../lib/session";
import { useT } from "../lib/i18n";

/** Sign-in gate for the developer console: keys and webhooks belong to a wallet. */
export function SignedIn({ children, what }: { children: (s: Session) => ReactNode; what: string }) {
  const tr = useT();
  const session = useSession();
  return (
    <WalletAction verb={tr(`manage ${what}`, `管理${what}`)}>
      {session.signedIn ? (
        <div className="stack">{children(session)}</div>
      ) : (
        <div className="wallet-gate">
          <p className="small muted" style={{ margin: 0 }}>
            {tr(`Sign in with your wallet to manage ${what}. You sign a plain-text message (Sign-In with Ethereum); it is not a transaction and costs nothing.`, `用钱包登录以管理${what}。你只需签署一条纯文本消息（以太坊登录），这不是交易，也不花费任何费用。`)}
          </p>
          <button className="btn btn-primary" onClick={session.signIn} disabled={session.signingIn}>{session.signingIn ? tr("Check your wallet…", "请在钱包中确认…") : tr("Sign in with your wallet", "用钱包登录")}</button>
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
  const tr = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice good" role="status">
      <div className="stack" style={{ gap: 8, width: "100%" }}>
        <strong className="small">{label}</strong>
        <span className="small">{tr("This is the only time it is shown. Store it somewhere safe now; if you lose it, create a new one.", "这是唯一一次显示。请立即妥善保存；如果丢失，请新建一个。")}</span>
        <div className="field-row">
          <input className="text-input mono" readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
          <button
            className="btn btn-sm"
            onClick={() => {
              navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
            }}
          >
            {copied ? tr("Copied", "已复制") : tr("Copy", "复制")}
          </button>
        </div>
        <button className="link-btn small" style={{ justifySelf: "start" }} onClick={onDone}>{tr("I stored it", "我已保存")}</button>
      </div>
    </div>
  );
}

export function ApiKeys() {
  const tr = useT();
  return <SignedIn what={tr("API keys", "API 密钥")}>{(s) => <KeyList s={s} />}</SignedIn>;
}

function KeyList({ s }: { s: Session }) {
  const tr = useT();
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
        {tr(<>Reads need no key: 300 requests a minute per IP. A key raises that to 3,000 a minute, counted per key. Send it as <span className="mono">X-API-Key</span> or{" "}
        <span className="mono">Authorization: Bearer</span>. Keys can read and manage webhooks but cannot create other keys. Up to 5 per wallet; Curveil stores only a hash.</>, <>读取无需密钥：每个 IP 每分钟 300 次请求。密钥可将其提升到每分钟 3,000 次，按密钥计算。通过 <span className="mono">X-API-Key</span> 或 <span className="mono">Authorization: Bearer</span> 发送。密钥可读取和管理 webhook，但不能创建其他密钥。每个钱包最多 5 个；Curveil 只保存哈希值。</>)}
      </p>
      {created && <Secret label={tr("Your new API key", "你的新 API 密钥")} value={created} onDone={() => setCreated(null)} />}
      <div className="field-row">
        <input className="text-input" aria-label={tr("Key label", "密钥标签")} placeholder={tr("Label, e.g. production backend", "标签，例如 production backend")} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
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
          {tr("Create key", "创建密钥")}
        </button>
      </div>
      {error && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{error}</p>}
      {keys.isLoading && (
        <div className="table-scroll" aria-busy="true">
          <Loading label={tr("Loading your keys", "正在加载你的密钥")} />
          <table className="data dev-table">
            <thead><tr><th>{tr("Label", "标签")}</th><th>{tr("Key", "密钥")}</th><th>{tr("Limit", "限额")}</th><th>{tr("Created", "创建于")}</th><th>{tr("Last used", "上次使用")}</th><th><span className="sr-only">{tr("Revoke", "撤销")}</span></th></tr></thead>
            <tbody><SkRows cols={6} rows={2} /></tbody>
          </table>
        </div>
      )}
      {loadError && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{loadError}</p>}
      {keys.data && keys.data.keys.length === 0 && <p className="small muted" style={{ margin: 0 }}>{tr("No keys yet.", "还没有密钥。")}</p>}
      {keys.data && keys.data.keys.length > 0 && (
        <div className="table-scroll" tabIndex={0}>
          <table className="data dev-table">
            <thead><tr><th>{tr("Label", "标签")}</th><th>{tr("Key", "密钥")}</th><th>{tr("Limit", "限额")}</th><th>{tr("Created", "创建于")}</th><th>{tr("Last used", "上次使用")}</th><th><span className="sr-only">{tr("Revoke", "撤销")}</span></th></tr></thead>
            <tbody>
              {keys.data.keys.map((k) => (
                <tr key={k.id} style={k.revokedAt ? { opacity: 0.55 } : undefined}>
                  <td>{k.label}</td>
                  <td className="mono small">{k.prefix}…</td>
                  <td className="mono small">{k.requestsPerMinute.toLocaleString("en-US")}/min</td>
                  <td className="small muted">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="small muted">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : tr("Never", "从未")}</td>
                  <td>
                    {k.revokedAt ? (
                      <span className="small muted">{tr("Revoked", "已撤销")}</span>
                    ) : (
                      <button className="btn btn-sm" disabled={busy} onClick={() => window.confirm(tr(`Revoke "${k.label}"? Requests with it fail from now on.`, `撤销“${k.label}”？此后使用它的请求都会失败。`)) && act(async () => void (await s.client.revokeKey(k.id)))}>
                        {tr("Revoke", "撤销")}
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
  const tr = useT();
  return <SignedIn what={tr("webhooks", " webhook")}>{(s) => <Webhooks s={s} />}</SignedIn>;
}

function Webhooks({ s }: { s: Session }) {
  const tr = useT();
  const list = useQuery({ queryKey: ["webhooks", s.address], queryFn: () => s.client.webhooks(), refetchInterval: 10_000 });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const hooks = list.data?.webhooks ?? [];
  const loadError = useQueryError(s, list.error);

  return (
    <div className="stack">
      {secret && <Secret label={tr("Signing secret for your new webhook", "新 webhook 的签名密钥")} value={secret} onDone={() => setSecret(null)} />}
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
        <button className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} disabled={hooks.length >= 10} onClick={() => setCreating(true)}>{tr("Add an endpoint", "添加端点")}</button>
      )}
      {list.isLoading && <><Loading label={tr("Loading your endpoints", "正在加载你的端点")} /><Sk block w="100%" h={56} /><Sk block w="100%" h={56} /></>}
      {loadError && <p className="notice bad small" role="alert">{loadError}</p>}
      {list.data && hooks.length === 0 && !creating && <p className="small muted" style={{ margin: 0 }}>{tr("No endpoints yet. Add one, then send it a test event.", "还没有端点。添加一个，然后向它发送测试事件。")}</p>}
      {hooks.map((w) => (
        <WebhookCard key={w.id} s={s} w={w} open={open === w.id} onToggle={() => setOpen(open === w.id ? null : w.id)} onSecret={setSecret} />
      ))}
    </div>
  );
}

function WebhookForm({ s, onCancel, onCreated }: { s: Session; onCancel: () => void; onCreated: (w: Webhook, secret: string) => void }) {
  const tr = useT();
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
    ...(!urlOk ? [tr("The URL must be a public https address.", "URL 必须是公开的 https 地址。")] : []),
    ...(events.length === 0 ? [tr("Pick at least one event.", "请至少选择一个事件。")] : []),
    ...(list.some((a) => !isAddress(a)) ? [tr("Every filter entry must be an address.", "每个筛选条目都必须是地址。")] : []),
    ...(list.length > 50 ? [tr("Up to 50 filter addresses.", "最多 50 个筛选地址。")] : []),
  ];

  return (
    <div className="lock-card stack">
      <h4 style={{ margin: 0 }}>{tr("New endpoint", "新端点")}</h4>
      <label className="field">
        <span className="field-label">URL</span>
        <input className="text-input mono" value={url} onChange={(e) => setUrl(e.target.value.trim())} placeholder="https://example.com/curveil/webhooks" aria-invalid={(url !== "" && !urlOk) || undefined} />
        {url !== "" && !urlOk ? <span className="field-error">{tr("Use a public https address.", "请使用公开的 https 地址。")}</span> : <span className="field-hint">{tr("Curveil sends a signed POST here for each event.", "每个事件 Curveil 都会向这里发送一个已签名的 POST 请求。")}</span>}
      </label>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
        <legend className="field-label" style={{ marginBottom: 6 }}>{tr("Events", "事件")}</legend>
        {WEBHOOK_EVENTS.map((e) => (
          <label key={e} className="check">
            <input type="checkbox" checked={events.includes(e)} onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))} />
            <span><span className="mono">{e}</span> <span className="small muted">{WEBHOOK_EVENT_DESCRIPTIONS[e]}</span></span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field-top"><span className="field-label">{tr("Only events that involve these addresses", "只接收涉及这些地址的事件")} <span className="optional faint">{tr("optional", "可选")}</span></span><span className="field-count" data-over={list.length > 50 || undefined}>{list.length}/50</span></span>
        <textarea className="text-input text-area mono" rows={2} value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder="0x…" aria-invalid={list.some((a) => !isAddress(a)) || undefined} />
        {list.some((a) => !isAddress(a)) ? <span className="field-error">{tr("Every entry must be an address.", "每个条目都必须是地址。")}</span> : <span className="field-hint">{tr("Tokens, pools, wallets or launchpads, separated by commas or spaces.", "代币、资金池、钱包或发射台，用逗号或空格分隔。")}</span>}
      </label>
      <label className="field">
        <span className="field-top"><span className="field-label">{tr("Description", "描述")} <span className="optional faint">{tr("optional", "可选")}</span></span><span className="field-count">{description.length}/140</span></span>
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
          {tr("Create endpoint", "创建端点")}
        </button>
        <button className="btn btn-sm" onClick={onCancel}>{tr("Cancel", "取消")}</button>
      </div>
    </div>
  );
}

const DELIVERY_ZH: Record<Delivery["status"] | "all", string> = { all: "全部", delivered: "已送达", pending: "等待中", failed: "重试中", dead: "已放弃" };

const STATUS_CLASS: Record<Delivery["status"], string> = { delivered: "tag-live", pending: "tag-public", failed: "tag-warn", dead: "tag-warn" };

function WebhookCard({ s, w, open, onToggle, onSecret }: { s: Session; w: Webhook; open: boolean; onToggle: () => void; onSecret: (v: string) => void }) {
  const tr = useT();
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
            {w.events.join(", ")}{w.filters?.addresses.length ? tr(` · ${w.filters.addresses.length} address filter${w.filters.addresses.length === 1 ? "" : "s"}`, ` · ${w.filters.addresses.length} 个地址筛选`) : ""}{w.description ? ` · ${w.description}` : ""}
          </span>
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {!w.active && <span className="tag tag-illustration">{tr("Disabled", "已停用")}</span>}
          {d && <span className="tag tag-live">{tr(`${d.delivered} delivered`, `已送达 ${d.delivered}`)}</span>}
          {d && d.failing > 0 && <span className="tag tag-warn">{tr(`${d.failing} retrying`, `重试中 ${d.failing}`)}</span>}
          {d && d.dead > 0 && <span className="tag tag-warn">{tr(`${d.dead} dead`, `已放弃 ${d.dead}`)}</span>}
        </span>
      </button>

      {open && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="wh-actions">
            <select className="token-select" aria-label={tr("Test event type", "测试事件类型")} value={testType} onChange={(e) => setTestType(e.target.value)}>
              {WEBHOOK_EVENTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <button className="btn btn-sm btn-primary" disabled={busy || !w.active} onClick={() => act(async () => (await s.client.testWebhook(w.id, testType), tr("Test event queued. It appears below within a few seconds.", "测试事件已排队，几秒内会显示在下方。")))}>
              {tr("Send test event", "发送测试事件")}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => (await s.client.updateWebhook(w.id, { active: !w.active }), w.active ? tr("Disabled. Nothing is sent until you enable it.", "已停用。启用之前不会发送任何内容。") : tr("Enabled.", "已启用。")))}>
              {w.active ? tr("Disable", "停用") : tr("Enable", "启用")}
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                window.confirm(tr("Rotate the signing secret? The old secret stops working immediately.", "轮换签名密钥？旧密钥将立即失效。")) &&
                act(async () => {
                  const r = await s.client.rotateWebhookSecret(w.id);
                  onSecret(r.secret);
                })
              }
            >
              {tr("Rotate secret", "轮换密钥")}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => window.confirm(tr("Delete this endpoint and its delivery history?", "删除此端点及其投递记录？")) && act(async () => void (await s.client.deleteWebhook(w.id)))}>
              {tr("Delete", "删除")}
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {tr(<>Secret <span className="mono">{w.secretHint}</span>. Test events carry <span className="mono">"test": true</span> and sample data, signed like real ones.</>, <>密钥 <span className="mono">{w.secretHint}</span>。测试事件带有 <span className="mono">"test": true</span> 和示例数据，签名方式与真实事件相同。</>)}
          </p>
          {msg && <p className={`notice ${msg.kind} small`} role="status" style={{ margin: 0 }}>{msg.text}</p>}

          <div className="row-between">
            <div className="seg" role="group" aria-label={tr("Delivery status", "投递状态")} style={{ marginTop: 0 }}>
              {(["all", "delivered", "pending", "failed", "dead"] as const).map((f) => (
                <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{tr(f === "all" ? "All" : f === "failed" ? "Retrying" : f[0]!.toUpperCase() + f.slice(1), DELIVERY_ZH[f])}</button>
              ))}
            </div>
            {d && d.dead > 0 && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => ((n) => tr(`${n} deliveries queued again.`, `${n} 次投递已重新排队。`))((await s.client.replay(w.id, { status: "dead" })).replayed))}>
                {tr("Replay all dead", "重放所有已放弃的")}
              </button>
            )}
          </div>
          {deliveries.isLoading && (
            <div className="table-scroll" aria-busy="true">
              <Loading label={tr("Loading deliveries", "正在加载投递记录")} />
              <table className="data dev-table">
                <thead><tr><th>{tr("Event", "事件")}</th><th>{tr("Status", "状态")}</th><th>{tr("Attempts", "尝试次数")}</th><th>{tr("Last answer", "最后响应")}</th><th>{tr("When", "时间")}</th><th><span className="sr-only">{tr("Replay", "重放")}</span></th></tr></thead>
                <tbody><SkRows cols={6} rows={3} /></tbody>
              </table>
            </div>
          )}
          {deliveriesError && <p className="notice bad small" role="alert" style={{ margin: 0 }}>{deliveriesError}</p>}
          {deliveries.data && deliveries.data.deliveries.length === 0 && <p className="small muted" style={{ margin: 0 }}>{filter === "all" ? tr("No deliveries yet.", "还没有投递记录。") : tr("No deliveries with that status.", "没有该状态的投递记录。")}</p>}
          {deliveries.data && deliveries.data.deliveries.length > 0 && (
            <div className="table-scroll" tabIndex={0}>
              <table className="data dev-table">
                <thead><tr><th>{tr("Event", "事件")}</th><th>{tr("Status", "状态")}</th><th>{tr("Attempts", "尝试次数")}</th><th>{tr("Last answer", "最后响应")}</th><th>{tr("When", "时间")}</th><th><span className="sr-only">{tr("Replay", "重放")}</span></th></tr></thead>
                <tbody>
                  {deliveries.data.deliveries.map((x) => (
                    <DeliveryRow key={x.id} x={x} busy={busy} onReplay={() => act(async () => (await s.client.replay(w.id, { deliveries: [x.id] }), tr("Queued again.", "已重新排队。")))} />
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
  const tr = useT();
  const [show, setShow] = useState(false);
  return (
    <>
      <tr>
        <td>
          <button className="link-btn mono small" onClick={() => setShow(!show)} aria-expanded={show}>{x.type}</button>
          {(x.payload as { test?: boolean } | null)?.test && <span className="tag tag-illustration" style={{ marginLeft: 6 }}>{tr("Test", "测试")}</span>}
        </td>
        <td><span className={`tag ${STATUS_CLASS[x.status]}`}>{tr(x.status === "failed" ? "Retrying" : x.status, DELIVERY_ZH[x.status])}</span></td>
        <td className="mono small">{x.attempts}</td>
        <td className="mono small">{x.lastStatus ?? (x.lastError ? "error" : "–")}</td>
        <td className="small muted">{new Date(x.lastAttemptAt ?? x.createdAt).toLocaleString()}</td>
        <td>{(x.status === "dead" || x.status === "failed" || x.status === "delivered") && <button className="btn btn-sm" disabled={busy} onClick={onReplay}>{tr("Replay", "重放")}</button>}</td>
      </tr>
      {show && (
        <tr>
          <td colSpan={6}>
            <div className="stack" style={{ gap: 8 }}>
              <span className="small muted">
                {tr("Event", "事件")} <span className="mono">{x.eventId}</span> · {tr("delivery", "投递")} <span className="mono">{x.id}</span>
                {x.nextAttemptAt && x.status !== "delivered" && x.status !== "dead" && <> · {tr("next try", "下次尝试")} {new Date(x.nextAttemptAt).toLocaleTimeString()}</>}
              </span>
              {x.history.length > 0 && (
                <ol className="small mono" style={{ margin: 0, paddingLeft: 18 }}>
                  {x.history.map((h) => (
                    <li key={h.attempt}>
                      {new Date(h.at).toLocaleTimeString()} · {h.status ?? tr("no answer", "无响应")} · {h.durationMs} ms{h.error ? ` · ${h.error}` : ""}
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
