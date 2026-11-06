import { useEffect, useMemo, useState } from "react";
import { Loading, Sk, SkNotice } from "../components/Skeleton";
import { PageHead } from "../components/PageHead";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useReadContract } from "wagmi";
import { formatUnits, isAddress, parseEventLogs, zeroAddress } from "viem";
import { TxStatus } from "../components/TxStatus";
import { WalletAction, AmountField } from "../components/WalletAction";
import { ModuleStatus } from "../components/ModuleStatus";
import { erc20Abi, factoryErrors, launchFactoryAbi } from "../lib/abis";
import { padHref, useOperator, type Operator } from "../lib/launchpads";
import { LAUNCH_FACTORY, explorerAddress, shortAddress } from "../lib/config";
import { fmtAmount, fmtBps, fmtNumber, fmtPrice, parseAmount, fmtQuote } from "../lib/format";
import { lockDuration, markCreated, previewInitialBuy, uploadMetadata, useTemplates, type Template } from "../lib/launch";
import { deadlineIn, useWalletTokens, same, NATIVE, WETH, wrapStep, GAS_RESERVE, quoteSym } from "../lib/tokens";
import { useTxRunner, type TxStep } from "../lib/tx";

const MAX_IMAGE = 4 * 1024 * 1024; // what the API stores
const MAX_PICK = 25 * 1024 * 1024; // what you can pick; bigger stills are shrunk to fit
const MAX_SIDE = 1024; // token images show at 64px at most, so 1024px is plenty

/** Shrinks a still image to at most MAX_SIDE px as WebP (or JPEG where WebP is not supported). */
async function shrinkImage(f: File): Promise<string> {
  const bmp = await createImageBitmap(f);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  for (const q of [0.9, 0.8, 0.65, 0.5]) {
    let url = c.toDataURL("image/webp", q);
    if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", q);
    if (url.length * 0.75 <= MAX_IMAGE) return url;
  }
  throw new Error("too big");
}

function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const bytes = (s: string) => new TextEncoder().encode(s).length;
const httpsOk = (s: string) => !s || /^https:\/\/[^\s]+$/.test(s.trim());

const createAbi = [...launchFactoryAbi, ...factoryErrors] as const;

export function LaunchCreate() {
  const { operator } = useSearch({ from: "/launch/new" });
  const pad = useOperator(operator);
  const op = operator ? pad.data?.operator : undefined;
  const templates = useTemplates();
  const enabled = (templates.data?.templates ?? []).filter((t) => t.enabled && (!op || op.templates.includes(t.id)));
  const [templateId, setTemplateId] = useState<number | null>(null);
  const t = enabled.find((x) => x.id === templateId) ?? enabled[0];
  const blocked = Boolean(operator && (pad.isLoading || pad.isError || (op && !op.acceptingLaunches)));

  return (
    <div className="wrap tk">
      <Link to="/launch" className="tk-back">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Launches
      </Link>
      <PageHead
        kicker={<Link to="/launch">Launch</Link>} label="/ New token" title="Create a token" art="curve"
        lead="Pick the pair and the size; together they set the economics. You choose the name, symbol, details and who receives your share of curve fees, then review every term before signing."
      />
      <div className="stack">
        <ModuleStatus id="launch" />
        {operator && <OperatorNotice op={op} loading={pad.isLoading} error={pad.isError} />}
        {templates.isError && (
          <div className="notice bad" role="alert">
            <span>Templates could not be loaded from the Curveil API, so nothing can be created right now.</span>
            <button className="btn btn-sm" onClick={() => templates.refetch()}>Retry</button>
          </div>
        )}
        {templates.isLoading && <FormSkeleton />}
        {templates.data && enabled.length === 0 && <p className="notice warn">No template is enabled for new launches on this network.</p>}
        {t && !blocked && (
          <CreateForm key={op?.address ?? "none"} t={t} templates={enabled} onTemplate={setTemplateId} op={op} />
        )}
      </div>
    </div>
  );
}

