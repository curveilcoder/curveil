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

const poolAbi = shieldedPoolAbiJson as Abi;
type Asset = VaultStatus["assets"][number];

export type VaultSub = "overview" | "shield" | "send" | "withdraw" | "notes" | "backup";
export const VAULT_SUBS: VaultSub[] = ["overview", "shield", "send", "withdraw", "notes", "backup"];

/** /vault: its own page, because the vault needs no wallet. */
export function VaultPage() {
  const { sub } = useSearch({ from: "/app/vault" });
  const navigate = useNavigate();
  return (
    <div className="wrap">
      <PageHead kicker="Private" label="Shielded" title="Vault" art="shield" lead="A private account kept in this browser. Shield funds, send them privately, and trade without linking them to your wallet." />
      <VaultPanel sub={sub ?? "overview"} onSub={(v) => void navigate({ to: "/app/vault", search: { sub: v }, replace: true, resetScroll: false })} />
    </div>
  );
}

/** The vault: set up, unlock, or the account with its own sub-tabs. */
export function VaultPanel({ sub, onSub }: { sub: VaultSub; onSub: (s: VaultSub) => void }) {
  const v = useVault();
  const [flow, setFlow] = useState<"none" | "create" | "recover">("none");
  useEffect(() => {
    void init();
  }, []);

  return (
    <div className="stack">
      <p className="pf-private">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
        <span>Only you see this. Your vault is a private account kept in this browser. It is not linked to your wallet address on-chain: deposits and withdrawals are public, but who owns which note, and private transfers, are not.</span>
      </p>
      <ModuleStatus id="vault" />
      {!SHIELDED_POOL ? (
        <p className="notice warn">The vault is not deployed on this network yet.</p>
      ) : v.phase === "loading" ? (
        <SkNotice label="Loading your vault" />
      ) : v.phase === "unavailable" ? (
        <p className="notice bad" role="alert">{v.error ?? "This browser cannot store a vault account (private browsing can block it)."}</p>
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
  return (
    <div className="grid-2">
      <section className="panel stack">
        <h2 style={{ margin: 0 }}>New vault account</h2>
        <p className="muted" style={{ margin: 0 }}>
          Keys are created in this browser and never leave it in plain form. You confirm a 24-word recovery phrase before you can deposit. Your wallet does not control or recover this
          account.
        </p>
        <button className="btn btn-primary" onClick={onCreate}>Create account</button>
      </section>
      <section className="panel stack">
        <h2 style={{ margin: 0 }}>Already have one?</h2>
        <p className="muted" style={{ margin: 0 }}>Recover from your recovery phrase or an encrypted backup file. Your notes are found again by scanning public encrypted events.</p>
        <button className="btn" onClick={onRecover}>Recover account</button>
      </section>
    </div>
  );
}

function SetupNote({ status }: { status: VaultStatus | null }) {
  return (
    <details className="panel">
      <summary><strong>How this works, and what it does not hide</strong></summary>
      <div className="stack small" style={{ marginTop: 12 }}>
        <p style={{ margin: 0 }}>
          Each note is a Poseidon commitment in an on-chain Merkle tree. Spending one publishes a nullifier that marks it used, without saying which note it was. Proofs are Groth16 over
          BN254 and are generated in a worker in this tab.
        </p>
        <p style={{ margin: 0 }}>
          Public: every deposit (address, asset, amount, time), every withdrawal (recipient, asset, amount, time), and that a transfer happened. When a broadcaster submits for you, its fee
          and fee asset are public too, and the broadcaster sees your network address and timing. Submitting yourself shows your wallet address as the sender.
        </p>
        <p style={{ margin: 0 }}>
          Shielded swaps and liquidity (choose Shielded on the Swap page or on a pool's Add liquidity page) are public market actions paid from your notes: the market, the amounts and any public
          payout are visible; which account acted, and who holds the resulting notes or position shares, are not.
        </p>
        <p style={{ margin: 0 }}>
          Alternative client: if this site is down, the open-source vault client in the repository (packages/vault-core) rebuilds your notes from chain events with only your phrase and an
          RPC endpoint, proves locally and submits from any wallet. See docs/vault-alternative-client.md.
        </p>
        {status && (
          <p className="notice warn" style={{ margin: 0 }}>
            {IS_TESTNET ? <>Testnet only: {status.setup}. Circuits and contracts are unaudited.</> : <>Trusted setup: {status.setup}. The circuits and contracts are not independently audited yet, and each deposit is capped, so only use amounts you can afford to lose.</>} Withdrawal fee {fmtBps(status.withdrawFeeBps)}; shielding, private transfers, shielded liquidity and exits to notes carry no platform fee, and shielded swaps pay only the pool fee.
          </p>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- account

function Account({ v, sub, onSub }: { v: VaultState; sub: VaultSub; onSub: (s: VaultSub) => void }) {
  const status = v.status;
  useEffect(() => {
    const t = setInterval(() => void sync("poll"), 15_000);
    return () => clearInterval(t);
  }, []);
  const notes = v.notes.filter((n) => !n.spent && n.amount !== "0").length;
  const tabs = (
    <SubTabs<VaultSub>
      label="Vault"
      value={sub}
      onChange={onSub}
      items={[["overview", "Balances"], ["shield", "Shield"], ["send", "Send privately"], ["withdraw", "Withdraw"], ["notes", "Notes", notes], ["backup", "Backup"]]}
    />
  );
  if (!status) {
    return (
      <>
        {tabs}
        <AddressCard v={v} />
        <section className="panel stack" aria-busy="true">
          <Loading label="Loading vault status" />
          <h2 style={{ margin: 0 }}>Shielded balances</h2>
          <div className="table-scroll" tabIndex={0}>
            <table className="data">
              <thead><tr><th scope="col">Asset</th><th scope="col">Spendable</th><th scope="col">Pending</th><th scope="col">Being spent</th></tr></thead>
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
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel stack" aria-labelledby="addr-title">
      <div className="row-between">
        <h2 id="addr-title" style={{ margin: 0 }}>
          <span className="tag tag-shielded">Shielded</span> Your vault address
        </h2>
        <button className="btn btn-sm" onClick={lock}>Lock</button>
      </div>
      <p className="mono addr-wrap" style={{ margin: 0 }}>{v.address}</p>
      <div className="row-between">
        <p className="small muted" style={{ margin: 0 }}>Share it to receive private transfers. It reveals nothing about your balance or history.</p>
        <button
          className="btn btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(v.address ?? "").then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }, () => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
}

function SyncLine({ v }: { v: VaultState }) {
  const s = v.sync;
  if (s.kind === "syncing") return <span>Scanning public notes: {s.leaves.toLocaleString()} of {s.of.toLocaleString()}…</span>;
  if (s.kind === "error") return <span className="bad-ink">Sync stopped: {s.message} <button className="link-btn" onClick={() => void sync("retry")}>Retry</button></span>;
  if (s.kind === "synced")
    return (
      <span>
        Scanned {s.leaves.toLocaleString()} notes {timeAgo(Math.floor(s.at / 1000))}.{" "}
        {s.rootMatches ? "Tree root matches the contract." : "The indexer is still catching up with the chain; balances may be incomplete."}{" "}
        <button className="link-btn" onClick={() => void sync("manual")}>Refresh</button>
      </span>
    );
  return <span>Waiting to scan…</span>;
}

function Balances({ v, status }: { v: VaultState; status: VaultStatus }) {
  const scanning = v.sync.kind !== "synced";
  return (
    <section className="panel stack" aria-labelledby="bal-title">
      <h2 id="bal-title" style={{ margin: 0 }}>Shielded balances</h2>
      <div className="table-scroll" tabIndex={0}>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Spendable</th>
              <th scope="col">Pending</th>
              <th scope="col">Being spent</th>
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
  if (status.version !== 2) return null;
  return (
    <section aria-labelledby="positions-title">
      <ShieldedPositions
        v={v}
        status={status}
        heading={
          <div className="row-between">
            <h2 id="positions-title" style={{ margin: 0 }}>Shielded liquidity positions</h2>
            <Link to="/app/pools" className="small">Add liquidity</Link>
          </div>
        }
      />
    </section>
  );
}

function PendingList({ v, status }: { v: VaultState; status: VaultStatus }) {
  if (v.pending.length === 0) return null;
  return (
    <section className="panel stack" aria-labelledby="pending-title">
      <h2 id="pending-title" style={{ margin: 0 }}>In progress</h2>
      <ul className="plain-list">
        {v.pending.map((p) => (
          <li key={p.id} className="row-between">
            <span>
              {p.label} · {p.state === "failed" ? <span className="bad-ink">failed: {p.error}</span> : p.state === "proving" ? "proving" : "waiting for the chain"}
              {p.txHash && (
                <>
                  {" "}
                  · <a href={explorerTx(p.txHash)} target="_blank" rel="noreferrer">transaction</a>
                </>
              )}
            </span>
            {p.state === "failed" && <button className="btn btn-sm" onClick={() => void dismissPending(status.pool, p.id)}>Dismiss</button>}
          </li>
        ))}
      </ul>
      <p className="small muted" style={{ margin: 0 }}>Notes used by an action stay reserved until it confirms. A failed or expired action releases them; nothing is lost.</p>
    </section>
  );
}

/** The asset, picked inside the amount box like a swap's token. */
function AssetSelect({ assets, value, onChange, filter }: { assets: Asset[]; value: Address | null; onChange: (a: Address) => void; filter?: (a: Asset) => boolean }) {
  const list = assets.filter(filter ?? (() => true));
  return (
    <select className="token-select" aria-label="Asset" value={value ?? ""} onChange={(e) => onChange(e.target.value as Address)}>
      {list.map((a) => <option key={a.address} value={a.address}>{a.symbol}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- shield

function ShieldForm({ status }: { status: VaultStatus }) {
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
    status.shieldPaused ? "Shielding is paused right now." : !asset ? "Pick an asset." : amount === null || amount === 0n ? null : balance !== undefined && amount > balance ? "More than your wallet balance" : cap !== null && amount > cap ? `Above the per-deposit cap of ${fmtAmount(cap, asset.decimals)} ${asset.symbol}.` : null;

  async function go() {
    const keys = vaultKeys();
    if (!keys || !asset || !amount) return;
    const plan = planShield(keys, BigInt(asset.resource), amount);
    const steps = [];
    const held = tokenBalance ?? 0n;
    if (ethIn && amount > held) steps.push(wrapStep(amount - held, `Wrap ${fmtAmount(amount - held, 18, 6)} ETH to WETH`));
    if ((allowance ?? 0n) < amount) {
      steps.push({ label: `Approve ${asset.symbol}`, params: { address: asset.address, abi: erc20Abi, functionName: "approve", args: [status.pool, amount] } as never });
    }
    steps.push({
      label: `Shield ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`,
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
        label: `Shield ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`,
        createdAt: Date.now(),
        nullifiers: [],
        incoming: [{ commitment: commitment(plan.note, BigInt(status.noteDomain)).toString(), resource: asset.resource, amount: amount.toString() }],
        txHash: receipt.transactionHash,
        state: "submitted",
      });
      void sync("shield");
    }
  }

  if (enabled.length === 0) return <p className="notice warn">No asset is open for shielding on this network.</p>;
  return (
    <div className="stack">
      <AmountField
        label="Amount to shield"
        value={raw}
        onChange={setRaw}
        symbol={asset?.symbol}
        decimals={asset?.decimals}
        balance={asset && balance !== undefined ? fmtAmount(balance, asset.decimals, 6) : undefined}
        onMax={() => asset && balance !== undefined && setRaw(formatUnits(balance, asset.decimals))}
        error={amount && problem && asset && !status.shieldPaused ? problem : null}
        hint={<>
          {cap !== null && asset ? `Up to ${fmtAmount(cap, asset.decimals)} ${asset.symbol} per deposit. Shielding fee 0%; you pay network gas.` : "Shielding fee 0%. You pay network gas from your wallet."}
          {ethIn && " Pays from your ETH too: the site wraps it to WETH first and keeps a little ETH back for gas."}
        </>}
      >
        <AssetSelect assets={status.assets} value={token} onChange={setToken} filter={(a) => a.shieldingEnabled} />
      </AmountField>
      <Exposure
        pub={["Your wallet address as the depositor", `The asset and amount${amount && asset ? ` (${fmtAmount(amount, asset.decimals)} ${asset.symbol})` : ""}`, "The time"]}
        priv={["That the new note belongs to your vault account", "Every later transfer of it", "Which deposit funds a later withdrawal"]}
      />
      {(status.shieldPaused || !asset) && problem && <p className="notice warn small" style={{ margin: 0 }}>{problem}</p>}
      <WalletAction verb="shield">
        <button className="btn btn-primary btn-block" disabled={tx.busy || !amount || Boolean(problem)} onClick={go}>
          {tx.busy ? "Waiting for wallet…" : !amount ? "Enter an amount" : asset ? `Shield ${asset.symbol}` : "Shield"}
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
  const toProblem = to && !recipient ? "That is not a Curveil shielded address. They start with cvl1." : null;
  const amountProblem = amount && bal && amount + fee > bal.spendable ? "More than your spendable balance, including the fee" : null;
  const problem = toProblem ?? amountProblem;

  function go() {
    if (!asset || !amount || !recipient) return;
    void act.run({
      status,
      action: "transfer",
      label: `Private transfer of ${fmtAmount(amount, asset.decimals)} ${asset.symbol}`,
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
        <span className="field-label">Recipient's shielded address</span>
        <input className="text-input mono" placeholder="cvl1…" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} aria-invalid={Boolean(toProblem) || undefined} />
        {toProblem ? <span className="field-error">{toProblem}</span> : self ? <span className="field-hint">This is your own address: the transfer combines or splits your notes.</span> : <span className="field-hint">Ask the recipient for the cvl1 address shown under Vault in their profile.</span>}
      </label>
      <AmountField label="Amount" value={raw} onChange={setRaw} symbol={asset?.symbol} decimals={asset?.decimals} balanceLabel="Spendable" balance={asset && bal ? fmtAmount(bal.spendable, asset.decimals, 6) : undefined} onMax={() => asset && bal && setRaw(fmtAmount(bal.spendable - fee > 0n ? bal.spendable - fee : 0n, asset.decimals, asset.decimals).replace(/,/g, ""))} error={amountProblem}>
        <AssetSelect assets={status.assets} value={token} onChange={setToken} />
      </AmountField>
      <ModePicker mode={mode} onMode={setMode} b={b} action="transfer" feeToken={asset} />
      <Exposure
        pub={["That a private transfer happened, and when", ...senderExposure(mode)]}
        priv={["The amount", "The recipient", "Which of your notes were spent"]}
      />
      {asset && (
        <dl className="rows summary">
          <div><dt>Platform fee</dt><dd className="mono">0%</dd></div>
          <div><dt>Broadcaster fee</dt><dd className="mono">{mode === "broadcaster" ? `${fmtAmount(fee, asset.decimals, 6)} ${asset.symbol}` : "None, you submit from your wallet"}</dd></div>
          {amount ? <div><dt>Leaves your notes</dt><dd className="mono">{fmtAmount(amount + fee, asset.decimals, 6)} {asset.symbol}</dd></div> : null}
        </dl>
      )}
      <VaultSubmit mode={mode} act={act} disabled={!amount || !recipient || Boolean(problem)} onClick={go}>Prove and send</VaultSubmit>
    </div>
  );
}

// ---------------------------------------------------------------- withdraw

function WithdrawForm({ status }: { status: VaultStatus }) {
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
      ? "This address's capital letters do not match its checksum, so it may have been mistyped. Copy it again from the source."
      : "Enter a valid public address (0x…).";
  const amountProblem = amount && bal && amount + fee > bal.spendable ? "More than your spendable balance, including the fee" : null;
  const problem = toProblem ?? amountProblem;

  function go() {
    if (!asset || !amount || !recipient) return;
    void act.run({
      status,
      action: "withdraw",
      label: `Withdraw ${fmtAmount(amount, asset.decimals)} ${asset.symbol} to ${shortAddress(recipient)}`,
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
        label="Amount to withdraw"
        value={raw}
        onChange={setRaw}
        symbol={asset?.symbol}
        decimals={asset?.decimals}
        balanceLabel="Spendable"
        balance={asset && bal ? fmtAmount(bal.spendable, asset.decimals, 6) : undefined}
        onMax={() => asset && bal && setRaw(fmtAmount(bal.spendable - fee > 0n ? bal.spendable - fee : 0n, asset.decimals, asset.decimals).replace(/,/g, ""))}
        error={amountProblem}
      >
        <AssetSelect assets={status.assets} value={token} onChange={setToken} />
      </AmountField>
      <label className="field">
        <span className="field-top">
          <span className="field-label">Public recipient address</span>
          {wallet && to.toLowerCase() !== wallet.toLowerCase() && <button type="button" className="tbox-max" onClick={(e) => { e.preventDefault(); setTo(wallet); }}>Use my wallet</button>}
        </span>
        <input className="text-input mono" placeholder="0x…" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value.trim())} aria-invalid={Boolean(toProblem) || undefined} />
        {toProblem ? <span className="field-error">{toProblem}</span> : <span className="field-hint">Withdrawals are public: this address and the amount are visible on-chain.</span>}
      </label>
      <ModePicker mode={mode} onMode={setMode} b={b} action="withdraw" feeToken={asset} />
      {asset && amount ? (
        <dl className="rows summary">
          <div><dt>Withdrawal fee ({fmtBps(status.withdrawFeeBps)})</dt><dd className="mono">{fmtAmount(protocolFee, asset.decimals, 6)} {asset.symbol}</dd></div>
          <div><dt>Broadcaster fee, from notes</dt><dd className="mono">{fmtAmount(fee, asset.decimals, 6)} {asset.symbol}</dd></div>
          <div><dt>Leaves your notes</dt><dd className="mono">{fmtAmount(amount + fee, asset.decimals, 6)} {asset.symbol}</dd></div>
          <div><dt><strong style={{ color: "var(--ink)" }}>Recipient receives</strong></dt><dd className="mono" style={{ color: "#fff" }}>{fmtAmount(amount - protocolFee, asset.decimals, 6)} {asset.symbol}</dd></div>
        </dl>
      ) : null}
      <Exposure
        pub={["The recipient address", "The asset and amount", "The time", ...senderExposure(mode)]}
        priv={["Which deposit or transfer funded it", "Your remaining shielded balance"]}
      />
      <VaultSubmit mode={mode} act={act} disabled={!amount || !recipient || Boolean(problem)} onClick={go}>Prove and withdraw</VaultSubmit>
    </div>
  );
}

// ---------------------------------------------------------------- notes

function Notes({ v, status }: { v: VaultState; status: VaultStatus }) {
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
      label: `Combine two ${a.symbol} notes`,
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
        <p className="muted">No unspent notes yet. Shield an asset or ask someone to send to your vault address.</p>
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead>
              <tr><th scope="col">Note</th><th scope="col">Asset</th><th scope="col">Amount</th><th scope="col">State</th></tr>
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
                        (share ? `Shares of ${positionLabel(share)}` : claim ? <>Perps claim on <Link to="/app/perps">position #{claim.positionId}</Link></> : "Liquidity shares or a perps claim (waiting for the index)")}
                    </td>
                    <td className="mono">{a ? fmtAmount(n.amount, a.decimals, 6) : share ? `${unitsPct(BigInt(n.amount), BigInt(share.remainingUnits))}% of it` : claim ? "1 claim" : n.amount}</td>
                    <td>{reserved.has(n.nullifier) ? "Being spent" : "Spendable"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Each action spends at most two notes. If an amount needs more, combine notes first; this is a private transfer to yourself.
      </p>
      <div className="row-between" style={{ justifyContent: "flex-start" }}>
        {status.assets.map((a) =>
          combineCandidates(a.resource) ? (
            <button key={a.address} className="btn btn-sm" disabled={act.busy} onClick={() => combine(a)}>Combine two {a.symbol} notes</button>
          ) : null,
        )}
      </div>
      <StageView stage={act.stage} />
    </div>
  );
}

// ---------------------------------------------------------------- backup

function Backup({ v }: { v: VaultState }) {
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
      setError(e instanceof Error ? e.message : "Could not create the backup.");
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
      setError(e instanceof Error ? e.message : "Wrong passphrase.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Your recovery phrase is the master backup. An encrypted backup file is a convenience copy protected by your vault passphrase.
        {v.backupFileAt ? ` Last backup file: ${new Date(v.backupFileAt).toLocaleString()}.` : " No backup file downloaded yet."}
      </p>
      <label className="field">
        <span className="small muted">Vault passphrase</span>
        <input className="text-input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <div className="row-between" style={{ justifyContent: "flex-start" }}>
        <button className="btn" disabled={!pass || busy} onClick={download}>Download encrypted backup file</button>
        <button className="btn" disabled={!pass || busy} onClick={show}>Show recovery phrase</button>
      </div>
      {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      {words && (
        <>
          <ol className="phrase-grid mono" aria-label="Recovery phrase">
            {words.map((w, i) => (<li key={i}><span className="muted">{i + 1}</span> {w}</li>))}
          </ol>
          <button className="btn btn-sm" onClick={() => setWords(null)}>Hide</button>
        </>
      )}
    </div>
  );
}

