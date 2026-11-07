import { useMemo, useState } from "react";
import { Loading, Sk } from "./Skeleton";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/launchpads";
import { API_URL } from "../lib/config";
import { useT } from "../lib/i18n";

type Schema = { type?: string | string[]; description?: string; properties?: Record<string, Schema>; items?: Schema; required?: string[]; enum?: unknown[]; $ref?: string };
type Param = { name: string; in: string; description?: string; required?: boolean; schema?: Schema };
type Op = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Param[];
  requestBody?: { content?: { "application/json"?: { schema?: Schema } } };
  responses?: Record<string, { description?: string; content?: { "application/json"?: { schema?: Schema } } }>;
  security?: Record<string, unknown>[];
  "x-requires"?: string;
};
type Doc = { info?: { description?: string }; tags?: { name: string; description?: string }[]; paths: Record<string, Record<string, Op>>; components?: { schemas?: Record<string, Schema> } };

const METHOD_ORDER = ["get", "post", "patch", "delete"];

/** The API reference, rendered from the live /v1/openapi.json so it never drifts from the server. */
export function ApiReference() {
  const t = useT();
  const doc = useQuery({ queryKey: ["openapi"], queryFn: () => api.openapi() as Promise<Doc>, staleTime: 300_000 });
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string>("all");

  const groups = useMemo(() => {
    if (!doc.data) return [];
    const term = q.trim().toLowerCase();
    const byTag = new Map<string, { path: string; method: string; op: Op }[]>();
    for (const [path, methods] of Object.entries(doc.data.paths)) {
      for (const method of METHOD_ORDER) {
        const op = methods[method];
        if (!op) continue;
        const tg = op.tags?.[0] ?? "Other";
        if (tag !== "all" && tg !== tag) continue;
        if (term && !`${method} ${path} ${op.summary ?? ""} ${op.description ?? ""}`.toLowerCase().includes(term)) continue;
        byTag.set(tg, [...(byTag.get(tg) ?? []), { path, method, op }]);
      }
    }
    const order = doc.data.tags?.map((t) => t.name) ?? [];
    return [...byTag.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [doc.data, q, tag]);

  if (doc.isLoading) {
    return (
      <div className="stack" aria-busy="true">
        <Loading label={t("Loading the API reference", "正在加载 API 参考")} />
        <div className="toolbar">
          <Sk block w="100%" h={40} style={{ flex: 1 }} />
          <Sk w={140} h={40} />
        </div>
        <Sk block w="70%" />
        {[0, 1].map((g) => (
          <section key={g} className="stack" style={{ gap: 8 }}>
            <h3 style={{ margin: "8px 0 0" }}><Sk w="8ch" /></h3>
            {[0, 1, 2].map((i) => <Sk key={i} block w="100%" h={46} />)}
          </section>
        ))}
      </div>
    );
  }
  if (doc.isError || !doc.data) {
    return (
      <div className="notice bad" role="alert">
        <span>{t("The API description could not be loaded.", "无法加载 API 描述。")}</span>
        <button className="btn btn-sm" onClick={() => doc.refetch()}>{t("Retry", "重试")}</button>
      </div>
    );
  }
  const schemas = doc.data.components?.schemas ?? {};
  const count = groups.reduce((s, [, ops]) => s + ops.length, 0);

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="search">
          <span className="sr-only">{t("Search endpoints", "搜索接口")}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search endpoints", "搜索接口")} />
        </label>
        <label className="small muted sort-select">
          Section{" "}
          <select className="token-select" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="all">{t("All", "全部")}</option>
            {doc.data.tags?.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </label>
        <a className="btn btn-sm" href={`${API_URL}/v1/openapi.json`} target="_blank" rel="noreferrer">openapi.json</a>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {count} endpoints. Base URL <span className="mono">{API_URL}</span>. Amounts are integer strings in the token's smallest unit unless the field name ends in Quote.
      </p>
      {groups.map(([t, ops]) => (
        <section key={t} className="stack" style={{ gap: 8 }}>
          <h3 style={{ margin: "8px 0 0" }}>{t}</h3>
          {doc.data.tags?.find((x) => x.name === t)?.description && t !== "Webhooks" && (
            <p className="small muted" style={{ margin: 0 }}>{doc.data.tags.find((x) => x.name === t)!.description}</p>
          )}
          {ops.map(({ path, method, op }) => <Endpoint key={`${method} ${path}`} path={path} method={method} op={op} schemas={schemas} />)}
        </section>
      ))}
      {count === 0 && <p className="muted">{t("No endpoint matches.", "没有匹配的接口。")}</p>}
    </div>
  );
}

function auth(op: Op): { label: string; cls: string } {
  if (op["x-requires"]) return { label: "Wallet session", cls: "tag-shielded" };
  const open = op.security?.some((s) => Object.keys(s).length === 0);
  return open ? { label: "Public", cls: "tag-illustration" } : { label: "Key or session", cls: "tag-public" };
}

function Endpoint({ path, method, op, schemas }: { path: string; method: string; op: Op; schemas: Record<string, Schema> }) {
  const t = useT();
  const a = auth(op);
  const AUTH_ZH: Record<string, string> = { "Wallet session": "钱包会话", Public: "公开", "Key or session": "密钥或会话" };
  const body = op.requestBody?.content?.["application/json"]?.schema;
  const ok = Object.entries(op.responses ?? {}).find(([code]) => /^2/.test(code));
  const response = ok?.[1].content?.["application/json"]?.schema;
  const sample = curl(method, path, op, body, schemas);
  return (
    <details className="lock-card endpoint">
      <summary style={{ cursor: "pointer", display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className={`mono method method-${method}`}>{method.toUpperCase()}</span>
        <span className="mono" style={{ wordBreak: "break-all" }}>{path}</span>
        <span className="small muted" style={{ flex: 1, minWidth: 180 }}>{op.summary}</span>
        <span className={`tag ${a.cls}`}>{t(a.label, AUTH_ZH[a.label] ?? a.label)}</span>
      </summary>
      <div className="stack" style={{ gap: 10, marginTop: 12 }}>
        {op.description && <p className="small" style={{ margin: 0, whiteSpace: "pre-line" }}>{op.description}</p>}
        {op["x-requires"] && <p className="small muted" style={{ margin: 0 }}>{op["x-requires"]}</p>}
        {op.parameters && op.parameters.length > 0 && (
          <div className="table-scroll" tabIndex={0}>
            <table className="data">
              <thead><tr><th>{t("Parameter", "参数")}</th><th>{t("In", "位置")}</th><th>{t("Type", "类型")}</th><th>{t("Description", "说明")}</th></tr></thead>
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={`${p.in}-${p.name}`}>
                    <td className="mono">{p.name}{p.required ? " *" : ""}</td>
                    <td className="small muted">{p.in}</td>
                    <td className="mono small">{typeName(p.schema, schemas)}</td>
                    <td className="small">{p.description ?? p.schema?.description ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {body && (
          <div>
            <p className="small muted" style={{ margin: "0 0 4px" }}>{t("Request body (JSON)", "请求体（JSON）")}</p>
            <Fields schema={body} schemas={schemas} />
          </div>
        )}
        {response && (
          <div>
            <p className="small muted" style={{ margin: "0 0 4px" }}>{t("Response", "响应")} {ok?.[0]}</p>
            <Fields schema={response} schemas={schemas} />
          </div>
        )}
        <pre className="code" tabIndex={0}><code>{sample}</code></pre>
        {method === "get" && !path.includes("{") && a.label === "Public" && (
          <a className="small" href={`${API_URL}${path}`} target="_blank" rel="noreferrer">{t("Open the live response", "查看实时响应")}</a>
        )}
      </div>
    </details>
  );
}

const resolve = (s: Schema | undefined, schemas: Record<string, Schema>): Schema | undefined => (s?.$ref ? schemas[s.$ref.split("/").pop()!] : s);
const refName = (s: Schema | undefined) => s?.$ref?.split("/").pop();

function typeName(s: Schema | undefined, schemas: Record<string, Schema>): string {
  if (!s) return "";
  if (s.$ref) return refName(s)!;
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type ?? "any";
  if (t === "array") return `${typeName(s.items, schemas)}[]`;
  if (s.enum) return s.enum.map(String).join(" | ");
  return t;
}

function Fields({ schema, schemas, depth = 0 }: { schema: Schema; schemas: Record<string, Schema>; depth?: number }) {
  const s = resolve(schema, schemas);
  if (!s) return null;
  const target = s.type === "array" ? resolve(s.items, schemas) : s;
  const props = target?.properties;
  if (!props) return <span className="mono small">{typeName(schema, schemas)}</span>;
  return (
    <ul className="schema-fields">
      {s.type === "array" && depth === 0 && <li className="small muted">An array of {refName(s.items) ?? "objects"}:</li>}
      {Object.entries(props).map(([name, p]) => {
        const inner = resolve(p.type === "array" ? p.items : p, schemas);
        const nested = depth < 2 && inner?.properties;
        return (
          <li key={name}>
            <span className="mono">{name}</span>
            {target?.required?.includes(name) && <span className="warn-text"> *</span>} <span className="mono small faint">{typeName(p, schemas)}</span>
            {(p.description || inner?.description) && <span className="small muted"> {p.description ?? inner?.description}</span>}
            {nested && <Fields schema={p.type === "array" ? p.items! : p} schemas={schemas} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

function example(s: Schema | undefined, schemas: Record<string, Schema>, depth = 0): unknown {
  const r = resolve(s, schemas);
  if (!r || depth > 3) return null;
  if (r.enum) return r.enum[0];
  const t = Array.isArray(r.type) ? r.type[0] : r.type;
  if (t === "object" && r.properties) {
    const keys = r.required?.length ? r.required : Object.keys(r.properties).slice(0, 3);
    return Object.fromEntries(keys.map((k) => [k, example(r.properties![k], schemas, depth + 1)]));
  }
  if (t === "array") return [example(r.items, schemas, depth + 1)];
  if (t === "integer" || t === "number") return 0;
  if (t === "boolean") return true;
  return /address/i.test(r.description ?? "") ? "0x…" : "…";
}

function curl(method: string, path: string, op: Op, body: Schema | undefined, schemas: Record<string, Schema>): string {
  const a = auth(op);
  const lines = [`curl${method === "get" ? "" : ` -X ${method.toUpperCase()}`} "${API_URL}${path}"`];
  if (a.label === "Wallet session") lines.push(`  -H "Authorization: Bearer $CURVEIL_SESSION"`);
  else if (a.label === "Key or session") lines.push(`  -H "X-API-Key: $CURVEIL_API_KEY"`);
  if (body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${JSON.stringify(example(body, schemas))}'`);
  }
  return lines.join(" \\\n");
}