function OperatorNotice({ op, loading, error }: { op: Operator | undefined; loading: boolean; error: boolean }) {
  if (loading) return <SkNotice label="Loading the launchpad" />;
  if (error || !op) {
    return (
      <p className="notice bad" role="alert">
        That launchpad could not be found on this network. <Link to="/launch/new" search={{}}>Create without a launchpad</Link>.
      </p>
    );
  }
  const name = op.brand?.name || op.slug;
  if (!op.acceptingLaunches) {
    return (
      <p className="notice warn" role="alert">
        {name} is not accepting new launches right now{op.suspended ? " (suspended by the protocol)" : ""}. <Link to="/launch/new" search={{}}>Create without a launchpad</Link>.
      </p>
    );
  }
  return (
    <div className="notice good">
      <span>
        Launching on <strong>{name}</strong> (<a href={padHref(op, op.address)} target="_blank" rel="noreferrer">{op.slug}</a>). It receives {fmtBps(op.effectiveShareBps)} of the protocol's part of each curve fee
        on this token, fixed when the token is created. Your creator share does not change.
      </span>
    </div>
  );
}

/** The form while templates load: field labels show, inputs and template terms are skeletons. */
function FormSkeleton() {
  const field = (label: string) => (
    <div className="field" key={label}><span className="small muted">{label}</span><Sk block w="100%" h={44} /></div>
  );
  return (
    <div className="add-layout" aria-busy="true">
      <Loading label="Loading launch templates" />
      <div className="panel stack">
        {field("Pair and size")}
        <div className="grid-2">{field("Name")}{field("Symbol")}</div>
        <div className="field"><span className="small muted">Description</span><Sk block w="100%" h={84} /></div>
        {field("Creator fee recipient")}
        {field("Initial buy (optional)")}
      </div>
      <div className="panel stack">
        <div><p className="eyebrow">Review</p><h3>Your token</h3></div>
        <dl className="rows">
          {["Template", "Total supply", "Sold on the curve", "Moved to the pool at graduation", "Graduation threshold", "Start price", "Graduation price", "Curve fee", "Pool after graduation", "Creator LP"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="10ch" /></dd></div>)}
        </dl>
        <Sk block w="100%" h={44} />
      </div>
    </div>
  );
}

