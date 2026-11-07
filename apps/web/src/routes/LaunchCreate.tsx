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
import { useT, tNow } from "../lib/i18n";

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
  const tr = useT();
  const { operator } = useSearch({ from: "/app/launch/new" });
  const pad = useOperator(operator);
  const op = operator ? pad.data?.operator : undefined;
  const templates = useTemplates();
  const enabled = (templates.data?.templates ?? []).filter((t) => t.enabled && (!op || op.templates.includes(t.id)));
  const [templateId, setTemplateId] = useState<number | null>(null);
  const t = enabled.find((x) => x.id === templateId) ?? enabled[0];
  const blocked = Boolean(operator && (pad.isLoading || pad.isError || (op && !op.acceptingLaunches)));

  return (
    <div className="wrap tk">
      <Link to="/app/launch" className="tk-back">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {tr("Launches", "代币发行")}
      </Link>
      <PageHead
        kicker={<Link to="/app/launch">{tr("Launch", "发币")}</Link>} label={tr("/ New token", "/ 新代币")} title={tr("Create a token", "创建代币")} art="curve"
        lead={tr("Pick the pair and the size; together they set the economics. You choose the name, symbol, details and who receives your share of curve fees, then review every term before signing.", "选择交易对和规模，二者共同决定代币经济。名称、符号、详情以及谁接收你那份曲线手续费由你决定，签名前会逐项核对所有条款。")}
      />
      <div className="stack">
        <ModuleStatus id="launch" />
        {operator && <OperatorNotice op={op} loading={pad.isLoading} error={pad.isError} />}
        {templates.isError && (
          <div className="notice bad" role="alert">
            <span>{tr("Templates could not be loaded from the Curveil API, so nothing can be created right now.", "无法从 Curveil API 加载模板，暂时无法创建代币。")}</span>
            <button className="btn btn-sm" onClick={() => templates.refetch()}>{tr("Retry", "重试")}</button>
          </div>
        )}
        {templates.isLoading && <FormSkeleton />}
        {templates.data && enabled.length === 0 && <p className="notice warn">{tr("No template is enabled for new launches on this network.", "该网络上没有可用于新发行的模板。")}</p>}
        {t && !blocked && (
          <CreateForm key={op?.address ?? "none"} t={t} templates={enabled} onTemplate={setTemplateId} op={op} />
        )}
      </div>
    </div>
  );
}

function OperatorNotice({ op, loading, error }: { op: Operator | undefined; loading: boolean; error: boolean }) {
  const tr = useT();
  if (loading) return <SkNotice label={tr("Loading the launchpad", "正在加载发射台")} />;
  if (error || !op) {
    return (
      <p className="notice bad" role="alert">
        {tr(<>That launchpad could not be found on this network. <Link to="/app/launch/new" search={{}}>Create without a launchpad</Link>.</>, <>在该网络上找不到这个发射台。<Link to="/app/launch/new" search={{}}>不通过发射台创建</Link>。</>)}
      </p>
    );
  }
  const name = op.brand?.name || op.slug;
  if (!op.acceptingLaunches) {
    return (
      <p className="notice warn" role="alert">
        {tr(<>{name} is not accepting new launches right now{op.suspended ? " (suspended by the protocol)" : ""}. <Link to="/app/launch/new" search={{}}>Create without a launchpad</Link>.</>, <>{name} 目前不接受新发行{op.suspended ? "（已被协议暂停）" : ""}。<Link to="/app/launch/new" search={{}}>不通过发射台创建</Link>。</>)}
      </p>
    );
  }
  return (
    <div className="notice good">
      <span>
        {tr(<>Launching on <strong>{name}</strong> (<a href={padHref(op, op.address)} target="_blank" rel="noreferrer">{op.slug}</a>). It receives {fmtBps(op.effectiveShareBps)} of the protocol's part of each curve fee
        on this token, fixed when the token is created. Your creator share does not change.</>, <>将在 <strong>{name}</strong>（<a href={padHref(op, op.address)} target="_blank" rel="noreferrer">{op.slug}</a>）上发行。该发射台获得此代币每笔曲线手续费中协议部分的 {fmtBps(op.effectiveShareBps)}，在代币创建时固定。你的创作者分成不变。</>)}
      </span>
    </div>
  );
}

