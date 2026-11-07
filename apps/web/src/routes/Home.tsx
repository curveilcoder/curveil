import { useRef, type ReactNode } from "react";
import { Sk } from "../components/Skeleton";
import { CaChip } from "../components/CaChip";
import { Logo } from "../components/Logo";
import { Link } from "@tanstack/react-router";
import { useStatus } from "../lib/api";
import { IS_TESTNET, manifest } from "../lib/config";
import { DitherCanvas } from "../components/Dither";
import { Lens, makeSilkU, useAspect } from "../components/landing/HeroArt";
import { AppWindow } from "../components/landing/AppWindow";
import { MoneyFlow } from "../components/landing/PrivacyFlow";
import { HORIZON } from "../components/landing/Fields";
import { LaunchScrub } from "../components/landing/LaunchScrub";
import { PerpReplay } from "../components/landing/PerpReplay";
import { PadBuilder } from "../components/landing/PadBuilder";
import { fmt } from "../components/landing/play";
import { useT } from "../lib/i18n";
import "../styles/landing.css";

const net = manifest.network === "testnet" ? " testnet" : "";

function useHead() {
  const { data, isError } = useStatus();
  return { head: data?.chain.status === "ok" ? data.chain.headBlock : null, isError, data };
}

function SectionHead({ n, kicker, id, title, lead, aside, center }: { n: string; kicker: string; id: string; title: ReactNode; lead: ReactNode; aside?: ReactNode; center?: boolean }) {
  return (
    <div className={`section-head${center ? " center" : ""}`}>
      <div>
        <p className="eyebrow"><span className="eyebrow-n">{n}</span> {kicker}</p>
        <h2 id={id}>{title}</h2>
        <p className="lead">{lead}</p>
      </div>
      {aside}
    </div>
  );
}

/* ---------- Hero ---------- */

function LiveChip() {
  const t = useT();
  const { head, isError } = useHead();
  return (
    <p className="live-chip">
      <span className={`dot ${head ? "good" : isError ? "bad" : ""}`} aria-hidden="true" />
      {head ? <>{t(`Live on Robinhood Chain${net} · block`, `已在 Robinhood Chain${net ? " 测试网" : ""} 上线 · 区块`)} <span className="mono">{fmt(head)}</span></> : isError ? t("Chain status unavailable", "暂时无法读取链状态") : <><span className="sr-only">{t("Reading the chain", "正在读取链上数据")}</span><Sk w="26ch" /></>}
    </p>
  );
}

/** One way in: a large Curveil-blue button with a light running round its edge and the Curveil mark. */
function HeroActions() {
  const t = useT();
  return (
    <div className="hero-launch">
      <Link to="/app/perps" className="launch-cta">
        <span>{t("Launch app", "启动应用")}</span>
        <span className="launch-cta-mark" aria-hidden="true"><Logo size={24} tones={["shielded", "shielded", "shielded"]} /></span>
      </Link>
      <p className="launch-cta-note mono">{t("No sign-up · connect a wallet to start", "无需注册 · 连接钱包即可开始")}</p>
    </div>
  );
}

/** A dithered lens in the middle that rebuilds itself into each product, text on both sides. */
function HeroLens() {
  const t = useT();
  const stage = useRef<HTMLElement>(null);
  const aspect = useAspect(stage);
  return (
    <>
      <section className="hero hero-lens" aria-labelledby="hero-title" ref={stage}>
        <div className="hero-silk" aria-hidden="true"><DitherCanvas make={SILK} aspect={aspect} cell={6} animate fps={16} /></div>
        <h1 id="hero-title" className="sr-only">{t("Open markets. Private participation.", "公开市场，私密参与。")}</h1>
        <div className="wrap lens-top"><LiveChip /></div>
        <div className="wrap lens-grid">
          <div className="lens-side">
            <p className="lens-k mono"><span className="dot good" aria-hidden="true" /> {t("Public", "公开")}</p>
            <p className="lens-h" aria-hidden="true">{t(<>Open<br />markets.</>, <>公开<br />市场。</>)}</p>
            <p className="lead">{t("Pools, swaps, launches and perps, all in one place.", "资金池、兑换、代币发行和永续合约，一站齐全。")}</p>
          </div>
          <div className="lens-mid"><Lens /><div className="lens-ca"><CaChip /></div></div>
          <div className="lens-side right">
            <p className="lens-k mono">{t("Shielded", "隐私")} <span className="dot shielded" aria-hidden="true" /></p>
            <p className="lens-h shielded-ink" aria-hidden="true">{t(<>Private<br />participation.</>, <>私密<br />参与。</>)}</p>
            <p className="lead">{t("Every market is public. Who owns what stays private.", "每个市场都是公开的，谁持有什么则保持私密。")}</p>
          </div>
        </div>
        <div className="wrap lens-foot"><HeroActions /></div>
      </section>
    </>
  );
}

const SILK = makeSilkU();

