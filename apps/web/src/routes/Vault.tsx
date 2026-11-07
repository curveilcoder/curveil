/**
 * Vault: a private account generated on this device, holding shielded notes.
 * Shield (public deposit), send privately, withdraw to a public address.
 */
import { useEffect, useMemo, useState } from "react";
import { Loading, Sk, SkNotice, SkRows } from "../components/Skeleton";
import { SubTabs } from "../components/SubTabs";
import { useConnection } from "wagmi";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { PageHead } from "../components/PageHead";
import { commitment, decodeAddress, isShieldedAddress, planShield, protocolWithdrawFee, shareResource, type Recipient } from "@curveil/vault-core";
import { formatUnits, getAddress, isAddress, type Abi, type Address } from "viem";
import shieldedPoolAbiJson from "@curveil/manifest/abis/ShieldedPool.json";
import { ModuleStatus } from "../components/ModuleStatus";
import { TxStatus } from "../components/TxStatus";
import { Exposure, ModePicker, StageView, VaultSubmit, senderExposure, useBroadcaster, useMode, useVaultAction } from "../components/VaultAction";
import { ShieldedPositions, unitsPct } from "../components/ShieldedPositions";
import { AmountField, WalletAction } from "../components/WalletAction";
import { erc20Abi } from "../lib/abis";
import { IS_TESTNET, SHIELDED_POOL, explorerTx, shortAddress } from "../lib/config";
import { fmtAmount, fmtBps, parseAmount, timeAgo } from "../lib/format";
import { GAS_RESERVE, NATIVE, WETH, same, useWalletTokens, wrapStep } from "../lib/tokens";
import { useTxRunner } from "../lib/tx";
import { combineCandidates, feeFor, prepareTransfer, prepareWithdraw, readyTransfer, readyWithdraw } from "../lib/vault/actions";
import { ownedPositions, positionLabel, usePositionList } from "../lib/vault/positions";
import { PERPS_ADAPTER, claimResources, usePerpClaims } from "../lib/perps";
import {
  addPending,
  backupFile,
  balances,
  dismissPending,
  init,
  lock,
  reveal,
  sync,
  useVault,
  vaultKeys,
  type PendingAction,
  type VaultState,
  type VaultStatus,
} from "../lib/vault/store";
import { CreateVault, RecoverVault, UnlockVault } from "./VaultSetup";
import { useT } from "../lib/i18n";

const poolAbi = shieldedPoolAbiJson as Abi;
type Asset = VaultStatus["assets"][number];

export type VaultSub = "overview" | "shield" | "send" | "withdraw" | "notes" | "backup";
export const VAULT_SUBS: VaultSub[] = ["overview", "shield", "send", "withdraw", "notes", "backup"];

/** /vault: its own page, because the vault needs no wallet. */
export function VaultPage() {
  const t = useT();
  const { sub } = useSearch({ from: "/app/vault" });
  const navigate = useNavigate();
  return (
    <div className="wrap">
      <PageHead kicker={t("Private", "隐私")} label={t("Shielded", "隐私")} title={t("Vault", "金库")} art="shield" lead={t("A private account kept in this browser. Shield funds, send them privately, and trade without linking them to your wallet.", "保存在本浏览器中的隐私账户。存入资金、私下转账，并在不关联钱包的情况下交易。")} />
      <VaultPanel sub={sub ?? "overview"} onSub={(v) => void navigate({ to: "/app/vault", search: { sub: v }, replace: true, resetScroll: false })} />
    </div>
  );
}

/** The vault: set up, unlock, or the account with its own sub-tabs. */
export function VaultPanel({ sub, onSub }: { sub: VaultSub; onSub: (s: VaultSub) => void }) {
  const t = useT();
  const v = useVault();
  const [flow, setFlow] = useState<"none" | "create" | "recover">("none");
  useEffect(() => {
    void init();
  }, []);

  return (
    <div className="stack">
      <p className="pf-private">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
        <span>{t("Only you see this. Your vault is a private account kept in this browser. It is not linked to your wallet address on-chain: deposits and withdrawals are public, but who owns which note, and private transfers, are not.", "只有你能看到这里。你的金库是保存在本浏览器中的隐私账户，在链上不与你的钱包地址关联：存入和提取是公开的，但谁拥有哪张票据以及私下转账都不公开。")}</span>
      </p>
      <ModuleStatus id="vault" />
      {!SHIELDED_POOL ? (
        <p className="notice warn">{t("The vault is not deployed on this network yet.", "该网络上尚未部署金库。")}</p>
      ) : v.phase === "loading" ? (
        <SkNotice label={t("Loading your vault", "正在加载你的金库")} />
      ) : v.phase === "unavailable" ? (
        <p className="notice bad" role="alert">{v.error ?? t("This browser cannot store a vault account (private browsing can block it).", "此浏览器无法保存金库账户（无痕浏览可能会阻止）。")}</p>
      ) : v.phase === "none" ? (
        flow === "create" ? (
          <CreateVault onCancel={() => setFlow("none")} />
        ) : flow === "recover" ? (
          <RecoverVault onCancel={() => setFlow("none")} />
        ) : (
          <Intro onCreate={() => setFlow("create")} onRecover={() => setFlow("recover")} />
        )
      ) : v.phase === "locked" ? (
        <UnlockVault />
      ) : (
        <Account v={v} sub={sub} onSub={onSub} />
      )}
      <SetupNote status={v.status} />
    </div>
  );
}