/** The form while templates load: field labels show, inputs and template terms are skeletons. */
function FormSkeleton() {
  const tr = useT();
  const field = (label: string) => (
    <div className="field" key={label}><span className="small muted">{label}</span><Sk block w="100%" h={44} /></div>
  );
  return (
    <div className="add-layout" aria-busy="true">
      <Loading label={tr("Loading launch templates", "正在加载发行模板")} />
      <div className="panel stack">
        {field(tr("Pair and size", "交易对与规模"))}
        <div className="grid-2">{field(tr("Name", "名称"))}{field(tr("Symbol", "符号"))}</div>
        <div className="field"><span className="small muted">{tr("Description", "简介")}</span><Sk block w="100%" h={84} /></div>
        {field(tr("Creator fee recipient", "创作者手续费接收地址"))}
        {field(tr("Initial buy (optional)", "首次买入（可选）"))}
      </div>
      <div className="panel stack">
        <div><p className="eyebrow">{tr("Review", "核对")}</p><h3>{tr("Your token", "你的代币")}</h3></div>
        <dl className="rows">
          {tr(["Template", "Total supply", "Sold on the curve", "Moved to the pool at graduation", "Graduation threshold", "Start price", "Graduation price", "Curve fee", "Pool after graduation", "Creator LP"], ["模板", "总供应量", "曲线上出售", "毕业时转入资金池", "毕业门槛", "起始价格", "毕业价格", "曲线手续费", "毕业后的资金池", "创作者 LP"]).map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="10ch" /></dd></div>)}
        </dl>
        <Sk block w="100%" h={44} />
      </div>
    </div>
  );
}