function Hero() {
  return <HeroLens />;
}

/* ---------- 01 The app ---------- */

function TheApp() {
  const t = useT();
  const floor = useRef<HTMLDivElement>(null);
  const aspect = useAspect(floor);
  return (
    <section className="section app-section" id="app" aria-labelledby="app-title">
      <div className="wrap">
        <SectionHead
          center n="01" kicker={t("The app", "应用")} id="app-title"
          title={t(<>Every market, <span className="shielded-ink">on one screen.</span></>, <>所有市场，<span className="shielded-ink">尽在一屏。</span></>)}
          lead={t("Each pool has its own page with the price, its liquidity bins and live trades. Shielded trades appear like any other, just without the trader.", "每个资金池都有自己的页面，展示价格、流动性区间和实时成交。隐私交易和其他交易一样显示，只是看不到交易者。")}
        />
      </div>
      <div className="app-stage">
        <div className="app-floor" ref={floor} aria-hidden="true"><DitherCanvas make={HORIZON} aspect={aspect} cell={5} animate fps={16} /></div>
        <div className="wrap wide"><AppWindow /></div>
      </div>
    </section>
  );
}

/* ---------- 02 Launch ---------- */

function Launch() {
  const t = useT();
  return (
    <section className="section" id="launch" aria-labelledby="launch-title">
      <div className="wrap">
        <LaunchScrub
          head={
            <SectionHead
              n="02" kicker={t("Launch", "发币")} id="launch-title"
              title={t(<>Watch a launch <span className="shielded-ink">graduate.</span></>, <>看一次发行如何<span className="shielded-ink">毕业。</span></>)}
              lead={t("Every launch follows a reviewed template: a bonding curve, a fixed threshold, then a DAMM pool with its LP shares locked in escrow.", "每次发行都遵循经过审核的模板：先走联合曲线，达到固定门槛后进入 DAMM 资金池，LP 份额锁定在托管合约中。")}
            />
          }
        />
      </div>
    </section>
  );
}

/* ---------- 03 Perps ---------- */

function Perps() {
  const t = useT();
  return (
    <section className="section" id="perps" aria-labelledby="perps-title">
      <div className="wrap">
        <PerpReplay
          head={
            <SectionHead
              n="03" kicker={t("Perpetuals", "永续合约")} id="perps-title"
              title={t(<>See the liquidation <span className="shielded-ink">before it happens.</span></>, <>在强平发生之前，<span className="shielded-ink">先看清它。</span></>)}
              lead={t("Live on Robinhood Chain: ETH and BTC up to 5×, SOL up to 2×, isolated margin in USDG. Each position replays the last 30 days of real prices against its liquidation price.", "已在 Robinhood Chain 上线：ETH 和 BTC 最高 5 倍，SOL 最高 2 倍，以 USDG 逐仓保证金交易。每个示例仓位都会用过去 30 天的真实价格回放，并对照其强平价格。")}
            />
          }
        />
      </div>
    </section>
  );
}

/* ---------- 04 Launchpads ---------- */

function Launchpads() {
  const t = useT();
  return (
    <section className="section" id="launchpads" aria-labelledby="pads-title">
      <div className="wrap">
        <PadBuilder
          head={
            <SectionHead
              n="04" kicker={t("Launchpads", "发射台")} id="pads-title"
              title={t(<>Build your own launchpad. <span className="shielded-ink">The rules come built in.</span></>, <>打造你自己的发射台，<span className="shielded-ink">规则已内置。</span></>)}
              lead={t("Developers build their own launchpad website on Curveil's contracts. You design the site, the contracts enforce the rules, and you earn a share of the fees on every token launched through it.", "开发者可以基于 Curveil 的合约搭建自己的发射台网站。网站由你设计，规则由合约执行，通过你的网站发行的每个代币，你都能获得一部分手续费分成。")}
            />
          }
        />
      </div>
    </section>
  );
}

/* ---------- 05 Why it's safe ---------- */

function Safety() {
  const t = useT();
  return (
    <section className="section safety-section" id="safety" aria-labelledby="safety-title">
      <div className="wrap">
        <SectionHead
          n="05" kicker={t("Why it's safe", "为什么安全")} id="safety-title"
          title={t(<>Your funds <span className="shielded-ink">stay yours.</span></>, <>你的资金，<span className="shielded-ink">始终属于你。</span></>)}
          lead={t("Funds sit in contracts, not on Curveil's servers. Keys are made in your browser, and Curveil never asks for them.", "资金存放在合约中，而不是 Curveil 的服务器上。密钥在你的浏览器中生成，Curveil 从不索取。")}
          center
        />
        <MoneyFlow />
      </div>
    </section>
  );
}

/* ---------- FAQ and closing ---------- */