function CreateForm({ t, templates, onTemplate, op }: { t: Template; templates: Template[]; onTemplate: (id: number) => void; op?: Operator }) {
  const { address } = useConnection();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [xLink, setXLink] = useState("");
  const [telegram, setTelegram] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [initialBuy, setInitialBuy] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (address && !recipient) setRecipient(address);
  }, [address, recipient]);
  useEffect(() => setReviewed(false), [name, symbol, recipient, initialBuy, t.id]);
  // The initial buy is an amount of the pair's token, so a new pair starts it over.
  useEffect(() => setInitialBuy(""), [t.quote.address]);

  const paused = useReadContract({ address: LAUNCH_FACTORY, abi: launchFactoryAbi, functionName: "creationPaused", query: { enabled: Boolean(LAUNCH_FACTORY) } });
  // A WETH-priced template takes the initial buy in ETH: the site wraps it first.
  const ethQ = Boolean(WETH) && same(t.quote.address, WETH);
  const qSym = quoteSym(t.quote);
  const wallet = useWalletTokens([t.quote.address, ethQ ? NATIVE : undefined], LAUNCH_FACTORY);
  const { allowance } = wallet.get(t.quote.address);
  // For ETH, any WETH already held counts too; only the shortfall is wrapped.
  const wethHeld = ethQ ? wallet.get(t.quote.address).balance : undefined;
  const nativeHeld = wallet.get(NATIVE).balance;
  const balance = ethQ ? (nativeHeld !== undefined && wethHeld !== undefined ? nativeHeld + wethHeld : undefined) : wallet.get(t.quote.address).balance;
  const buyRaw = initialBuy.trim() ? parseAmount(initialBuy, t.quote.decimals) : 0n;
  const preview = buyRaw ? previewInitialBuy(t, buyRaw) : null;

  const problems = useMemo(() => {
    const p: string[] = [];
    const n = bytes(name.trim());
    if (n === 0) p.push("Enter a name.");
    else if (n > 32) p.push("The name is longer than 32 bytes.");
    if (!symbol) p.push("Enter a symbol.");
    else if (!/^[A-Z0-9]{1,10}$/.test(symbol)) p.push("The symbol must be 1 to 10 characters, A to Z and 0 to 9.");
    if (description.length > 500) p.push("The description is longer than 500 characters.");
    if (!httpsOk(website) || !httpsOk(xLink) || !httpsOk(telegram)) p.push("Links must start with https://");
    if (!isAddress(recipient)) p.push("Enter a valid fee recipient address.");
    if (buyRaw === null) p.push(`The initial buy is not a valid ${qSym} amount.`);
    if (buyRaw && balance !== undefined && buyRaw > balance) p.push(`Your ${qSym} balance is lower than the initial buy.`);
    if (imageError) p.push(imageError);
    return p;
  }, [name, symbol, description, website, xLink, telegram, recipient, buyRaw, balance, imageError, qSym]);

  async function onFile(f: File | undefined) {
    setImageError(null);
    setImage(null);
    if (!f) return;
    if (!IMAGE_TYPES.includes(f.type)) return setImageError("The image must be PNG, JPEG, WebP or GIF.");
    if (f.size > MAX_PICK) return setImageError("The image must be 25 MB or smaller.");
    if (f.type === "image/gif") {
      // Shrinking a GIF would drop its animation, so it is kept as it is.
      if (f.size > MAX_IMAGE) return setImageError("An animated GIF can be at most 4 MB. Other formats are shrunk to fit automatically.");
      return readDataUrl(f).then(setImage, () => setImageError("The image could not be read."));
    }
    try {
      setImage(await shrinkImage(f));
    } catch {
      setImageError("The image could not be read.");
    }
  }

  async function create() {
    if (!LAUNCH_FACTORY || !address || problems.length) return;
    setUploadError(null);
    let uri = "";
    if (description.trim() || website || xLink || telegram || image) {
      setUploading(true);
      try {
        uri = await uploadMetadata({ description: description.trim(), website: website.trim(), x: xLink.trim(), telegram: telegram.trim(), image });
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : "The token details could not be stored.");
        return;
      } finally {
        setUploading(false);
      }
    }
    // For ETH, wrap only what the curve will take, so no leftover WETH stays in the wallet.
    const buy = ethQ && preview && preview.quoteUsed < (buyRaw ?? 0n) ? preview.quoteUsed : (buyRaw ?? 0n);
    const steps: TxStep[] = [];
    const wrap = ethQ ? buy - (buy < (wethHeld ?? 0n) ? buy : (wethHeld ?? 0n)) : 0n;
    if (wrap > 0n) steps.push(wrapStep(wrap, `Wrap ${fmtAmount(wrap, 18, 6)} ETH`));
    if (buy > 0n && (allowance ?? 0n) < buy) {
      steps.push({
        label: `Approve ${t.quote.symbol}`,
        params: { address: t.quote.address, abi: erc20Abi, functionName: "approve", args: [LAUNCH_FACTORY, buy] } as const,
      });
    }
    steps.push({
      label: "Create token",
      params: {
        address: LAUNCH_FACTORY,
        abi: createAbi,
        functionName: "createLaunch",
        args: [
          {
            templateId: BigInt(t.id),
            name: name.trim(),
            symbol,
            metadataURI: uri,
            creatorRecipient: recipient as `0x${string}`,
            operator: op?.address ?? zeroAddress,
            initialBuy: buy,
            minTokensOut: preview?.tokensOut ?? 0n,
            deadline: deadlineIn(10),
          },
        ],
      } as const,
    });
    const receipt = await tx.run(steps);
    if (!receipt) return;
    const [ev] = parseEventLogs({ abi: launchFactoryAbi, eventName: "LaunchCreated", logs: receipt.logs });
    qc.invalidateQueries({ queryKey: ["launches"] });
    if (ev) {
      markCreated(ev.args.token);
      navigate({ to: "/launch/$token", params: { token: ev.args.token } });
    }
  }

  const supply = Number(BigInt(t.totalSupply)) / 1e18;
  const share = preview ? (Number(preview.tokensOut) / Number(BigInt(t.totalSupply))) * 100 : 0;
  const busy = tx.busy || uploading;
  const nameBytes = bytes(name.trim());

  return (
    <div className="add-layout">
      <div className="panel stack" style={{ gap: 20 }}>
        <section className="form-step">
          <div className="form-step-head"><span className="step-n">01</span><h3>Pair and size</h3><p>Both are fixed for the life of the token.</p></div>
          <PairAndSize t={t} templates={templates} onTemplate={onTemplate} />
        </section>

        <section className="form-step">
          <div className="form-step-head"><span className="step-n">02</span><h3>Token details</h3><p>Name and symbol are written on-chain and can never change.</p></div>
          <div className="grid-2" style={{ gap: 12 }}>
            <label className="field">
              <span className="field-top"><span className="field-label">Name</span><span className="field-count" data-over={nameBytes > 32}>{nameBytes}/32</span></span>
              <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Curveil Cat" maxLength={64} aria-invalid={nameBytes > 32 || undefined} />
              {nameBytes > 32 && <span className="field-error">Too long. Names are limited to 32 bytes; some characters use more than one.</span>}
            </label>
            <label className="field">
              <span className="field-top"><span className="field-label">Symbol</span><span className="field-count">{symbol.length}/10</span></span>
              <input className="text-input mono" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))} placeholder="CCAT" />
              <span className="field-hint">Letters A to Z and digits only.</span>
            </label>
          </div>
          <label className="field">
            <span className="field-top"><span className="field-label">Description <span className="optional faint">optional</span></span><span className="field-count">{description.length}/500</span></span>
            <textarea className="text-area" rows={3} value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} placeholder="What is this token for?" />
          </label>
        </section>

        <section className="form-step">
          <div className="form-step-head"><span className="step-n">03</span><h3>Image and links</h3><span className="optional">optional</span></div>
          <div className="field">
            <label
              className="upload"
              data-drag={drag || undefined}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void onFile(e.dataTransfer.files?.[0]); }}
            >
              <span className="upload-thumb">
                {image ? <img src={image} alt="Token image preview" /> : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4.5-4.5L6 21" /></svg>
                )}
              </span>
              <span className="upload-text">
                <strong>{image ? "Image ready" : "Upload an image"}</strong>
                <span>PNG, JPEG, WebP or GIF. Large images are resized for you (GIFs up to 4 MB). Drop it here or click to choose.</span>
              </span>
              <input type="file" accept={IMAGE_TYPES.join(",")} onChange={(e) => onFile(e.target.files?.[0])} aria-label="Token image" />
              {image && <button type="button" className="btn btn-sm" onClick={(e) => { e.preventDefault(); setImage(null); }}>Remove</button>}
            </label>
            {imageError && <p className="field-error">{imageError}</p>}
          </div>
          <div className="grid-3">
            {([["Website", website, setWebsite, "https://"], ["X", xLink, setXLink, "https://x.com/…"], ["Telegram", telegram, setTelegram, "https://t.me/…"]] as const).map(([l, v, set, ph]) => (
              <label key={l} className="field">
                <span className="field-label">{l}</span>
                <input className="text-input" type="url" inputMode="url" value={v} onChange={(e) => set(e.target.value)} placeholder={ph} aria-invalid={!httpsOk(v) || undefined} />
                {!httpsOk(v) && <span className="field-error">Start with https://</span>}
              </label>
            ))}
          </div>
        </section>

        <section className="form-step">
          <div className="form-step-head"><span className="step-n">04</span><h3>Fees and first buy</h3></div>
          <label className="field">
            <span className="field-top">
              <span className="field-label">Creator fee recipient</span>
              {address && recipient.toLowerCase() !== address.toLowerCase() && (
                <button type="button" className="tbox-max" onClick={(e) => { e.preventDefault(); setRecipient(address); }}>Use my wallet</button>
              )}
            </span>
            <input className="text-input mono" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x…" spellCheck={false} aria-invalid={(recipient !== "" && !isAddress(recipient)) || undefined} />
            {recipient !== "" && !isAddress(recipient)
              ? <span className="field-error">That is not a valid address.</span>
              : <span className="field-hint">Receives {fmtBps(t.creatorFeeShareBps)} of every curve fee. Only this address can change it later.</span>}
          </label>
          <AmountField
            label={`Initial buy, optional`}
            value={initialBuy}
            onChange={setInitialBuy}
            symbol={qSym}
            decimals={t.quote.decimals}
            balance={balance !== undefined ? fmtAmount(balance, t.quote.decimals, ethQ ? 4 : 2) : undefined}
            onMax={balance !== undefined ? () => {
              // Keep a little ETH back for gas.
              const max = ethQ ? (balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n) : balance;
              setInitialBuy(formatUnits(max, t.quote.decimals));
            } : undefined}
            error={buyRaw && balance !== undefined && buyRaw > balance ? `More than your ${qSym} balance` : null}
            hint={preview ? (
              <>
                You receive {fmtAmount(preview.tokensOut, 18, 0)} tokens ({share.toFixed(2)}% of supply) in the same transaction, before anyone else can trade.
                {preview.quoteUsed < (buyRaw ?? 0n) && ` That completes the curve: only ${fmtAmount(preview.quoteUsed, t.quote.decimals, ethQ ? 4 : 2)} ${qSym} is used and the rest stays in your wallet.`}
              </>
            ) : "Buy the first tokens yourself as part of creation. Leave empty to skip."}
          >
            <span className="token-tag">{qSym}</span>
          </AmountField>
        </section>
      </div>

      <div className="panel stack">
        <div>
          <p className="eyebrow">Review</p>
          <h3>{name.trim() || "Your token"} {symbol && <span className="mono muted">({symbol})</span>}</h3>
        </div>
        <TemplateTerms t={t} operatorShareBps={op?.effectiveShareBps} operatorName={op ? op.brand?.name || op.slug : undefined} />
        <dl className="rows">
          <div><dt>Creator fee recipient</dt><dd className="mono">{isAddress(recipient) ? shortAddress(recipient) : "–"}</dd></div>
          <div><dt>Initial buy</dt><dd className="mono">{preview ? `${fmtAmount(preview.quoteUsed, t.quote.decimals, ethQ ? 4 : 2)} ${qSym} → ${fmtAmount(preview.tokensOut, 18, 0)}` : "None"}</dd></div>
          <div><dt>Metadata</dt><dd>{description || image || website || xLink || telegram ? "Stored by the Curveil API, content-addressed" : "None"}</dd></div>
        </dl>
        <p className="small muted" style={{ margin: 0 }}>
          {fmtNumber(supply, 0)} tokens are minted once to the curve. The token has no owner, no mint and no pause. Name, symbol and supply can never change.
        </p>
        <label className="check">
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
          <span className="small">I reviewed the supply, curve, fees, threshold, recipients and lock periods above.</span>
        </label>
        {paused.data && <p className="notice warn">Launch creation is paused on this network. Existing curves still trade.</p>}
        {problems.length > 1 && (name || symbol) && (
          <ul className="small warn-text" style={{ margin: 0, paddingLeft: 18 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        <WalletAction verb="create a token">
          <button className="btn btn-primary btn-block" disabled={busy || !reviewed || problems.length > 0 || Boolean(paused.data)} onClick={create}>
            {uploading ? "Storing details…" : tx.busy ? "Waiting for wallet…" : problems.length ? problems[0]!.replace(/\.$/, "") : !reviewed ? "Tick the review box to continue" : preview ? `Create and buy` : "Create token"}
          </button>
        </WalletAction>
        {uploadError && <p className="notice bad" role="alert">{uploadError} Nothing was sent to the chain.</p>}
        <TxStatus phase={tx.phase} />
        {LAUNCH_FACTORY && (
          <p className="small muted" style={{ margin: 0 }}>
            Factory <a className="mono" href={explorerAddress(LAUNCH_FACTORY)} target="_blank" rel="noreferrer">{shortAddress(LAUNCH_FACTORY)}</a>
          </p>
        )}
      </div>
    </div>
  );
}

/** A template's size, without the pair in its name: "Quick ETH" and "Quick USDG" are both Quick. */
export function sizeLabel(t: Template): string {
  const words = t.label.split(/\s+/).filter((w) => !/^(w?eth|usdg|v\d+)$/i.test(w));
  return words.join(" ") || "Standard";
}

/**
 * The pair is chosen on its own, then the size among the templates for that pair. On-chain each
 * template has one quote asset, because its curve and threshold are counted in it.
 */
function PairAndSize({ t, templates, onTemplate }: { t: Template; templates: Template[]; onTemplate: (id: number) => void }) {
  const pairs = templates.filter((x, i) => templates.findIndex((y) => same(y.quote.address, x.quote.address)) === i);
  const sizes = templates.filter((x) => same(x.quote.address, t.quote.address)).sort((a, b) => a.graduationThresholdQuote - b.graduationThresholdQuote);
  function pickPair(quote: string) {
    const options = templates.filter((x) => same(x.quote.address, quote)).sort((a, b) => a.graduationThresholdQuote - b.graduationThresholdQuote);
    // Keep the same size when the other pair has it.
    onTemplate((options.find((x) => sizeLabel(x) === sizeLabel(t)) ?? options[0]!).id);
  }
  return (
    <>
      <div className="field">
        <span className="field-label">Pair</span>
        <div className="choice-grid two" role="group" aria-label="Pair">
          {pairs.map((x) => (
            <button key={x.quote.address} type="button" className="choice" aria-pressed={same(x.quote.address, t.quote.address)} onClick={() => pickPair(x.quote.address)}>
              <strong>{quoteSym(x.quote)}</strong>
              <span>Buyers pay in {quoteSym(x.quote)}, and the pool after graduation is {quoteSym(x.quote)} paired.</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Size</span>
        <div className="choice-grid" role="group" aria-label="Size">
          {sizes.map((x) => (
            <button key={x.id} type="button" className="choice" aria-pressed={x.id === t.id} onClick={() => onTemplate(x.id)}>
              <strong>{sizeLabel(x)}</strong>
              <span>Graduates at {fmtNumber(x.graduationThresholdQuote, 0)} {quoteSym(x.quote)} · {fmtBps(x.feeBps)} curve fee</span>
            </button>
          ))}
        </div>
        <span className="field-hint">The size is how much {quoteSym(t.quote)} the curve collects before the token moves into a pool. Every term is listed in the review before you sign.</span>
      </div>
    </>
  );
}

/** Every economic term of a template, in plain words. Used on create and on each token page. */
export function TemplateTerms({ t, operatorShareBps, operatorName }: { t: Template; operatorShareBps?: number | null; operatorName?: string }) {
  const rest = 10_000 - t.creatorFeeShareBps;
  const opBps = operatorShareBps ? Math.round((rest * operatorShareBps) / 10_000) : 0;
  const supply = Number(BigInt(t.totalSupply)) / 1e18;
  const curve = Number(BigInt(t.curveSupply)) / 1e18;
  const migration = Number(BigInt(t.migrationSupply)) / 1e18;
  const q = quoteSym(t.quote);
  return (
    <dl className="rows">
      <div><dt>Template</dt><dd>{t.label} <span className="muted">#{t.id}</span></dd></div>
      <div><dt>Total supply</dt><dd className="mono">{fmtNumber(supply, 0)}</dd></div>
      <div><dt>Sold on the curve</dt><dd className="mono">{fmtNumber(curve, 0)} ({((curve / supply) * 100).toFixed(0)}%)</dd></div>
      <div><dt>Moved to the pool at graduation</dt><dd className="mono">{fmtNumber(migration, 0)} ({((migration / supply) * 100).toFixed(0)}%)</dd></div>
      <div><dt>Graduation threshold</dt><dd className="mono">{fmtNumber(t.graduationThresholdQuote, 0)} {q} reserve</dd></div>
      <div><dt>Start price</dt><dd className="mono">{fmtPrice(t.startPrice)} {q} <span className="muted">(market cap {fmtQuote(t.startMarketCap, q).text}{fmtQuote(t.startMarketCap, q).unit ? ` ${q}` : ""})</span></dd></div>
      <div><dt>Graduation price</dt><dd className="mono">{fmtPrice(t.migrationPrice)} {q} <span className="muted">(market cap {fmtQuote(t.migrationMarketCap, q).text}{fmtQuote(t.migrationMarketCap, q).unit ? ` ${q}` : ""})</span></dd></div>
      <div>
        <dt>Curve fee</dt>
        <dd>
          {fmtBps(t.feeBps)} per trade: {fmtBps(t.creatorFeeShareBps)} creator,{" "}
          {opBps > 0 ? <>{fmtBps(opBps)} {operatorName ?? "launchpad"}, {fmtBps(rest - opBps)} protocol</> : <>{fmtBps(rest)} protocol</>}
        </dd>
      </div>
      <div><dt>Pool after graduation</dt><dd>DAMM tier {t.damm.tier}, fee {fmtBps(t.damm.baseFeeBps)} to {fmtBps(t.damm.maxFeeBps)}</dd></div>
      <div><dt>Creator LP</dt><dd>{fmtBps(t.creatorLpBps)} of LP, locked {lockDuration(t.creatorLockSeconds)}</dd></div>
      <div><dt>Protocol LP</dt><dd>{fmtBps(10_000 - t.creatorLpBps)} of LP, locked {lockDuration(t.protocolLockSeconds)}</dd></div>
      <div><dt>Price check at graduation</dt><dd>within {fmtBps(t.priceToleranceBps)}</dd></div>
      <div><dt>Protocol fee recipient</dt><dd className="mono"><a href={explorerAddress(t.protocolFeeRecipient)} target="_blank" rel="noreferrer">{shortAddress(t.protocolFeeRecipient)}</a></dd></div>
    </dl>
  );
}
