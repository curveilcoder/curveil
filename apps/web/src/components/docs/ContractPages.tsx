import { TokenDisc } from "../TokenPair";
import { manifest, explorerAddress, explorerTx, shortAddress } from "../../lib/config";
import { useQuery } from "@tanstack/react-query";
import { getJson, useStatus } from "../../lib/api";
import { fmtAmount, timeAgo } from "../../lib/format";
import { toFunctionSelector, type AbiFunction } from "viem";
import { Callout, Section } from "./Kit";

/** The transparency pages of /docs: what is deployed, who controls it, and which assets are admitted. */
export function ContractPage({ page }: { page: "contracts" | "admin" | "assets" }) {
  if (page === "admin") return <Admin />;
  if (page === "assets") return <Assets />;
  return <Contracts />;
}

function Contracts() {
  const { data } = useStatus();
  const contracts = Object.entries(manifest.contracts);
  return (
    <>
      <Section title="Network">
      <p className="dk-p">Every address the site uses comes from this list. Check each one on the explorer before you trust it.</p>
      <dl className="kv">
        <div><dt>Network</dt><dd>{manifest.network} · chain {manifest.chainId}</dd></div>
        <div>
          <dt>Manifest version</dt>
          <dd className="mono">
            {manifest.version}
            {data && data.manifestVersion !== manifest.version && <span className="small" style={{ color: "var(--warn)", marginLeft: 8 }}>The API serves {data.manifestVersion}. Reload to update.</span>}
          </dd>
        </div>
      </dl>
      </Section>
      <Section title="Deployed contracts">
      <div className="table-scroll" tabIndex={0}>
        <table className="data">
          <thead><tr><th>Name</th><th>Address</th><th>Deployed</th><th>Source</th><th>Code hash</th></tr></thead>
          <tbody>
            {contracts.map(([name, c]) => (
              <tr key={name}>
                <td>{name}{name.startsWith("Test") && <span className="tag tag-illustration" style={{ marginLeft: 8 }}>Testnet only</span>}</td>
                <td className="addr"><a href={explorerAddress(c.address)} target="_blank" rel="noreferrer">{c.address}</a></td>
                <td className="small">Block {c.deployBlock.toLocaleString("en-US")}<br /><a href={explorerTx(c.deployTx)} target="_blank" rel="noreferrer">{shortAddress(c.deployTx)}</a></td>
                <td>{c.verified ? <span className="tag tag-live">Verified</span> : <span className="tag tag-illustration">Unverified</span>}<br /><span className="small muted mono">{c.source}</span></td>
                <td className="addr small">{shortAddress(c.codeHash)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Section>
    </>
  );
}

/** "72 hours", "10 minutes", or "None yet". */
export function delayLabel(seconds: number | null | undefined): string {
  if (!seconds) return "None yet";
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function Admin() {
  return (
    <>
      <Section title="Who controls it today">
      <dl className="kv">
        <div><dt>Current owner of admin functions</dt><dd className="addr"><a href={explorerAddress(manifest.admin.owner)} target="_blank" rel="noreferrer">{manifest.admin.owner}</a></dd></div>
        <div><dt>Multisig</dt><dd className="addr">{manifest.admin.safe ? <a href={explorerAddress(manifest.admin.safe)} target="_blank" rel="noreferrer">{manifest.admin.safe}</a> : "Not deployed"}</dd></div>
        <div><dt>Timelock</dt><dd className="addr">{manifest.admin.timelock ? <a href={explorerAddress(manifest.admin.timelock)} target="_blank" rel="noreferrer">{manifest.admin.timelock}</a> : "Not deployed"}</dd></div>
        <div><dt>Delay</dt><dd>{delayLabel(manifest.admin.timelockDelaySeconds)}</dd></div>
      </dl>
      {manifest.admin.timelock && !same(manifest.admin.owner, manifest.admin.timelock) && (
        <p className="small muted">
          The timelock is deployed but does not own the contracts yet{manifest.network === "testnet" ? ": on testnet it is a rehearsal, and the deployer key keeps admin rights so the test setup can move fast" : ""}.
        </p>
      )}
      </Section>
      <Governance />
      {manifest.network === "testnet" && (
        <Section title="The mainnet plan">
          <Callout kind="warn">
            On testnet, admin functions are held by a single deployer key. On mainnet every contract is owned by a 72-hour timelock (it refuses a shorter delay), and the
            timelock is controlled by a publicly identified 3-of-3 multisig, which can also pause new risk at once. That is a plan until it appears above.
          </Callout>
        </Section>
      )}
    </>
  );
}

function Assets() {
  return (
    <Section title="Assets on this network">
      <p className="dk-p">Pools accept only these assets. The Vault accepts the ones open for shielding on its page.</p>
      <div className="table-scroll" tabIndex={0}>
        <table className="data">
          <thead><tr><th>Token</th><th>Name</th><th>Address</th><th>Decimals</th></tr></thead>
          <tbody>
            {manifest.assets.map((a) => (
              <tr key={a.address}>
                <td><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><TokenDisc token={a} size={20} />{a.symbol}</span></td>
                <td>{a.testOnly ? `${a.name ?? a.label} (test token, no value)` : a.name ?? a.label}</td>
                <td className="addr"><a href={explorerAddress(a.address)} target="_blank" rel="noreferrer">{a.address}</a></td>
                <td className="mono">{a.decimals}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type QueueItem = {
  id: string;
  calls: { index: number; target: string; value: string; data: string }[];
  delaySeconds: number;
  scheduledAt: number;
  readyAt: number;
  scheduledTx: string;
  state: "pending" | "ready" | "executed" | "cancelled";
  doneAt: number | null;
  doneTx: string | null;
};
type Governance = {
  queue: QueueItem[];
  treasuries: { name: string; address: string; balances: Record<string, string | null> }[];
  releases: { contract: string; token: string; to: string; amount: string; memo: string; timestamp: number; txHash: string }[];
  buyback: { address: string; usdg: string | null; burnedSupply: string | null; recent: { kind: string; usdgIn?: string; tokensBurned?: string; amount?: string; memo?: string; timestamp: number; txHash: string }[] } | null;
};

// Admin function names by selector, from every published ABI, so the queue reads "bind" and not 0xd1ec9f14.
const abis = import.meta.glob<{ default: unknown[] }>("../../../../../packages/manifest/abis/*.json", { eager: true });
const SELECTORS = new Map<string, string>();
for (const mod of Object.values(abis)) {
  for (const item of mod.default as AbiFunction[]) {
    if (item.type !== "function" || item.stateMutability === "view" || item.stateMutability === "pure") continue;
    try {
      SELECTORS.set(toFunctionSelector(item), item.name);
    } catch {
      /* skip malformed entries */
    }
  }
}
const callName = (data: string) => SELECTORS.get(data.slice(0, 10).toLowerCase()) ?? data.slice(0, 10);

const nameAt = (address: string) => Object.entries(manifest.contracts).find(([, c]) => same(c.address, address))?.[0] ?? shortAddress(address);
const assetBy = (key: string) => manifest.assets.find((a) => a.symbol === key || same(a.address, key));
const STATE: Record<QueueItem["state"], string> = { pending: "Waiting for the delay", ready: "Can execute now", executed: "Executed", cancelled: "Cancelled" };
const TREASURY_LABEL: Record<string, string> = {
  TreasuryMarkets: "Markets",
  TreasuryLaunch: "Launches",
  TreasuryVault: "Vault",
  TreasuryPerps: "Perps",
  TreasuryFactory: "Launchpads",
};

/** The timelock queue, treasuries and buybacks, from the API (events) and the chain (balances). */
function Governance() {
  const q = useQuery({ queryKey: ["governance"], queryFn: () => getJson<Governance>("/v1/governance"), refetchInterval: 30_000, retry: 2 });
  if (q.isError) return <Section title="Admin queue"><p className="dk-p muted">The admin queue could not be loaded. Try again in a moment.</p></Section>;
  if (!q.data) return <Section title="Admin queue"><p className="dk-p muted">Loading…</p></Section>;
  const g = q.data;
  const open = g.queue.filter((o) => o.state === "pending" || o.state === "ready");
  return (
    <>
      <Section title="Admin queue">
        <p className="dk-p">
          Every admin change waits in the timelock for {delayLabel(manifest.admin.timelockDelaySeconds).toLowerCase()} before it can run, and appears here the moment it is
          scheduled. {open.length ? `${open.length} waiting now.` : "Nothing is waiting now."}
        </p>
        {g.queue.length > 0 && (
          <div className="table-scroll" tabIndex={0}>
            <table className="data">
              <thead><tr><th>Scheduled</th><th>Calls</th><th>State</th><th>Transaction</th></tr></thead>
              <tbody>
                {g.queue.map((o) => (
                  <tr key={o.id}>
                    <td>{timeAgo(o.scheduledAt)}</td>
                    <td>
                      {o.calls.map((c) => (
                        <div key={c.index} className="mono small">{nameAt(c.target)}.{callName(c.data)}</div>
                      ))}
                    </td>
                    <td>
                      {STATE[o.state]}
                      {o.state === "pending" && <div className="small muted">from {new Date(o.readyAt * 1000).toLocaleString()}</div>}
                    </td>
                    <td className="addr">
                      <a href={explorerTx(o.doneTx ?? o.scheduledTx)} target="_blank" rel="noreferrer">{shortAddress(o.doneTx ?? o.scheduledTx)}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Treasuries">
        <p className="dk-p">Protocol fees collect in one treasury per module. Only the timelock can release them, and only the Safe can use the timelock, so every release needs a Safe vote and is scheduled publicly first.</p>
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead><tr><th>Treasury</th><th>Address</th>{manifest.assets.map((a) => <th key={a.address}>{a.symbol}</th>)}</tr></thead>
            <tbody>
              {g.treasuries.map((t) => (
                <tr key={t.address}>
                  <td>{TREASURY_LABEL[t.name] ?? t.name}</td>
                  <td className="addr"><a href={explorerAddress(t.address)} target="_blank" rel="noreferrer">{shortAddress(t.address)}</a></td>
                  {manifest.assets.map((a) => <td key={a.address} className="mono">{t.balances[a.symbol] === null || t.balances[a.symbol] === undefined ? "–" : fmtAmount(t.balances[a.symbol]!, a.decimals)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {g.releases.length > 0 && (
          <>
            <p className="dk-p">Recent releases</p>
            <ul className="small">
              {g.releases.map((r) => {
                const a = assetBy(r.token);
                return (
                  <li key={r.txHash + r.memo}>
                    {timeAgo(r.timestamp)}: {a ? `${fmtAmount(r.amount, a.decimals)} ${a.symbol}` : r.amount} from {TREASURY_LABEL[r.contract] ?? r.contract} to <span className="mono">{shortAddress(r.to)}</span>
                    {r.memo ? ` (${r.memo})` : ""}. <a href={explorerTx(r.txHash)} target="_blank" rel="noreferrer">Transaction</a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>
      {g.buyback && (
        <Section title="Buybacks">
          <dl className="kv">
            <div><dt>Buyback contract</dt><dd className="addr"><a href={explorerAddress(g.buyback.address)} target="_blank" rel="noreferrer">{g.buyback.address}</a></dd></div>
            <div><dt>USDG waiting to buy back</dt><dd className="mono">{g.buyback.usdg === null ? "–" : fmtAmount(g.buyback.usdg, assetBy("USDG")?.decimals ?? manifest.assets.find((a) => a.label === "USDG")?.decimals ?? 6)}</dd></div>
            <div><dt>$CURVEIL burned so far</dt><dd className="mono">{g.buyback.burnedSupply === null ? "–" : fmtAmount(g.buyback.burnedSupply, 18, 0)}</dd></div>
          </dl>
          {g.buyback.recent.length === 0 ? (
            <p className="small muted">No buybacks yet. Each one buys $CURVEIL in its pool, burns it, and shows here with its price impact.</p>
          ) : (
            <ul className="small">
              {g.buyback.recent.map((b) => (
                <li key={b.txHash}>
                  {timeAgo(b.timestamp)}:{" "}
                  {b.kind === "Burned" ? `${fmtAmount(b.usdgIn ?? "0", 6)} USDG bought and burned ${fmtAmount(b.tokensBurned ?? "0", 18, 0)} $CURVEIL` : `${fmtAmount(b.amount ?? "0", 6)} USDG returned${b.memo ? ` (${b.memo})` : ""}`}.{" "}
                  <a href={explorerTx(b.txHash)} target="_blank" rel="noreferrer">Transaction</a>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}
