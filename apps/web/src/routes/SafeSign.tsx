import { useEffect, useMemo, useState } from "react";
import { useBalance, useConnection, useReadContracts, useSignTypedData } from "wagmi";
import { decodeFunctionData, encodeAbiParameters, keccak256, zeroAddress, type Hex } from "viem";
import { PageHead } from "../components/PageHead";
import { TxStatus } from "../components/TxStatus";
import { WalletAction } from "../components/WalletAction";
import { CopyAddress } from "../components/CopyAddress";
import { curveilChain, manifest } from "../lib/config";
import { describeError } from "../lib/errors";
import { fmtAmount } from "../lib/format";
import { execArgs, findSignatures, normalizeSig, packSignatures, safeAbi, safeTypedData, signer, timelockAbi, type SafeTx } from "../lib/safe";
import { same } from "../lib/tokens";
import { useTxRunner } from "../lib/tx";

/**
 * What the Safe has to sign, one file per action in src/data (written by the scripts that prepare
 * them). Each action is two Safe transactions: schedule it in the timelock, then execute it once
 * the delay has passed. Actions are listed in Safe nonce order.
 */
type PlanStep = { key: string; label: string; to: string; value: string; data: string; nonce: string };
type Plan = { chainId: number; name: string; summary?: string; contracts?: { name: string; address: string }[]; steps: PlanStep[] };
const PLANS: Plan[] = Object.values(import.meta.glob<Plan>("../data/*.json", { eager: true, import: "default" }))
  .filter((p) => p && Array.isArray(p.steps) && p.steps.length === 2 && p.chainId === curveilChain.id)
  .sort((a, b) => Number(a.steps[0]!.nonce) - Number(b.steps[0]!.nonce));

/** The timelock operation id that a schedule call creates (OpenZeppelin TimelockController). */
function operationId(data: Hex): Hex {
  const d = decodeFunctionData({ abi: timelockAbi, data });
  if (d.functionName === "scheduleBatch") {
    const [targets, values, payloads, predecessor, salt] = d.args;
    return keccak256(encodeAbiParameters([{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }], [targets, values, payloads, predecessor, salt]));
  }
  if (d.functionName === "schedule") {
    const [target, value, payload, predecessor, salt] = d.args;
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }], [target, value, payload, predecessor, salt]));
  }
  throw new Error(`step 1 is not a timelock schedule call (${d.functionName})`);
}
const SAFE = manifest.admin?.safe as `0x${string}` | undefined;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Sigs = Record<string, Hex>; // owner (lowercase) → signature
const storeKey = (hash: string) => `curveil-safe-sigs:${hash.toLowerCase()}`;
const loadSigs = (hash: string): Sigs => {
  try {
    return JSON.parse(localStorage.getItem(storeKey(hash)) ?? "{}") as Sigs;
  } catch {
    return {};
  }
};
const saveSigs = (hash: string, s: Sigs) => {
  try {
    localStorage.setItem(storeKey(hash), JSON.stringify(s));
  } catch {
    /* the page still works without storage */
  }
};

/** Every signature kept on this device, for any step. */
const storedSigs = (): Hex[] => {
  const out: Hex[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("curveil-safe-sigs:")) out.push(...findSignatures(localStorage.getItem(k) ?? ""));
    }
  } catch {
    /* no storage */
  }
  return out;
};

/** A link to this page that carries the signatures so far, so the next owner adds theirs to them. */
const shareLink = (extra: Hex[]) => {
  const all = [...new Set([...storedSigs(), ...extra].map((x) => x.toLowerCase()))];
  return `${window.location.origin}/safe#sigs=${all.join(",")}`;
};

/** Signatures that arrived in the link (#sigs=…). Each step keeps the ones made over its own hash. */
const linkSigs = (): Hex[] => (typeof window === "undefined" ? [] : findSignatures(window.location.hash));

