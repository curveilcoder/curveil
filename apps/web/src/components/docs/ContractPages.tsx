import { TokenDisc } from "../TokenPair";
import { manifest, explorerAddress, explorerTx, shortAddress } from "../../lib/config";
import { useQuery } from "@tanstack/react-query";
import { getJson, useStatus } from "../../lib/api";
import { fmtAmount, timeAgo } from "../../lib/format";
import { toFunctionSelector, type AbiFunction } from "viem";
import { Callout, Section } from "./Kit";
import { tNow, useT } from "../../lib/i18n";

/** The transparency pages of /docs: what is deployed, who controls it, and which assets are admitted. */
export function ContractPage({ page }: { page: "contracts" | "admin" | "assets" }) {
  if (page === "admin") return <Admin />;
  if (page === "assets") return <Assets />;
  return <Contracts />;
}

function Contracts() {
  const t = useT();
  const { data } = useStatus();
  const contracts = Object.entries(manifest.contracts);
  return (
    <>
      <Section title={t("Network", "网络")} id="network">
      <p className="dk-p">{t("Every address the site uses comes from this list. Check each one on the explorer before you trust it.", "本网站使用的每个地址都来自这份列表。信任任何地址之前，请先在区块浏览器上核对。")}</p>
      <dl className="kv">
        <div><dt>{t("Network", "网络")}</dt><dd>{manifest.network} · {t("chain", "链 ID")} {manifest.chainId}</dd></div>
        <div>
          <dt>{t("Manifest version", "清单版本")}</dt>
          <dd className="mono">
            {manifest.version}
            {data && data.manifestVersion !== manifest.version && <span className="small" style={{ color: "var(--warn)", marginLeft: 8 }}>{t(`The API serves ${data.manifestVersion}. Reload to update.`, `API 提供的是 ${data.manifestVersion}，请刷新页面更新。`)}</span>}
          </dd>
        </div>
      </dl>
      </Section>
      <Section title={t("Deployed contracts", "已部署合约")} id="deployed-contracts">
      <div className="table-scroll" tabIndex={0}>
        <table className="data">
          <thead><tr><th>{t("Name", "名称")}</th><th>{t("Address", "地址")}</th><th>{t("Deployed", "部署")}</th><th>{t("Source", "源代码")}</th><th>{t("Code hash", "代码哈希")}</th></tr></thead>
          <tbody>
            {contracts.map(([name, c]) => (
              <tr key={name}>
                <td>{name}{name.startsWith("Test") && <span className="tag tag-illustration" style={{ marginLeft: 8 }}>{t("Testnet only", "仅测试网")}</span>}</td>
                <td className="addr"><a href={explorerAddress(c.address)} target="_blank" rel="noreferrer">{c.address}</a></td>
                <td className="small">{t("Block", "区块")} {c.deployBlock.toLocaleString("en-US")}<br /><a href={explorerTx(c.deployTx)} target="_blank" rel="noreferrer">{shortAddress(c.deployTx)}</a></td>
                <td>{c.verified ? <span className="tag tag-live">{t("Verified", "已验证")}</span> : <span className="tag tag-illustration">{t("Unverified", "未验证")}</span>}<br /><span className="small muted mono">{c.source}</span></td>
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
  if (!seconds) return tNow("None yet", "暂无");
  if (seconds % 3600 === 0) return tNow(`${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`, `${seconds / 3600} 小时`);
  const m = Math.round(seconds / 60);
  return tNow(`${m} minute${m === 1 ? "" : "s"}`, `${m} 分钟`);
}

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function Admin() {
  const t = useT();
  return (
    <>
      <Section title={t("Who controls it today", "目前由谁控制")} id="who-controls-it-today">
      <dl className="kv">
        <div><dt>{t("Current owner of admin functions", "管理功能的当前所有者")}</dt><dd className="addr"><a href={explorerAddress(manifest.admin.owner)} target="_blank" rel="noreferrer">{manifest.admin.owner}</a></dd></div>
        <div><dt>{t("Multisig", "多签")}</dt><dd className="addr">{manifest.admin.safe ? <a href={explorerAddress(manifest.admin.safe)} target="_blank" rel="noreferrer">{manifest.admin.safe}</a> : t("Not deployed", "未部署")}</dd></div>
        <div><dt>{t("Timelock", "时间锁")}</dt><dd className="addr">{manifest.admin.timelock ? <a href={explorerAddress(manifest.admin.timelock)} target="_blank" rel="noreferrer">{manifest.admin.timelock}</a> : t("Not deployed", "未部署")}</dd></div>
        <div><dt>{t("Delay", "延迟")}</dt><dd>{delayLabel(manifest.admin.timelockDelaySeconds)}</dd></div>
      </dl>
      {manifest.admin.timelock && !same(manifest.admin.owner, manifest.admin.timelock) && (
        <p className="small muted">
          {t(
            `The timelock is deployed but does not own the contracts yet${manifest.network === "testnet" ? ": on testnet it is a rehearsal, and the deployer key keeps admin rights so the test setup can move fast" : ""}.`,
            `时间锁已部署，但尚未持有这些合约${manifest.network === "testnet" ? "：在测试网上这只是一次演练，部署者密钥保留管理权限，以便测试环境快速迭代" : ""}。`,
          )}
        </p>
      )}
      </Section>
      <Governance />
      {manifest.network === "testnet" && (
        <Section title={t("The mainnet plan", "主网计划")} id="the-mainnet-plan">
          <Callout kind="warn">
            {t(
              "On testnet, admin functions are held by a single deployer key. On mainnet every contract is owned by a 72-hour timelock (it refuses a shorter delay), and the timelock is controlled by a publicly identified 3-of-3 multisig, which can also pause new risk at once. That is a plan until it appears above.",
              "在测试网上，管理功能由单个部署者密钥持有。在主网上，每个合约都由一个 72 小时时间锁持有（它拒绝更短的延迟），时间锁由一个公开身份的 3/3 多签控制，多签也可以立即暂停新增风险。在它出现在上方之前，这仍只是计划。",
            )}
          </Callout>
        </Section>
      )}
    </>
  );
}

function Assets() {
  const t = useT();
  return (
    <Section title={t("Assets on this network", "本网络上的资产")} id="assets-on-this-network">
      <p className="dk-p">{t("Pools accept only these assets. The Vault accepts the ones open for shielding on its page.", "资金池只接受这些资产。金库接受其页面上开放存入隐私的资产。")}</p>
      <div className="table-scroll" tabIndex={0}>
        <table className="data">
          <thead><tr><th>{t("Token", "代币")}</th><th>{t("Name", "名称")}</th><th>{t("Address", "地址")}</th><th>{t("Decimals", "小数位")}</th></tr></thead>
          <tbody>
            {manifest.assets.map((a) => (
              <tr key={a.address}>
                <td><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><TokenDisc token={a} size={20} />{a.symbol}</span></td>
                <td>{a.testOnly ? t(`${a.name ?? a.label} (test token, no value)`, `${a.name ?? a.label}（测试代币，无价值）`) : a.name ?? a.label}</td>
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
const STATE_ZH: Record<QueueItem["state"], string> = { pending: "等待延迟期结束", ready: "现在可以执行", executed: "已执行", cancelled: "已取消" };
const TREASURY_LABEL: Record<string, string> = {
  TreasuryMarkets: "Markets",
  TreasuryLaunch: "Launches",
  TreasuryVault: "Vault",
  TreasuryPerps: "Perps",
  TreasuryFactory: "Launchpads",
};
const TREASURY_LABEL_ZH: Record<string, string> = {
  TreasuryMarkets: "市场",
  TreasuryLaunch: "代币发行",
  TreasuryVault: "金库",
  TreasuryPerps: "永续合约",
  TreasuryFactory: "发射台",
};

/** The timelock queue, treasuries and buybacks, from the API (events) and the chain (balances). */
function Governance() {
  const tr = useT();
  const tl = (name: string) => tr(TREASURY_LABEL[name], TREASURY_LABEL_ZH[name]) ?? name;
  const q = useQuery({ queryKey: ["governance"], queryFn: () => getJson<Governance>("/v1/governance"), refetchInterval: 30_000, retry: 2 });
  const queueTitle = tr("Admin queue", "管理队列");
  if (q.isError) return <Section title={queueTitle} id="admin-queue"><p className="dk-p muted">{tr("The admin queue could not be loaded. Try again in a moment.", "无法加载管理队列，请稍后再试。")}</p></Section>;
  if (!q.data) return <Section title={queueTitle} id="admin-queue"><p className="dk-p muted">{tr("Loading…", "加载中…")}</p></Section>;
  const g = q.data;
  const open = g.queue.filter((o) => o.state === "pending" || o.state === "ready");
  return (
    <>
      <Section title={queueTitle} id="admin-queue">
        <p className="dk-p">
          {tr(
            `Every admin change waits in the timelock for ${delayLabel(manifest.admin.timelockDelaySeconds).toLowerCase()} before it can run, and appears here the moment it is scheduled. ${open.length ? `${open.length} waiting now.` : "Nothing is waiting now."}`,
            `每项管理变更都要在时间锁中等待 ${delayLabel(manifest.admin.timelockDelaySeconds)} 才能执行，并在被安排的那一刻出现在这里。${open.length ? `目前有 ${open.length} 项在等待。` : "目前没有等待中的变更。"}`,
          )}
        </p>
        {g.queue.length > 0 && (
          <div className="table-scroll" tabIndex={0}>
            <table className="data">
              <thead><tr><th>{tr("Scheduled", "安排时间")}</th><th>{tr("Calls", "调用")}</th><th>{tr("State", "状态")}</th><th>{tr("Transaction", "交易")}</th></tr></thead>
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
                      {tr(STATE[o.state], STATE_ZH[o.state])}
                      {o.state === "pending" && <div className="small muted">{tr("from", "起始于")} {new Date(o.readyAt * 1000).toLocaleString()}</div>}
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
      <Section title={tr("Treasuries", "金库资金")} id="treasuries">
        <p className="dk-p">{tr("Protocol fees collect in one treasury per module. Only the timelock can release them, and only the Safe can use the timelock, so every release needs a Safe vote and is scheduled publicly first.", "协议手续费按模块分别归集到各自的资金库。只有时间锁可以释放它们，而只有 Safe 多签可以使用时间锁，因此每次释放都需要 Safe 投票，并且会先公开安排。")}</p>
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead><tr><th>{tr("Treasury", "资金库")}</th><th>{tr("Address", "地址")}</th>{manifest.assets.map((a) => <th key={a.address}>{a.symbol}</th>)}</tr></thead>
            <tbody>
              {g.treasuries.map((t) => (
                <tr key={t.address}>
                  <td>{tl(t.name)}</td>
                  <td className="addr"><a href={explorerAddress(t.address)} target="_blank" rel="noreferrer">{shortAddress(t.address)}</a></td>
                  {manifest.assets.map((a) => <td key={a.address} className="mono">{t.balances[a.symbol] === null || t.balances[a.symbol] === undefined ? "–" : fmtAmount(t.balances[a.symbol]!, a.decimals)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {g.releases.length > 0 && (
          <>
            <p className="dk-p">{tr("Recent releases", "最近的释放")}</p>
            <ul className="small">
              {g.releases.map((r) => {
                const a = assetBy(r.token);
                return (
                  <li key={r.txHash + r.memo}>
                    {timeAgo(r.timestamp)}: {a ? `${fmtAmount(r.amount, a.decimals)} ${a.symbol}` : r.amount} {tr("from", "从")} {tl(r.contract)} {tr("to", "到")} <span className="mono">{shortAddress(r.to)}</span>
                    {r.memo ? ` (${r.memo})` : ""}. <a href={explorerTx(r.txHash)} target="_blank" rel="noreferrer">{tr("Transaction", "交易")}</a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>
      {g.buyback && (
        <Section title={tr("Buybacks", "回购")} id="buybacks">
          <dl className="kv">
            <div><dt>{tr("Buyback contract", "回购合约")}</dt><dd className="addr"><a href={explorerAddress(g.buyback.address)} target="_blank" rel="noreferrer">{g.buyback.address}</a></dd></div>
            <div><dt>{tr("USDG waiting to buy back", "待回购的 USDG")}</dt><dd className="mono">{g.buyback.usdg === null ? "–" : fmtAmount(g.buyback.usdg, assetBy("USDG")?.decimals ?? manifest.assets.find((a) => a.label === "USDG")?.decimals ?? 6)}</dd></div>
            <div><dt>{tr("$CURVEIL burned so far", "已销毁的 $CURVEIL")}</dt><dd className="mono">{g.buyback.burnedSupply === null ? "–" : fmtAmount(g.buyback.burnedSupply, 18, 0)}</dd></div>
          </dl>
          {g.buyback.recent.length === 0 ? (
            <p className="small muted">{tr("No buybacks yet. Each one buys $CURVEIL in its pool, burns it, and shows here with its price impact.", "暂无回购。每次回购都会在资金池中买入 $CURVEIL 并销毁，并在这里显示其价格影响。")}</p>
          ) : (
            <ul className="small">
              {g.buyback.recent.map((b) => (
                <li key={b.txHash}>
                  {timeAgo(b.timestamp)}:{" "}
                  {b.kind === "Burned" ? tr(`${fmtAmount(b.usdgIn ?? "0", 6)} USDG bought and burned ${fmtAmount(b.tokensBurned ?? "0", 18, 0)} $CURVEIL`, `用 ${fmtAmount(b.usdgIn ?? "0", 6)} USDG 买入并销毁了 ${fmtAmount(b.tokensBurned ?? "0", 18, 0)} $CURVEIL`) : tr(`${fmtAmount(b.amount ?? "0", 6)} USDG returned${b.memo ? ` (${b.memo})` : ""}`, `退回 ${fmtAmount(b.amount ?? "0", 6)} USDG${b.memo ? `（${b.memo}）` : ""}`)}.{" "}
                  <a href={explorerTx(b.txHash)} target="_blank" rel="noreferrer">{tr("Transaction", "交易")}</a>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}