function CreateForm({ t, templates, onTemplate, op }: { t: Template; templates: Template[]; onTemplate: (id: number) => void; op?: Operator }) {
  const tr = useT();
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
    if (n === 0) p.push(tr("Enter a name.", "请输入名称。"));
    else if (n > 32) p.push(tr("The name is longer than 32 bytes.", "名称超过 32 字节。"));
    if (!symbol) p.push(tr("Enter a symbol.", "请输入符号。"));
    else if (!/^[A-Z0-9]{1,10}$/.test(symbol)) p.push(tr("The symbol must be 1 to 10 characters, A to Z and 0 to 9.", "符号须为 1 到 10 个字符，只能使用 A 到 Z 和 0 到 9。"));
    if (description.length > 500) p.push(tr("The description is longer than 500 characters.", "简介超过 500 个字符。"));
    if (!httpsOk(website) || !httpsOk(xLink) || !httpsOk(telegram)) p.push(tr("Links must start with https://", "链接必须以 https:// 开头"));
    if (!isAddress(recipient)) p.push(tr("Enter a valid fee recipient address.", "请输入有效的手续费接收地址。"));
    if (buyRaw === null) p.push(tr(`The initial buy is not a valid ${qSym} amount.`, `首次买入不是有效的 ${qSym} 数量。`));
    if (buyRaw && balance !== undefined && buyRaw > balance) p.push(tr(`Your ${qSym} balance is lower than the initial buy.`, `你的 ${qSym} 余额低于首次买入数量。`));
    if (imageError) p.push(imageError);
    return p;
  }, [name, symbol, description, website, xLink, telegram, recipient, buyRaw, balance, imageError, qSym, tr]);

  async function onFile(f: File | undefined) {
    setImageError(null);
    setImage(null);
    if (!f) return;
    if (!IMAGE_TYPES.includes(f.type)) return setImageError(tr("The image must be PNG, JPEG, WebP or GIF.", "图片必须是 PNG、JPEG、WebP 或 GIF 格式。"));
    if (f.size > MAX_PICK) return setImageError(tr("The image must be 25 MB or smaller.", "图片不能超过 25 MB。"));
    if (f.type === "image/gif") {
      // Shrinking a GIF would drop its animation, so it is kept as it is.
      if (f.size > MAX_IMAGE) return setImageError(tr("An animated GIF can be at most 4 MB. Other formats are shrunk to fit automatically.", "动图 GIF 最大 4 MB，其他格式会自动压缩到合适大小。"));
      return readDataUrl(f).then(setImage, () => setImageError(tr("The image could not be read.", "无法读取该图片。")));
    }
    try {
      setImage(await shrinkImage(f));
    } catch {
      setImageError(tr("The image could not be read.", "无法读取该图片。"));
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
        setUploadError(e instanceof Error ? e.message : tr("The token details could not be stored.", "无法保存代币信息。"));
        return;
      } finally {
        setUploading(false);
      }
    }
    // For ETH, wrap only what the curve will take, so no leftover WETH stays in the wallet.
    const buy = ethQ && preview && preview.quoteUsed < (buyRaw ?? 0n) ? preview.quoteUsed : (buyRaw ?? 0n);
    const steps: TxStep[] = [];
    const wrap = ethQ ? buy - (buy < (wethHeld ?? 0n) ? buy : (wethHeld ?? 0n)) : 0n;
    if (wrap > 0n) steps.push(wrapStep(wrap, tr(`Wrap ${fmtAmount(wrap, 18, 6)} ETH`, `包装 ${fmtAmount(wrap, 18, 6)} ETH`)));
    if (buy > 0n && (allowance ?? 0n) < buy) {
      steps.push({
        label: tr(`Approve ${t.quote.symbol}`, `授权 ${t.quote.symbol}`),
        params: { address: t.quote.address, abi: erc20Abi, functionName: "approve", args: [LAUNCH_FACTORY, buy] } as const,
      });
    }
    steps.push({
      label: tr("Create token", "创建代币"),
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
      navigate({ to: "/app/launch/$token", params: { token: ev.args.token } });
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
          <div className="form-step-head"><span className="step-n">01</span><h3>{tr("Pair and size", "交易对与规模")}</h3><p>{tr("Both are fixed for the life of the token.", "两者在代币的整个生命周期内都固定不变。")}</p></div>
          <PairAndSize t={t} templates={templates} onTemplate={onTemplate} />
        </section>

        <section className="form-step">
          <div className="form-step-head"><span className="step-n">02</span><h3>{tr("Token details", "代币信息")}</h3><p>{tr("Name and symbol are written on-chain and can never change.", "名称和符号写入链上，永远无法更改。")}</p></div>
          <div className="grid-2" style={{ gap: 12 }}>
            <label className="field">
              <span className="field-top"><span className="field-label">{tr("Name", "名称")}</span><span className="field-count" data-over={nameBytes > 32}>{nameBytes}/32</span></span>
              <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Curveil Cat" maxLength={64} aria-invalid={nameBytes > 32 || undefined} />
              {nameBytes > 32 && <span className="field-error">{tr("Too long. Names are limited to 32 bytes; some characters use more than one.", "太长了。名称最多 32 字节，部分字符（如中文）会占用多个字节。")}</span>}
            </label>
            <label className="field">
              <span className="field-top"><span className="field-label">{tr("Symbol", "符号")}</span><span className="field-count">{symbol.length}/10</span></span>
              <input className="text-input mono" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))} placeholder="CCAT" />
              <span className="field-hint">{tr("Letters A to Z and digits only.", "只能使用字母 A 到 Z 和数字。")}</span>
            </label>
          </div>
          <label className="field">
            <span className="field-top"><span className="field-label">{tr("Description", "简介")} <span className="optional faint">{tr("optional", "可选")}</span></span><span className="field-count">{description.length}/500</span></span>
            <textarea className="text-area" rows={3} value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} placeholder={tr("What is this token for?", "这个代币是做什么的？")} />
          </label>
        </section>

        <section className="form-step">
          <div className="form-step-head"><span className="step-n">03</span><h3>{tr("Image and links", "图片与链接")}</h3><span className="optional">{tr("optional", "可选")}</span></div>
          <div className="field">
            <label
              className="upload"
              data-drag={drag || undefined}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void onFile(e.dataTransfer.files?.[0]); }}
            >
              <span className="upload-thumb">
                {image ? <img src={image} alt={tr("Token image preview", "代币图片预览")} /> : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4.5-4.5L6 21" /></svg>
                )}
              </span>
              <span className="upload-text">
                <strong>{image ? tr("Image ready", "图片已就绪") : tr("Upload an image", "上传图片")}</strong>
                <span>{tr("PNG, JPEG, WebP or GIF. Large images are resized for you (GIFs up to 4 MB). Drop it here or click to choose.", "支持 PNG、JPEG、WebP 或 GIF。大图会自动缩小（GIF 最大 4 MB）。拖到这里或点击选择。")}</span>
              </span>
              <input type="file" accept={IMAGE_TYPES.join(",")} onChange={(e) => onFile(e.target.files?.[0])} aria-label={tr("Token image", "代币图片")} />
              {image && <button type="button" className="btn btn-sm" onClick={(e) => { e.preventDefault(); setImage(null); }}>{tr("Remove", "移除")}</button>}
            </label>
            {imageError && <p className="field-error">{imageError}</p>}
          </div>
          <div className="grid-3">
            {([[tr("Website", "网站"), website, setWebsite, "https://"], ["X", xLink, setXLink, "https://x.com/…"], ["Telegram", telegram, setTelegram, "https://t.me/…"]] as const).map(([l, v, set, ph]) => (
              <label key={l} className="field">
                <span className="field-label">{l}</span>
                <input className="text-input" type="url" inputMode="url" value={v} onChange={(e) => set(e.target.value)} placeholder={ph} aria-invalid={!httpsOk(v) || undefined} />
                {!httpsOk(v) && <span className="field-error">{tr("Start with https://", "请以 https:// 开头")}</span>}
              </label>
            ))}
          </div>
        </section>

        <section className="form-step">
          <div className="form-step-head"><span className="step-n">04</span><h3>{tr("Fees and first buy", "手续费与首次买入")}</h3></div>
          <label className="field">
            <span className="field-top">
              <span className="field-label">{tr("Creator fee recipient", "创作者手续费接收地址")}</span>
              {address && recipient.toLowerCase() !== address.toLowerCase() && (
                <button type="button" className="tbox-max" onClick={(e) => { e.preventDefault(); setRecipient(address); }}>{tr("Use my wallet", "使用我的钱包")}</button>
              )}
            </span>
            <input className="text-input mono" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x…" spellCheck={false} aria-invalid={(recipient !== "" && !isAddress(recipient)) || undefined} />
            {recipient !== "" && !isAddress(recipient)
              ? <span className="field-error">{tr("That is not a valid address.", "这不是有效的地址。")}</span>
              : <span className="field-hint">{tr(`Receives ${fmtBps(t.creatorFeeShareBps)} of every curve fee. Only this address can change it later.`, `获得每笔曲线手续费的 ${fmtBps(t.creatorFeeShareBps)}。之后只有该地址可以更改。`)}</span>}
          </label>
          <AmountField
            label={tr("Initial buy, optional", "首次买入（可选）")}
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
            error={buyRaw && balance !== undefined && buyRaw > balance ? tr(`More than your ${qSym} balance`, `超过你的 ${qSym} 余额`) : null}
            hint={preview ? tr(
              <>
                You receive {fmtAmount(preview.tokensOut, 18, 0)} tokens ({share.toFixed(2)}% of supply) in the same transaction, before anyone else can trade.
                {preview.quoteUsed < (buyRaw ?? 0n) && ` That completes the curve: only ${fmtAmount(preview.quoteUsed, t.quote.decimals, ethQ ? 4 : 2)} ${qSym} is used and the rest stays in your wallet.`}
              </>,
              <>
                你会在同一笔交易中收到 {fmtAmount(preview.tokensOut, 18, 0)} 枚代币（占供应量的 {share.toFixed(2)}%），早于其他任何人交易。
                {preview.quoteUsed < (buyRaw ?? 0n) && `这笔买入会买完整条曲线：只使用 ${fmtAmount(preview.quoteUsed, t.quote.decimals, ethQ ? 4 : 2)} ${qSym}，其余留在你的钱包中。`}
              </>,
            ) : tr("Buy the first tokens yourself as part of creation. Leave empty to skip.", "在创建时自己买入第一批代币。留空则跳过。")}
          >
            <span className="token-tag">{qSym}</span>
          </AmountField>
        </section>
      </div>

      <div className="panel stack">
        <div>
          <p className="eyebrow">{tr("Review", "核对")}</p>
          <h3>{name.trim() || tr("Your token", "你的代币")} {symbol && <span className="mono muted">({symbol})</span>}</h3>
        </div>
        <TemplateTerms t={t} operatorShareBps={op?.effectiveShareBps} operatorName={op ? op.brand?.name || op.slug : undefined} />
        <dl className="rows">
          <div><dt>{tr("Creator fee recipient", "创作者手续费接收地址")}</dt><dd className="mono">{isAddress(recipient) ? shortAddress(recipient) : "–"}</dd></div>
          <div><dt>{tr("Initial buy", "首次买入")}</dt><dd className="mono">{preview ? `${fmtAmount(preview.quoteUsed, t.quote.decimals, ethQ ? 4 : 2)} ${qSym} → ${fmtAmount(preview.tokensOut, 18, 0)}` : tr("None", "无")}</dd></div>
          <div><dt>{tr("Metadata", "元数据")}</dt><dd>{description || image || website || xLink || telegram ? tr("Stored by the Curveil API, content-addressed", "由 Curveil API 按内容寻址存储") : tr("None", "无")}</dd></div>
        </dl>
        <p className="small muted" style={{ margin: 0 }}>
          {tr(`${fmtNumber(supply, 0)} tokens are minted once to the curve. The token has no owner, no mint and no pause. Name, symbol and supply can never change.`, `${fmtNumber(supply, 0)} 枚代币一次性铸造到曲线中。该代币没有所有者，不能增发，也不能暂停。名称、符号和供应量永远无法更改。`)}
        </p>
        <label className="check">
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
          <span className="small">{tr("I reviewed the supply, curve, fees, threshold, recipients and lock periods above.", "我已核对上面的供应量、曲线、手续费、门槛、接收地址和锁定期。")}</span>
        </label>
        {paused.data && <p className="notice warn">{tr("Launch creation is paused on this network. Existing curves still trade.", "该网络已暂停创建新发行，现有曲线仍可交易。")}</p>}
        {problems.length > 1 && (name || symbol) && (
          <ul className="small warn-text" style={{ margin: 0, paddingLeft: 18 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        <WalletAction verb={tr("create a token", "创建代币")}>
          <button className="btn btn-primary btn-block" disabled={busy || !reviewed || problems.length > 0 || Boolean(paused.data)} onClick={create}>
            {uploading ? tr("Storing details…", "正在保存信息…") : tx.busy ? tr("Waiting for wallet…", "等待钱包确认…") : problems.length ? problems[0]!.replace(/[.。]$/, "") : !reviewed ? tr("Tick the review box to continue", "勾选核对框后继续") : preview ? tr("Create and buy", "创建并买入") : tr("Create token", "创建代币")}
          </button>
        </WalletAction>
        {uploadError && <p className="notice bad" role="alert">{uploadError} {tr("Nothing was sent to the chain.", "没有向链上发送任何内容。")}</p>}
        <TxStatus phase={tx.phase} />
        {LAUNCH_FACTORY && (
          <p className="small muted" style={{ margin: 0 }}>
            {tr("Factory", "工厂合约")} <a className="mono" href={explorerAddress(LAUNCH_FACTORY)} target="_blank" rel="noreferrer">{shortAddress(LAUNCH_FACTORY)}</a>
          </p>
        )}
      </div>
    </div>
  );
}

/** A template's size, without the pair in its name: "Quick ETH" and "Quick USDG" are both Quick. */
export function sizeLabel(t: Template): string {
  const words = t.label.split(/\s+/).filter((w) => !/^(w?eth|usdg|v\d+)$/i.test(w));
  return words.join(" ") || tNow("Standard", "标准");
}

/**
 * The pair is chosen on its own, then the size among the templates for that pair. On-chain each
 * template has one quote asset, because its curve and threshold are counted in it.
 */
function PairAndSize({ t, templates, onTemplate }: { t: Template; templates: Template[]; onTemplate: (id: number) => void }) {
  const tr = useT();
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
        <span className="field-label">{tr("Pair", "交易对")}</span>
        <div className="choice-grid two" role="group" aria-label={tr("Pair", "交易对")}>
          {pairs.map((x) => (
            <button key={x.quote.address} type="button" className="choice" aria-pressed={same(x.quote.address, t.quote.address)} onClick={() => pickPair(x.quote.address)}>
              <strong>{quoteSym(x.quote)}</strong>
              <span>{tr(`Buyers pay in ${quoteSym(x.quote)}, and the pool after graduation is ${quoteSym(x.quote)} paired.`, `买家用 ${quoteSym(x.quote)} 支付，毕业后的资金池与 ${quoteSym(x.quote)} 配对。`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">{tr("Size", "规模")}</span>
        <div className="choice-grid" role="group" aria-label={tr("Size", "规模")}>
          {sizes.map((x) => (
            <button key={x.id} type="button" className="choice" aria-pressed={x.id === t.id} onClick={() => onTemplate(x.id)}>
              <strong>{sizeLabel(x)}</strong>
              <span>{tr(`Graduates at ${fmtNumber(x.graduationThresholdQuote, 0)} ${quoteSym(x.quote)} · ${fmtBps(x.feeBps)} curve fee`, `达到 ${fmtNumber(x.graduationThresholdQuote, 0)} ${quoteSym(x.quote)} 毕业 · 曲线手续费 ${fmtBps(x.feeBps)}`)}</span>
            </button>
          ))}
        </div>
        <span className="field-hint">{tr(`The size is how much ${quoteSym(t.quote)} the curve collects before the token moves into a pool. Every term is listed in the review before you sign.`, `规模是指代币转入资金池之前曲线要募集多少 ${quoteSym(t.quote)}。签名前，所有条款都会在核对区列出。`)}</span>
      </div>
    </>
  );
}

/** Every economic term of a template, in plain words. Used on create and on each token page. */
export function TemplateTerms({ t, operatorShareBps, operatorName }: { t: Template; operatorShareBps?: number | null; operatorName?: string }) {
  const tr = useT();
  const rest = 10_000 - t.creatorFeeShareBps;
  const opBps = operatorShareBps ? Math.round((rest * operatorShareBps) / 10_000) : 0;
  const supply = Number(BigInt(t.totalSupply)) / 1e18;
  const curve = Number(BigInt(t.curveSupply)) / 1e18;
  const migration = Number(BigInt(t.migrationSupply)) / 1e18;
  const q = quoteSym(t.quote);
  return (
    <dl className="rows">
      <div><dt>{tr("Template", "模板")}</dt><dd>{t.label} <span className="muted">#{t.id}</span></dd></div>
      <div><dt>{tr("Total supply", "总供应量")}</dt><dd className="mono">{fmtNumber(supply, 0)}</dd></div>
      <div><dt>{tr("Sold on the curve", "曲线上出售")}</dt><dd className="mono">{fmtNumber(curve, 0)} ({((curve / supply) * 100).toFixed(0)}%)</dd></div>
      <div><dt>{tr("Moved to the pool at graduation", "毕业时转入资金池")}</dt><dd className="mono">{fmtNumber(migration, 0)} ({((migration / supply) * 100).toFixed(0)}%)</dd></div>
      <div><dt>{tr("Graduation threshold", "毕业门槛")}</dt><dd className="mono">{fmtNumber(t.graduationThresholdQuote, 0)} {q} {tr("reserve", "储备")}</dd></div>
      <div><dt>{tr("Start price", "起始价格")}</dt><dd className="mono">{fmtPrice(t.startPrice)} {q} <span className="muted">({tr("market cap", "市值")} {fmtQuote(t.startMarketCap, q).text}{fmtQuote(t.startMarketCap, q).unit ? ` ${q}` : ""})</span></dd></div>
      <div><dt>{tr("Graduation price", "毕业价格")}</dt><dd className="mono">{fmtPrice(t.migrationPrice)} {q} <span className="muted">({tr("market cap", "市值")} {fmtQuote(t.migrationMarketCap, q).text}{fmtQuote(t.migrationMarketCap, q).unit ? ` ${q}` : ""})</span></dd></div>
      <div>
        <dt>{tr("Curve fee", "曲线手续费")}</dt>
        <dd>
          {tr(<>{fmtBps(t.feeBps)} per trade: {fmtBps(t.creatorFeeShareBps)} creator,{" "}
          {opBps > 0 ? <>{fmtBps(opBps)} {operatorName ?? "launchpad"}, {fmtBps(rest - opBps)} protocol</> : <>{fmtBps(rest)} protocol</>}</>,
          <>每笔交易 {fmtBps(t.feeBps)}：创作者 {fmtBps(t.creatorFeeShareBps)}，
          {opBps > 0 ? <>{operatorName ?? "发射台"} {fmtBps(opBps)}，协议 {fmtBps(rest - opBps)}</> : <>协议 {fmtBps(rest)}</>}</>)}
        </dd>
      </div>
      <div><dt>{tr("Pool after graduation", "毕业后的资金池")}</dt><dd>{tr(`DAMM tier ${t.damm.tier}, fee ${fmtBps(t.damm.baseFeeBps)} to ${fmtBps(t.damm.maxFeeBps)}`, `DAMM 第 ${t.damm.tier} 档，费率 ${fmtBps(t.damm.baseFeeBps)} 至 ${fmtBps(t.damm.maxFeeBps)}`)}</dd></div>
      <div><dt>{tr("Creator LP", "创作者 LP")}</dt><dd>{tr(`${fmtBps(t.creatorLpBps)} of LP, locked ${lockDuration(t.creatorLockSeconds)}`, `LP 的 ${fmtBps(t.creatorLpBps)}，锁定 ${lockDuration(t.creatorLockSeconds)}`)}</dd></div>
      <div><dt>{tr("Protocol LP", "协议 LP")}</dt><dd>{tr(`${fmtBps(10_000 - t.creatorLpBps)} of LP, locked ${lockDuration(t.protocolLockSeconds)}`, `LP 的 ${fmtBps(10_000 - t.creatorLpBps)}，锁定 ${lockDuration(t.protocolLockSeconds)}`)}</dd></div>
      <div><dt>{tr("Price check at graduation", "毕业时价格校验")}</dt><dd>{tr(`within ${fmtBps(t.priceToleranceBps)}`, `偏差不超过 ${fmtBps(t.priceToleranceBps)}`)}</dd></div>
      <div><dt>{tr("Protocol fee recipient", "协议手续费接收地址")}</dt><dd className="mono"><a href={explorerAddress(t.protocolFeeRecipient)} target="_blank" rel="noreferrer">{shortAddress(t.protocolFeeRecipient)}</a></dd></div>
    </dl>
  );
}