/** Signs and sends the Safe transactions that hand Curveil's admin roles to the timelock. */
export function SafeSign() {
  return (
    <div className="wrap">
      <PageHead
        kicker="Admin" label="Safe" title="Sign the handover" art="shapes"
        lead="Each Safe owner signs here in their own wallet. Signing is free and sends nothing. When every owner has signed, any wallet with a little ETH sends the transaction."
      />
      {PLANS.length && SAFE ? <Handover safe={SAFE} /> : <div className="panel"><p className="muted" style={{ margin: 0 }}>Nothing to sign on this network.</p></div>}
    </div>
  );
}

function Handover({ safe }: { safe: `0x${string}` }) {
  const base = useReadContracts({
    allowFailure: false,
    query: { refetchInterval: 15_000 },
    contracts: [
      { address: safe, abi: safeAbi, functionName: "getOwners" },
      { address: safe, abi: safeAbi, functionName: "getThreshold" },
      { address: safe, abi: safeAbi, functionName: "nonce" },
    ],
  });
  const owners = (base.data?.[0] as readonly `0x${string}`[] | undefined) ?? [];
  const threshold = Number(base.data?.[1] ?? 0n);
  const nonce = base.data?.[2] as bigint | undefined;

  return (
    <div className="stack">
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>The Safe</h3>
        <dl className="rows">
          <div><dt>Address</dt><dd className="mono"><CopyAddress value={safe} /></dd></div>
          <div><dt>Signatures needed</dt><dd className="mono">{threshold ? `${threshold} of ${owners.length}` : "…"}</dd></div>
          {owners.map((o, i) => <div key={o}><dt>Owner {i + 1}</dt><dd className="mono"><CopyAddress value={o} /></dd></div>)}
        </dl>
        {base.isError && <p className="field-error">Could not read the Safe. Reload the page to try again.</p>}
      </div>
      {PLANS.map((plan) => (
        <PlanSteps key={plan.steps[0]!.data} plan={plan} safe={safe} owners={owners} threshold={threshold} nonce={nonce} onSent={() => void base.refetch()} />
      ))}
    </div>
  );
}

function PlanSteps({ plan, safe, owners, threshold, nonce, onSent }: {
  plan: Plan; safe: `0x${string}`; owners: readonly `0x${string}`[]; threshold: number; nonce: bigint | undefined; onSent: () => void;
}) {
  const timelock = plan.steps[0]!.to as `0x${string}`;
  const txs: SafeTx[] = useMemo(() => plan.steps.map((s) => ({ to: s.to as `0x${string}`, value: BigInt(s.value), data: s.data as Hex, nonce: BigInt(s.nonce) })), [plan]);
  const opId = useMemo(() => operationId(txs[0]!.data), [txs]);
  const hashReads = useReadContracts({
    allowFailure: false,
    contracts: txs.map((t) => ({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [t.to, t.value, t.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, t.nonce] }) as const),
  });
  const op = useReadContracts({
    allowFailure: false,
    query: { refetchInterval: 15_000 },
    contracts: [
      { address: timelock, abi: timelockAbi, functionName: "getTimestamp", args: [opId] },
      { address: timelock, abi: timelockAbi, functionName: "isOperationDone", args: [opId] },
    ],
  });
  const hashes = txs.map((_, i) => hashReads.data?.[i] as Hex | undefined);
  const readyAt = Number((op.data?.[0] as bigint | undefined) ?? 0n);
  const opDone = Boolean(op.data?.[1]);
  const what = plan.summary ?? (plan.contracts ? `The timelock accepts ownership of ${plan.contracts.length} contracts: ${plan.contracts.map((c) => c.name.split(".")[1]).join(", ")}.` : "");
  const allDone = opDone || (nonce !== undefined && nonce > txs[1]!.nonce);

  return (
    <section className="stack">
      <div>
        <h2 style={{ margin: 0 }}>{plan.name.replace(/^Curveil \w+: /, "").replace(/^./, (c) => c.toUpperCase())}</h2>
        {what && <p className="small muted" style={{ margin: "4px 0 0" }}>{what}{allDone ? " Done." : ""}</p>}
        {(hashReads.isError || op.isError) && <p className="field-error">Could not read this action. Reload the page to try again.</p>}
      </div>
      {txs.map((t, i) => (
        <Step
          key={plan.steps[i]!.key}
          n={i}
          label={plan.steps[i]!.label}
          safe={safe}
          tx={t}
          hash={hashes[i]}
          owners={owners}
          threshold={threshold}
          nonce={nonce}
          readyAt={readyAt}
          opDone={opDone}
          onSent={() => { onSent(); void op.refetch(); }}
        />
      ))}
    </section>
  );
}