function Intro({ onCreate, onRecover }: { onCreate: () => void; onRecover: () => void }) {
  const t = useT();
  return (
    <div className="grid-2">
      <section className="panel stack">
        <h2 style={{ margin: 0 }}>{t("New vault account", "新建金库账户")}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {t(`Keys are created in this browser and never leave it in plain form. You confirm a 24-word recovery phrase before you can deposit. Your wallet does not control or recover this
          account.`, "密钥在本浏览器中生成，绝不会以明文形式离开。存入资金前你需要确认 24 个单词的恢复短语。你的钱包无法控制或恢复这个账户。")}
        </p>
        <button className="btn btn-primary" onClick={onCreate}>{t("Create account", "创建账户")}</button>
      </section>
      <section className="panel stack">
        <h2 style={{ margin: 0 }}>{t("Already have one?", "已经有账户了？")}</h2>
        <p className="muted" style={{ margin: 0 }}>{t("Recover from your recovery phrase or an encrypted backup file. Your notes are found again by scanning public encrypted events.", "用恢复短语或加密备份文件恢复。系统会扫描公开的加密事件，重新找回你的票据。")}</p>
        <button className="btn" onClick={onRecover}>{t("Recover account", "恢复账户")}</button>
      </section>
    </div>
  );
}

function SetupNote({ status }: { status: VaultStatus | null }) {
  const t = useT();
  return (
    <details className="panel">
      <summary><strong>{t("How this works, and what it does not hide", "工作原理，以及它不会隐藏什么")}</strong></summary>
      <div className="stack small" style={{ marginTop: 12 }}>
        <p style={{ margin: 0 }}>
          {t(`Each note is a Poseidon commitment in an on-chain Merkle tree. Spending one publishes a nullifier that marks it used, without saying which note it was. Proofs are Groth16 over
          BN254 and are generated in a worker in this tab.`, "每张票据都是链上 Merkle 树中的一个 Poseidon 承诺。花费票据时会公开一个作废标记（nullifier）来标明它已使用，但不会透露是哪张票据。证明采用基于 BN254 的 Groth16，在本标签页的后台线程中生成。")}
        </p>
        <p style={{ margin: 0 }}>
          {t(`Public: every deposit (address, asset, amount, time), every withdrawal (recipient, asset, amount, time), and that a transfer happened. When a broadcaster submits for you, its fee
          and fee asset are public too, and the broadcaster sees your network address and timing. Submitting yourself shows your wallet address as the sender.`, "公开的内容：每笔存入（地址、资产、数量、时间）、每笔提取（接收地址、资产、数量、时间），以及发生过一笔转账。由广播者代为提交时，其手续费和手续费资产也是公开的，而且广播者能看到你的网络地址和时间。自己提交则会把你的钱包地址显示为发送方。")}
        </p>
        <p style={{ margin: 0 }}>
          {t(`Shielded swaps and liquidity (choose Shielded on the Swap page or on a pool's Add liquidity page) are public market actions paid from your notes: the market, the amounts and any public
          payout are visible; which account acted, and who holds the resulting notes or position shares, are not.`, "隐私兑换和隐私流动性（在兑换页或资金池的添加流动性页选择“隐私”）是用你的票据付款的公开市场操作：市场、数量和任何公开支付都可见；但哪个账户在操作、谁持有由此产生的票据或仓位份额都不可见。")}
        </p>
        <p style={{ margin: 0 }}>
          {t(`Alternative client: if this site is down, the open-source vault client in the repository (packages/vault-core) rebuilds your notes from chain events with only your phrase and an
          RPC endpoint, proves locally and submits from any wallet. See docs/vault-alternative-client.md.`, "备用客户端：如果本网站无法访问，代码仓库中的开源金库客户端（packages/vault-core）只需你的恢复短语和一个 RPC 节点，就能从链上事件重建票据、在本地生成证明，并通过任意钱包提交。详见 docs/vault-alternative-client.md。")}
        </p>
        {status && (
          <p className="notice warn" style={{ margin: 0 }}>
            {t(<>{IS_TESTNET ? <>Testnet only: {status.setup}. Circuits and contracts are unaudited.</> : <>Trusted setup: {status.setup}. The circuits and contracts are not independently audited yet, and each deposit is capped, so only use amounts you can afford to lose.</>} Withdrawal fee {fmtBps(status.withdrawFeeBps)}; shielding, private transfers, shielded liquidity and exits to notes carry no platform fee, and shielded swaps pay only the pool fee.</>, <>{IS_TESTNET ? <>仅限测试网：{status.setup}。电路和合约尚未审计。</> : <>可信设置：{status.setup}。电路和合约尚未经过独立审计，且每笔存入都有上限，请只使用你能承受损失的金额。</>}提取手续费 {fmtBps(status.withdrawFeeBps)}；存入隐私、私下转账、隐私流动性以及退出为票据都不收平台费，隐私兑换只支付资金池手续费。</>)}
          </p>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- account

function Account({ v, sub, onSub }: { v: VaultState; sub: VaultSub; onSub: (s: VaultSub) => void }) {
  const t = useT();
  const status = v.status;
  useEffect(() => {
    const id = setInterval(() => void sync("poll"), 15_000);
    return () => clearInterval(id);
  }, []);
  const notes = v.notes.filter((n) => !n.spent && n.amount !== "0").length;
  const tabs = (
    <SubTabs<VaultSub>
      label={t("Vault", "金库")}
      value={sub}
      onChange={onSub}
      items={[["overview", t("Balances", "余额")], ["shield", t("Shield", "存入隐私")], ["send", t("Send privately", "私下转账")], ["withdraw", t("Withdraw", "提取")], ["notes", t("Notes", "票据"), notes], ["backup", t("Backup", "备份")]]}
    />
  );
  if (!status) {
    return (
      <>
        {tabs}
        <AddressCard v={v} />
        <section className="panel stack" aria-busy="true">
          <Loading label={t("Loading vault status", "正在加载金库状态")} />
          <h2 style={{ margin: 0 }}>{t("Shielded balances", "隐私余额")}</h2>
          <div className="table-scroll" tabIndex={0}>
            <table className="data">
              <thead><tr><th scope="col">{t("Asset", "资产")}</th><th scope="col">{t("Spendable", "可用")}</th><th scope="col">{t("Pending", "待确认")}</th><th scope="col">{t("Being spent", "花费中")}</th></tr></thead>
              <tbody><SkRows cols={4} rows={3} /></tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {tabs}
      <PendingList v={v} status={status} />
      {sub === "overview" && (
        <>
          <AddressCard v={v} />
          <Balances v={v} status={status} />
          <PositionsSection v={v} status={status} />
        </>
      )}
      {sub !== "overview" && (
        <div className="panel stack">
          {sub === "shield" && <ShieldForm status={status} />}
          {sub === "send" && <SendForm status={status} />}
          {sub === "withdraw" && <WithdrawForm status={status} />}
          {sub === "notes" && <Notes v={v} status={status} />}
          {sub === "backup" && <Backup v={v} />}
        </div>
      )}
    </>
  );
}

function AddressCard({ v }: { v: VaultState }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel stack" aria-labelledby="addr-title">
      <div className="row-between">
        <h2 id="addr-title" style={{ margin: 0 }}>
          <span className="tag tag-shielded">{t("Shielded", "隐私")}</span> {t("Your vault address", "你的金库地址")}
        </h2>
        <button className="btn btn-sm" onClick={lock}>{t("Lock", "锁定")}</button>
      </div>
      <p className="mono addr-wrap" style={{ margin: 0 }}>{v.address}</p>
      <div className="row-between">
        <p className="small muted" style={{ margin: 0 }}>{t("Share it to receive private transfers. It reveals nothing about your balance or history.", "分享它即可接收私下转账，它不会透露你的余额或历史。")}</p>
        <button
          className="btn btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(v.address ?? "").then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }, () => undefined);
          }}
        >
          {copied ? t("Copied", "已复制") : t("Copy", "复制")}
        </button>
      </div>
    </section>
  );
}

function SyncLine({ v }: { v: VaultState }) {
  const t = useT();
  const s = v.sync;
  if (s.kind === "syncing") return <span>{t(`Scanning public notes: ${s.leaves.toLocaleString()} of ${s.of.toLocaleString()}…`, `正在扫描公开票据：${s.leaves.toLocaleString()} / ${s.of.toLocaleString()}…`)}</span>;
  if (s.kind === "error") return <span className="bad-ink">{t("Sync stopped:", "同步已停止：")} {s.message} <button className="link-btn" onClick={() => void sync("retry")}>{t("Retry", "重试")}</button></span>;
  if (s.kind === "synced")
    return (
      <span>
        {t(`Scanned ${s.leaves.toLocaleString()} notes ${timeAgo(Math.floor(s.at / 1000))}.`, `${timeAgo(Math.floor(s.at / 1000))}扫描了 ${s.leaves.toLocaleString()} 张票据。`)}{" "}
        {s.rootMatches ? t("Tree root matches the contract.", "树根与合约一致。") : t("The indexer is still catching up with the chain; balances may be incomplete.", "索引器仍在追赶链上进度，余额可能不完整。")}{" "}
        <button className="link-btn" onClick={() => void sync("manual")}>{t("Refresh", "刷新")}</button>
      </span>
    );
  return <span>{t("Waiting to scan…", "等待扫描…")}</span>;
}

function Balances({ v, status }: { v: VaultState; status: VaultStatus }) {
  const t = useT();
  const scanning = v.sync.kind !== "synced";
  return (
    <section className="panel stack" aria-labelledby="bal-title">
      <h2 id="bal-title" style={{ margin: 0 }}>{t("Shielded balances", "隐私余额")}</h2>
      <div className="table-scroll" tabIndex={0}>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">{t("Asset", "资产")}</th>
              <th scope="col">{t("Spendable", "可用")}</th>
              <th scope="col">{t("Pending", "待确认")}</th>
              <th scope="col">{t("Being spent", "花费中")}</th>
            </tr>
          </thead>
          <tbody>
            {status.assets.map((a) => {
              const b = balances(a.resource);
              return (
                <tr key={a.address}>
                  <td>{a.symbol}</td>
                  <td className="mono">{scanning && b.spendable === 0n ? <Sk w="9ch" /> : fmtAmount(b.spendable, a.decimals, 6)}</td>
                  <td className="mono">{fmtAmount(b.incoming, a.decimals, 6)}</td>
                  <td className="mono">{fmtAmount(b.spending, a.decimals, 6)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: 0 }} aria-live="polite">
        <SyncLine v={v} />
      </p>
    </section>
  );
}

function PositionsSection({ v, status }: { v: VaultState; status: VaultStatus }) {
  const t = useT();
  if (status.version !== 2) return null;
  return (
    <section aria-labelledby="positions-title">
      <ShieldedPositions
        v={v}
        status={status}
        heading={
          <div className="row-between">
            <h2 id="positions-title" style={{ margin: 0 }}>{t("Shielded liquidity positions", "隐私流动性仓位")}</h2>
            <Link to="/app/pools" className="small">{t("Add liquidity", "添加流动性")}</Link>
          </div>
        }
      />
    </section>
  );
}

function PendingList({ v, status }: { v: VaultState; status: VaultStatus }) {
  const t = useT();
  if (v.pending.length === 0) return null;
  return (
    <section className="panel stack" aria-labelledby="pending-title">
      <h2 id="pending-title" style={{ margin: 0 }}>{t("In progress", "进行中")}</h2>
      <ul className="plain-list">
        {v.pending.map((p) => (
          <li key={p.id} className="row-between">
            <span>
              {p.label} · {p.state === "failed" ? <span className="bad-ink">{t("failed:", "失败：")} {p.error}</span> : p.state === "proving" ? t("proving", "正在生成证明") : t("waiting for the chain", "等待链上确认")}
              {p.txHash && (
                <>
                  {" "}
                  · <a href={explorerTx(p.txHash)} target="_blank" rel="noreferrer">{t("transaction", "交易")}</a>
                </>
              )}
            </span>
            {p.state === "failed" && <button className="btn btn-sm" onClick={() => void dismissPending(status.pool, p.id)}>{t("Dismiss", "关闭")}</button>}
          </li>
        ))}
      </ul>
      <p className="small muted" style={{ margin: 0 }}>{t("Notes used by an action stay reserved until it confirms. A failed or expired action releases them; nothing is lost.", "操作使用的票据在确认前会被保留。操作失败或过期后会释放它们，不会有任何损失。")}</p>
    </section>
  );
}

/** The asset, picked inside the amount box like a swap's token. */
function AssetSelect({ assets, value, onChange, filter }: { assets: Asset[]; value: Address | null; onChange: (a: Address) => void; filter?: (a: Asset) => boolean }) {
  const t = useT();
  const list = assets.filter(filter ?? (() => true));
  return (
    <select className="token-select" aria-label={t("Asset", "资产")} value={value ?? ""} onChange={(e) => onChange(e.target.value as Address)}>
      {list.map((a) => <option key={a.address} value={a.address}>{a.symbol}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- shield

function ShieldForm({ status }: { status: VaultStatus }) {
  const t = useT();
  const enabled = status.assets.filter((a) => a.shieldingEnabled);
  const [token, setToken] = useState<Address | null>(enabled[0]?.address ?? null);
  const [raw, setRaw] = useState("");
  const asset = status.assets.find((a) => a.address === token) ?? null;
  // WETH can be shielded straight from ETH: the site wraps what the wallet's WETH does not cover.
  const ethIn = Boolean(WETH && token && same(token, WETH));
  const wallet = useWalletTokens([token ?? undefined, ethIn ? NATIVE : undefined], status.pool);
  const { balance: tokenBalance, allowance } = wallet.get(token ?? undefined);
  const nativeBalance = ethIn ? wallet.get(NATIVE).balance : undefined;
  const nativeSpendable = nativeBalance !== undefined ? (nativeBalance > GAS_RESERVE ? nativeBalance - GAS_RESERVE : 0n) : undefined;
  const balance = ethIn ? (tokenBalance !== undefined && nativeSpendable !== undefined ? tokenBalance + nativeSpendable : undefined) : tokenBalance;
  const amount = asset ? parseAmount(raw, asset.decimals) : null;
  const tx = useTxRunner();
  const cap = asset && asset.maxDeposit !== "0" ? BigInt(asset.maxDeposit) : null;
  const problem =
    status.shieldPaused ? t("Shielding is paused right now.", "存入隐私目前已暂停。") : !asset ? t("Pick an asset.", "请选择资产。") : amount === null || amount === 0n ? null : balance !== undefined && amount > balance ? t("More than your wallet balance", "超过你的钱包余额") : cap !== null && amount > cap ? t(`Above the per-deposit cap of ${fmtAmount(cap, asset.decimals)} ${asset.symbol}.`, `超过单笔存入上限 ${fmtAmount(cap, asset.decimals)} ${asset.symbol}。`) : null;

  async function go() {
    const keys = vaultKeys();
    if (!keys || !asset || !amount) return;
    const plan = planShield(keys, BigInt(asset.resource), amount);
    const steps = [];
    const held = tokenBalance ?? 0n;
    if (ethIn && amount > held) steps.push(wrapStep(amount - held, t(`Wrap ${fmtAmount(amount - held, 18, 6)} ETH to WETH`, `把 ${fmtAmount(amount - held, 18, 6)} ETH 包装为 WETH`)));
    if ((allowance ?? 0n) < amount) {
      steps.push({ label: t(`Approve ${asset.symbol}`, `授权 ${asset.symbol}`), params: { address: asset.address, abi: erc20Abi, functionName: "approve", args: [status.pool, amount] } as never });
    }
    steps.push({
      label: t(`Shield ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`, `存入隐私 ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`),
      params: { address: status.pool, abi: poolAbi, functionName: "shield", args: [asset.address, amount, plan.ownerHash, plan.encryptedNote] } as never,
    });
    const receipt = await tx.run(steps);
    wallet.refetch();
    if (receipt) {
      setRaw("");
      // Shown as pending until the scan finds the note on-chain.
      await addPending(status.pool, {
        id: receipt.transactionHash,
        kind: "shield",
        label: t(`Shield ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`, `存入隐私 ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`),
        createdAt: Date.now(),
        nullifiers: [],
        incoming: [{ commitment: commitment(plan.note, BigInt(status.noteDomain)).toString(), resource: asset.resource, amount: amount.toString() }],
        txHash: receipt.transactionHash,
        state: "submitted",
      });
      void sync("shield");
    }
  }

  if (enabled.length === 0) return <p className="notice warn">{t("No asset is open for shielding on this network.", "该网络上没有开放存入隐私的资产。")}</p>;
  return (
    <div className="stack">
      <AmountField
        label={t("Amount to shield", "存入数量")}
        value={raw}
        onChange={setRaw}
        symbol={asset?.symbol}
        decimals={asset?.decimals}
        balance={asset && balance !== undefined ? fmtAmount(balance, asset.decimals, 6) : undefined}
        onMax={() => asset && balance !== undefined && setRaw(formatUnits(balance, asset.decimals))}
        error={amount && problem && asset && !status.shieldPaused ? problem : null}
        hint={<>
          {cap !== null && asset ? t(`Up to ${fmtAmount(cap, asset.decimals)} ${asset.symbol} per deposit. Shielding fee 0%; you pay network gas.`, `每笔最多存入 ${fmtAmount(cap, asset.decimals)} ${asset.symbol}。存入手续费 0%，你只需支付网络 Gas。`) : t("Shielding fee 0%. You pay network gas from your wallet.", "存入手续费 0%。你只需从钱包支付网络 Gas。")}
          {ethIn && t(" Pays from your ETH too: the site wraps it to WETH first and keeps a little ETH back for gas.", "也可以用 ETH 支付：网站会先把它包装为 WETH，并保留少量 ETH 用作 Gas。")}
        </>}
      >
        <AssetSelect assets={status.assets} value={token} onChange={setToken} filter={(a) => a.shieldingEnabled} />
      </AmountField>
      <Exposure
        pub={t(["Your wallet address as the depositor", `The asset and amount${amount && asset ? ` (${fmtAmount(amount, asset.decimals)} ${asset.symbol})` : ""}`, "The time"], ["你的钱包地址（作为存入方）", `资产和数量${amount && asset ? `（${fmtAmount(amount, asset.decimals)} ${asset.symbol}）` : ""}`, "时间"])}
        priv={t(["That the new note belongs to your vault account", "Every later transfer of it", "Which deposit funds a later withdrawal"], ["新票据属于你的金库账户", "它之后的每一次转账", "之后的提取来自哪笔存入"])}
      />
      {(status.shieldPaused || !asset) && problem && <p className="notice warn small" style={{ margin: 0 }}>{problem}</p>}
      <WalletAction verb={t("shield", "存入隐私")}>
        <button className="btn btn-primary btn-block" disabled={tx.busy || !amount || Boolean(problem)} onClick={go}>
          {tx.busy ? t("Waiting for wallet…", "等待钱包确认…") : !amount ? t("Enter an amount", "请输入金额") : asset ? t(`Shield ${asset.symbol}`, `存入隐私 ${asset.symbol}`) : t("Shield", "存入隐私")}
        </button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </div>
  );
}

// ---------------------------------------------------------------- send

/** The first asset with a spendable balance, so the send and withdraw forms open on it. */
const firstHeld = (status: VaultStatus): Address | null =>
  (status.assets.find((a) => a.resource !== "0" && balances(a.resource).spendable > 0n) ?? status.assets.find((a) => a.shieldingEnabled) ?? status.assets[0])?.address ?? null;

function SendForm({ status }: { status: VaultStatus }) {
  const t = useT();
  const [token, setToken] = useState<Address | null>(() => firstHeld(status));
  const [to, setTo] = useState("");
  const [raw, setRaw] = useState("");
  const b = useBroadcaster();
  const asset = status.assets.find((a) => a.address === token) ?? null;
  const [mode, setMode] = useMode(b, feeFor(b.info, "transfer", asset?.address) !== null);
  const amount = asset ? parseAmount(raw, asset.decimals) : null;
  const recipient: Recipient | null = useMemo(() => (isShieldedAddress(to) ? decodeAddress(to) : null), [to]);
  const act = useVaultAction();
  const bal = asset ? balances(asset.resource) : null;
  const fee = mode === "broadcaster" ? (feeFor(b.info, "transfer", asset?.address) ?? 0n) : 0n;
  const toProblem = to && !recipient ? t("That is not a Curveil shielded address. They start with cvl1.", "这不是 Curveil 隐私地址。隐私地址以 cvl1 开头。") : null;
  const amountProblem = amount && bal && amount + fee > bal.spendable ? t("More than your spendable balance, including the fee", "加上手续费后超过你的可用余额") : null;
  const problem = toProblem ?? amountProblem;

  function go() {
    if (!asset || !amount || !recipient) return;
    void act.run({
      status,
      action: "transfer",
      label: t(`Private transfer of ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`, `私下转账 ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`),
      mode,
      feeToken: asset.address,
      prove: async (f, fr, onStage) => {
        const p = await prepareTransfer({ status, token: asset.address, amount, to: recipient, fee: f, feeRecipient: fr, onStage });
        return readyTransfer(p, [{ commitment: p.plan.args.commitments[1].toString(), resource: asset.resource, amount: p.plan.outputs[1].amount.toString() }]);
      },
    }).then((ok) => ok && setRaw(""));
  }

  const self = vaultKeys() && recipient && recipient.ownerKey === vaultKeys()!.ownerKey;
  return (
    <div className="stack">
      <label className="field">
        <span className="field-label">{t("Recipient's shielded address", "收款方的隐私地址")}</span>
        <input className="text-input mono" placeholder="cvl1…" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} aria-invalid={Boolean(toProblem) || undefined} />
        {toProblem ? <span className="field-error">{toProblem}</span> : self ? <span className="field-hint">{t("This is your own address: the transfer combines or splits your notes.", "这是你自己的地址：这笔转账会合并或拆分你的票据。")}</span> : <span className="field-hint">{t("Ask the recipient for the cvl1 address shown under Vault in their profile.", "请向收款方索要其金库中显示的 cvl1 地址。")}</span>}
      </label>
      <AmountField label={t("Amount", "数量")} value={raw} onChange={setRaw} symbol={asset?.symbol} decimals={asset?.decimals} balanceLabel={t("Spendable", "可用")} balance={asset && bal ? fmtAmount(bal.spendable, asset.decimals, 6) : undefined} onMax={() => asset && bal && setRaw(fmtAmount(bal.spendable - fee > 0n ? bal.spendable - fee : 0n, asset.decimals, asset.decimals).replace(/,/g, ""))} error={amountProblem}>
        <AssetSelect assets={status.assets} value={token} onChange={setToken} />
      </AmountField>
      <ModePicker mode={mode} onMode={setMode} b={b} action="transfer" feeToken={asset} />
      <Exposure
        pub={[t("That a private transfer happened, and when", "发生过一笔私下转账，以及时间"), ...senderExposure(mode)]}
        priv={t(["The amount", "The recipient", "Which of your notes were spent"], ["数量", "收款方", "花费了你的哪些票据"])}
      />
      {asset && (
        <dl className="rows summary">
          <div><dt>{t("Platform fee", "平台费")}</dt><dd className="mono">0%</dd></div>
          <div><dt>{t("Broadcaster fee", "广播者手续费")}</dt><dd className="mono">{mode === "broadcaster" ? `${fmtAmount(fee, asset.decimals, 6)} ${asset.symbol}` : t("None, you submit from your wallet", "无，由你从钱包提交")}</dd></div>
          {amount ? <div><dt>{t("Leaves your notes", "从你的票据中扣除")}</dt><dd className="mono">{fmtAmount(amount + fee, asset.decimals, 6)} {asset.symbol}</dd></div> : null}
        </dl>
      )}
      <VaultSubmit mode={mode} act={act} disabled={!amount || !recipient || Boolean(problem)} onClick={go}>{t("Prove and send", "生成证明并发送")}</VaultSubmit>
    </div>
  );
}

// ---------------------------------------------------------------- withdraw

function WithdrawForm({ status }: { status: VaultStatus }) {
  const t = useT();
  const { address: wallet } = useConnection();
  const [token, setToken] = useState<Address | null>(() => firstHeld(status));
  const [to, setTo] = useState("");
  const [raw, setRaw] = useState("");
  const b = useBroadcaster();
  const act = useVaultAction();
  useEffect(() => {
    if (!to && wallet) setTo(wallet);
  }, [wallet, to]);
  const asset = status.assets.find((a) => a.address === token) ?? null;
  const [mode, setMode] = useMode(b, feeFor(b.info, "withdraw", asset?.address) !== null);
  const amount = asset ? parseAmount(raw, asset.decimals) : null;
  const bal = asset ? balances(asset.resource) : null;
  const fee = mode === "broadcaster" ? (feeFor(b.info, "withdraw", asset?.address) ?? 0n) : 0n;
  const protocolFee = amount ? protocolWithdrawFee(amount, status.withdrawFeeBps) : 0n;
  const recipient = isAddress(to) ? getAddress(to) : null;
  const toProblem = !to || recipient
    ? null
    : isAddress(to, { strict: false })
      ? t("This address's capital letters do not match its checksum, so it may have been mistyped. Copy it again from the source.", "该地址的大小写与校验和不符，可能输错了。请从来源重新复制。")
      : t("Enter a valid public address (0x…).", "请输入有效的公开地址（0x…）。");
  const amountProblem = amount && bal && amount + fee > bal.spendable ? t("More than your spendable balance, including the fee", "加上手续费后超过你的可用余额") : null;
  const problem = toProblem ?? amountProblem;

  function go() {
    if (!asset || !amount || !recipient) return;
    void act.run({
      status,
      action: "withdraw",
      label: t(`Withdraw ${fmtAmount(amount, asset.decimals)} ${asset.symbol} to ${shortAddress(recipient)}`, `提取 ${fmtAmount(amount, asset.decimals)} ${asset.symbol} 到 ${shortAddress(recipient)}`),
      mode,
      feeToken: asset.address,
      prove: async (f, fr, onStage) => {
        const p = await prepareWithdraw({ status, token: asset.address, amount, recipient, fee: f, feeRecipient: fr, onStage });
        return readyWithdraw(p, [{ commitment: p.plan.args.commitment.toString(), resource: asset.resource, amount: p.plan.change.amount.toString() }]);
      },
    }).then((ok) => ok && setRaw(""));
  }

  return (
    <div className="stack">
      <AmountField
        label={t("Amount to withdraw", "提取数量")}
        value={raw}
        onChange={setRaw}
        symbol={asset?.symbol}
        decimals={asset?.decimals}
        balanceLabel={t("Spendable", "可用")}
        balance={asset && bal ? fmtAmount(bal.spendable, asset.decimals, 6) : undefined}
        onMax={() => asset && bal && setRaw(fmtAmount(bal.spendable - fee > 0n ? bal.spendable - fee : 0n, asset.decimals, asset.decimals).replace(/,/g, ""))}
        error={amountProblem}
      >
        <AssetSelect assets={status.assets} value={token} onChange={setToken} />
      </AmountField>
      <label className="field">
        <span className="field-top">
          <span className="field-label">{t("Public recipient address", "公开接收地址")}</span>
          {wallet && to.toLowerCase() !== wallet.toLowerCase() && <button type="button" className="tbox-max" onClick={(e) => { e.preventDefault(); setTo(wallet); }}>{t("Use my wallet", "使用我的钱包")}</button>}
        </span>
        <input className="text-input mono" placeholder="0x…" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} aria-invalid={Boolean(toProblem) || undefined} />
        {toProblem ? <span className="field-error">{toProblem}</span> : <span className="field-hint">{t("Withdrawals are public: this address and the amount are visible on-chain.", "提取是公开的：该地址和数量在链上可见。")}</span>}
      </label>
      <ModePicker mode={mode} onMode={setMode} b={b} action="withdraw" feeToken={asset} />
      {asset && amount ? (
        <dl className="rows summary">
          <div><dt>{t("Withdrawal fee", "提取手续费")} ({fmtBps(status.withdrawFeeBps)})</dt><dd className="mono">{fmtAmount(protocolFee, asset.decimals, 6)} {asset.symbol}</dd></div>
          <div><dt>{t("Broadcaster fee, from notes", "广播者手续费（从票据扣除）")}</dt><dd className="mono">{fmtAmount(fee, asset.decimals, 6)} {asset.symbol}</dd></div>
          <div><dt>{t("Leaves your notes", "从你的票据中扣除")}</dt><dd className="mono">{fmtAmount(amount + fee, asset.decimals, 6)} {asset.symbol}</dd></div>
          <div><dt><strong style={{ color: "var(--ink)" }}>{t("Recipient receives", "接收方到账")}</strong></dt><dd className="mono" style={{ color: "#fff" }}>{fmtAmount(amount - protocolFee, asset.decimals, 6)} {asset.symbol}</dd></div>
        </dl>
      ) : null}
      <Exposure
        pub={[...t(["The recipient address", "The asset and amount", "The time"], ["接收地址", "资产和数量", "时间"]), ...senderExposure(mode)]}
        priv={t(["Which deposit or transfer funded it", "Your remaining shielded balance"], ["资金来自哪笔存入或转账", "你剩余的隐私余额"])}
      />
      <VaultSubmit mode={mode} act={act} disabled={!amount || !recipient || Boolean(problem)} onClick={go}>{t("Prove and withdraw", "生成证明并提取")}</VaultSubmit>
    </div>
  );
}

// ---------------------------------------------------------------- notes

function Notes({ v, status }: { v: VaultState; status: VaultStatus }) {
  const t = useT();
  const act = useVaultAction();
  const b = useBroadcaster();
  const live = v.notes.filter((n) => !n.spent && n.amount !== "0");
  const reserved = new Set(v.pending.filter((p: PendingAction) => p.state !== "failed").flatMap((p) => p.nullifiers));
  const assetOf = (resource: string) => status.assets.find((a) => a.resource === resource);
  const positions = usePositionList(status.version === 2);
  const shares = useMemo(() => new Map(ownedPositions(positions.data, v.notes, status).owned.map((p) => [p.resource, p])), [positions.data, v.notes, status]);
  const claims = usePerpClaims(status.version === 2);
  const claimRes = useMemo(() => claimResources(claims.data, PERPS_ADAPTER, shareResource), [claims.data]);

  function combine(a: Asset) {
    const pair = combineCandidates(a.resource);
    const keys = vaultKeys();
    if (!pair || !keys) return;
    const fee = b.info?.healthy ? (feeFor(b.info, "transfer", a.address) ?? 0n) : 0n;
    const total = pair[0]!.amountBig + pair[1]!.amountBig;
    void act.run({
      status,
      action: "transfer",
      label: t(`Combine two ${a.symbol} notes`, `合并两张 ${a.symbol} 票据`),
      mode: fee > 0n && fee < total ? "broadcaster" : "self",
      feeToken: a.address,
      prove: async (f, fr, onStage) => {
        const p = await prepareTransfer({ status, token: a.address, amount: total - f, to: keys, fee: f, feeRecipient: fr, onStage });
        return readyTransfer(p, [{ commitment: p.plan.args.commitments[0].toString(), resource: a.resource, amount: p.plan.outputs[0].amount.toString() }]);
      },
    });
  }

  return (
    <div className="stack">
      {live.length === 0 ? (
        <p className="muted">{t("No unspent notes yet. Shield an asset or ask someone to send to your vault address.", "还没有未花费的票据。存入一种资产，或请别人转账到你的金库地址。")}</p>
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead>
              <tr><th scope="col">{t("Note", "票据")}</th><th scope="col">{t("Asset", "资产")}</th><th scope="col">{t("Amount", "数量")}</th><th scope="col">{t("State", "状态")}</th></tr>
            </thead>
            <tbody>
              {live.map((n) => {
                const a = assetOf(n.resource);
                const share = a ? null : shares.get(n.resource);
                const claim = a || share ? null : claimRes.get(n.resource);
                return (
                  <tr key={n.leafIndex}>
                    <td className="mono">#{n.leafIndex}</td>
                    <td>
                      {a?.symbol ??
                        (share ? t(`Shares of ${positionLabel(share)}`, `${positionLabel(share)} 的份额`) : claim ? t(<>Perps claim on <Link to="/app/perps">position #{claim.positionId}</Link></>, <><Link to="/app/perps">仓位 #{claim.positionId}</Link> 的永续合约领取凭证</>) : t("Liquidity shares or a perps claim (waiting for the index)", "流动性份额或永续合约领取凭证（等待索引）"))}
                    </td>
                    <td className="mono">{a ? fmtAmount(n.amount, a.decimals, 6) : share ? t(`${unitsPct(BigInt(n.amount), BigInt(share.remainingUnits))}% of it`, `其中的 ${unitsPct(BigInt(n.amount), BigInt(share.remainingUnits))}%`) : claim ? t("1 claim", "1 份凭证") : n.amount}</td>
                    <td>{reserved.has(n.nullifier) ? t("Being spent", "花费中") : t("Spendable", "可用")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        {t("Each action spends at most two notes. If an amount needs more, combine notes first; this is a private transfer to yourself.", "每次操作最多花费两张票据。如果金额需要更多票据，请先合并票据，这相当于给自己的一笔私下转账。")}
      </p>
      <div className="row-between" style={{ justifyContent: "flex-start" }}>
        {status.assets.map((a) =>
          combineCandidates(a.resource) ? (
            <button key={a.address} className="btn btn-sm" disabled={act.busy} onClick={() => combine(a)}>{t(`Combine two ${a.symbol} notes`, `合并两张 ${a.symbol} 票据`)}</button>
          ) : null,
        )}
      </div>
      <StageView stage={act.stage} />
    </div>
  );
}

// ---------------------------------------------------------------- backup

function Backup({ v }: { v: VaultState }) {
  const t = useT();
  const [pass, setPass] = useState("");
  const [words, setWords] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const blob = await backupFile(pass);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `curveil-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Could not create the backup.", "无法创建备份。"));
    } finally {
      setBusy(false);
    }
  }

  async function show() {
    setBusy(true);
    setError(null);
    try {
      const { entropyToPhrase } = await import("@curveil/vault-core");
      setWords(entropyToPhrase(await reveal(pass)).split(" "));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Wrong passphrase.", "密码错误。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        {t("Your recovery phrase is the master backup. An encrypted backup file is a convenience copy protected by your vault passphrase.", "恢复短语是主备份。加密备份文件是由金库密码保护的便捷副本。")}
        {v.backupFileAt ? t(` Last backup file: ${new Date(v.backupFileAt).toLocaleString()}.`, `上次备份文件：${new Date(v.backupFileAt).toLocaleString()}。`) : t(" No backup file downloaded yet.", "还没有下载过备份文件。")}
      </p>
      <label className="field">
        <span className="small muted">{t("Vault passphrase", "金库密码")}</span>
        <input className="text-input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <div className="row-between" style={{ justifyContent: "flex-start" }}>
        <button className="btn" disabled={!pass || busy} onClick={download}>{t("Download encrypted backup file", "下载加密备份文件")}</button>
        <button className="btn" disabled={!pass || busy} onClick={show}>{t("Show recovery phrase", "显示恢复短语")}</button>
      </div>
      {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      {words && (
        <>
          <ol className="phrase-grid mono" aria-label={t("Recovery phrase", "恢复短语")}>
            {words.map((w, i) => (<li key={i}><span className="muted">{i + 1}</span> {w}</li>))}
          </ol>
          <button className="btn btn-sm" onClick={() => setWords(null)}>{t("Hide", "隐藏")}</button>
        </>
      )}
    </div>
  );
}