const FAQ_EN = [
  [
    "Is Curveil live?",
    IS_TESTNET
      ? "On testnet only: markets, launches, the shielded vault, perps and branded launchpads run on Robinhood Chain testnet with test tokens. Nothing is on mainnet yet, and the contracts are not audited."
      : "Markets, launches, launchpads, perps and the shielded vault are live on Robinhood Chain, without an independent audit so far, and vault deposits are capped. The status on each page and in the docs shows what is live today.",
  ],
  ["Does shielding make me anonymous?", "No. It hides the link between your funding wallet and what you own. Deposits, withdrawals, pool execution and timing stay public."],
  ["What happens if Curveil's servers go down?", "Your funds stay in contracts, not on our servers. A documented alternative client recovers and withdraws vault funds with only your recovery phrase and an RPC endpoint."],
  ["Is there a CURVEIL token yet?", manifest.token.address
    ? `Yes. Its contract address is ${manifest.token.address}, also shown at the top of this page with a copy button. Check it before you trade.`
    : "Not yet. Its address appears on this page only once it launches."],
  ["Is Curveil part of Robinhood?", "No. Curveil runs on Robinhood Chain but is not affiliated with or endorsed by Robinhood."],
];

const FAQ_ZH = [
  [
    "Curveil 上线了吗？",
    IS_TESTNET
      ? "目前仅在测试网：市场、代币发行、隐私金库、永续合约和品牌发射台都运行在 Robinhood Chain 测试网上，使用测试代币。主网尚未上线，合约也尚未经过审计。"
      : "市场、代币发行、发射台、永续合约和隐私金库已在 Robinhood Chain 上线，目前尚未经过独立审计，金库存款设有上限。各页面和文档中的状态会显示当前哪些功能已上线。",
  ],
  ["隐私保护会让我完全匿名吗？", "不会。它隐藏的是你的资金钱包与你所持资产之间的关联。存款、提款、资金池执行和时间点仍然是公开的。"],
  ["如果 Curveil 的服务器宕机怎么办？", "你的资金存放在合约中，而不在我们的服务器上。我们提供一个有文档说明的备用客户端，只需你的恢复短语和一个 RPC 节点，即可恢复并提取金库中的资金。"],
  ["CURVEIL 代币发行了吗？", manifest.token.address
    ? `已发行。合约地址是 ${manifest.token.address}，本页顶部也有显示并可一键复制。交易前请务必核对。`
    : "还没有。代币发行后，其地址才会出现在本页。"],
  ["Curveil 是 Robinhood 的一部分吗？", "不是。Curveil 运行在 Robinhood Chain 上，但与 Robinhood 没有关联，也未获其认可。"],
];

function Faq() {
  const t = useT();
  const FAQ = t(FAQ_EN, FAQ_ZH);
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <div className="wrap faq-grid">
        <div>
          <p className="eyebrow"><span className="eyebrow-n">06</span> {t("Questions", "常见问题")}</p>
          <h2 id="faq-title">{t(<>Plain <span className="shielded-ink">answers.</span></>, <>直白的<span className="shielded-ink">回答。</span></>)}</h2>
          <p className="lead">{t(<>More detail, including every contract address, is in the <Link to="/docs">docs</Link>.</>, <>更多细节（包括所有合约地址）请查看<Link to="/docs">文档</Link>。</>)}</p>
        </div>
        <div className="faq2">
          {FAQ.map(([q, a], n) => (
            <details key={q} open={n === 0}>
              <summary><span className="mono">0{n + 1}</span><span>{q}</span><i aria-hidden="true" /></summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  const t = useT();
  return (
    <section className="section cta" aria-label={t("Get started", "开始使用")}>
      <div className="wrap">
        <h2 id="cta-title">{t(<>Open markets.<br /><span className="shielded-ink">Private participation.</span></>, <>公开市场，<br /><span className="shielded-ink">私密参与。</span></>)}</h2>
        <p className="lead">{manifest.network === "testnet" ? t("Free to try on testnet. Get test tokens from the faucet.", "可在测试网免费体验，从水龙头领取测试代币。") : t("Swaps, pools, launches, perps and the shielded vault. Not independently audited yet, so start small.", "兑换、资金池、代币发行、永续合约和隐私金库。目前尚未经过独立审计，请从小额开始。")}</p>
        <div className="hero-actions">
          <Link to="/docs" search={{ page: "get-started" }} className="btn btn-primary">{t("Get started", "开始使用")} <span aria-hidden="true">→</span></Link>
          {IS_TESTNET ? (
            <Link to="/docs" search={{ page: "testnet" }} hash="faucet" className="btn">{t("Get test tokens", "领取测试代币")} <span aria-hidden="true">→</span></Link>
          ) : (
            <Link to="/docs" className="btn">{t("Read the docs", "阅读文档")} <span aria-hidden="true">→</span></Link>
          )}
        </div>
      </div>
    </section>
  );
}

export function Home() {
  return (
    <>
      <Hero />
      <TheApp />
      <Launch />
      <Perps />
      <Launchpads />
      <Safety />
      <Faq />
      <Closing />
    </>
  );
}