function Step({ n, label, safe, tx, hash, owners, threshold, nonce, readyAt, opDone, onSent }: {
  n: number; label: string; safe: `0x${string}`; tx: SafeTx; hash: Hex | undefined; owners: readonly `0x${string}`[]; threshold: number;
  nonce: bigint | undefined; readyAt: number; opDone: boolean; onSent: () => void;
}) {
  const { address } = useConnection();
  const sign = useSignTypedData();
  const runner = useTxRunner();
  const bal = useBalance({ address, query: { enabled: Boolean(address) } });
  const [sigs, setSigs] = useState<Sigs>({});
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!hash) return;
    let live = true;
    const stored = loadSigs(hash);
    void (async () => {
      const next = { ...stored };
      for (const s of linkSigs()) {
        const who = await signer(hash, s);
        if (who && owners.some((o) => same(o, who))) next[who.toLowerCase()] = s;
      }
      if (!live) return;
      setSigs(next);
      if (Object.keys(next).length !== Object.keys(stored).length) saveSigs(hash, next);
    })();
    return () => { live = false; };
  }, [hash, owners.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000); return () => clearInterval(t); }, []);

  const isOwner = (a: string) => owners.some((o) => same(o, a));
  const valid = Object.entries(sigs).filter(([o]) => isOwner(o));
  const signedBy = (o: string) => Boolean(sigs[o.toLowerCase()]);
  const enough = threshold > 0 && valid.length >= threshold;

  const done = nonce !== undefined && nonce > tx.nonce;
  const turn = nonce !== undefined && nonce === tx.nonce;
  // Step 2 runs only after step 1 has been sent and the timelock's delay has passed.
  const waitSecs = n === 1 && readyAt > 1 ? readyAt - now : 0;
  const blocked = n === 1 && (readyAt <= 1 || waitSecs > 0);
  const status = done || (n === 1 && opDone)
    ? "Done."
    : n === 0
      ? turn ? "Not sent yet." : "Waiting."
      : readyAt === 0
        ? "Waits for step 1. You can sign it now and send it later."
        : waitSecs > 0
          ? `Can be sent from ${new Date(readyAt * 1000).toLocaleString()} (in ${Math.ceil(waitSecs / 3600)} hours).`
          : "Ready to send.";

  const keep = (next: Sigs) => { setSigs(next); if (hash) saveSigs(hash, next); };

  async function doSign() {
    if (!hash || !address) return;
    setNote(null);
    try {
      const sig = normalizeSig(await sign.mutateAsync(safeTypedData(safe, curveilChain.id, tx)));
      const who = await signer(hash, sig);
      if (!who || !isOwner(who)) { setNote("That signature does not match a Safe owner. Switch your wallet to an owner account and sign again."); return; }
      keep({ ...sigs, [who.toLowerCase()]: sig });
    } catch (e) {
      setNote(describeError(e));
    }
  }

  async function addPasted() {
    if (!hash) return;
    const found = findSignatures(paste);
    if (!found.length) { setNote("No signature found in that text."); return; }
    const next = { ...sigs };
    let added = 0;
    for (const s of found) {
      const who = await signer(hash, s);
      if (who && isOwner(who)) { next[who.toLowerCase()] = s; added++; }
    }
    keep(next);
    setPaste("");
    setNote(added ? `Added ${added} signature${added > 1 ? "s" : ""}.` : "Those signatures are not from Safe owners for this step.");
  }

  async function send() {
    const packed = packSignatures(valid.map(([owner, sig]) => ({ owner, sig })));
    const r = await runner.run([{ label: `Send ${label.split(":")[0]!.toLowerCase()}`, params: { address: safe, abi: safeAbi, functionName: "execTransaction", args: execArgs(tx, packed), chainId: curveilChain.id } }]);
    if (r) onSent();
  }

  const copyLink = () => {
    void navigator.clipboard?.writeText(shareLink(valid.map(([, s]) => s))).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const missing = owners.filter((o) => !signedBy(o)).length;

  const shareText = valid.map(([o, s]) => `${short(o)}: ${s}`).join("\n");
  const lowGas = bal.data !== undefined && bal.data.value < 100_000_000_000_000n;

  return (
    <div className="panel stack">
      <div>
        <h3 style={{ margin: 0 }}>{label}</h3>
        <p className="small muted" style={{ margin: "4px 0 0" }}>{status}</p>
      </div>
      {!done && (
        <>
          <dl className="rows">
            {owners.map((o, i) => <div key={o}><dt>Owner {i + 1} {short(o)}</dt><dd>{signedBy(o) ? "Signed" : "Not signed"}</dd></div>)}
          </dl>
          <WalletAction verb="sign">
            {address && isOwner(address) && !signedBy(address) && (
              <button className="btn btn-primary" onClick={doSign} disabled={!hash || sign.isPending}>{sign.isPending ? "Check your wallet" : `Sign as ${short(address)}`}</button>
            )}
            {address && !isOwner(address) && !enough && <p className="small muted" style={{ margin: 0 }}>The connected wallet {short(address)} is not an owner. Switch to an owner account to sign.</p>}
            {address && isOwner(address) && signedBy(address) && !enough && <p className="small muted" style={{ margin: 0 }}>Signed with {short(address)}. If you hold another owner account too, switch to it and sign again.</p>}
          </WalletAction>
          {valid.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <p className="small muted" style={{ margin: 0 }}>
                {enough
                  ? "Every owner has signed. Send it below, or copy the link for whoever has ETH to send it."
                  : `${missing} more signature${missing > 1 ? "s" : ""} needed. Copy this link and send it to the next owner: it carries the signatures so far, so they only sign and pass it on.`}
              </p>
              <div><button className="btn" onClick={copyLink}>{copied ? "Link copied" : "Copy link with signatures"}</button></div>
            </div>
          )}
          <details>
            <summary className="small">Signing on another device?</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <p className="small muted" style={{ margin: 0 }}>Signatures are not secret. Copy them from the device that has them and paste them here.</p>
              {shareText && <textarea className="input mono" readOnly rows={Math.min(4, valid.length + 1)} value={shareText} aria-label="Signatures so far" />}
              <textarea className="input mono" rows={3} placeholder="Paste signatures (0x…)" value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Paste signatures" />
              <button className="btn" onClick={addPasted} disabled={!paste.trim()}>Add signatures</button>
            </div>
          </details>
          {note && <p className="small" role="status" style={{ margin: 0 }}>{note}</p>}
          {enough && (
            <WalletAction verb="send it">
              <p className="small muted" style={{ margin: 0 }}>
                All signatures are in. Any wallet can send it; it pays the gas (a few cents).
                {bal.data && ` This wallet has ${fmtAmount(bal.data.value, 18, 5)} ETH.`}
                {lowGas && " That may not cover gas: send it from a wallet with a little ETH."}
              </p>
              <button className="btn btn-primary" onClick={send} disabled={runner.busy || !turn || blocked}>
                {!turn ? (n === 1 ? "Send step 1 first" : "Waiting") : blocked ? "Not ready yet" : runner.busy ? "Waiting for the wallet" : `Send ${label.split(":")[0]!.toLowerCase()}`}
              </button>
              <TxStatus phase={runner.phase} />
            </WalletAction>
          )}
        </>
      )}
    </div>
  );
}
