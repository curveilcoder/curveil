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
  const { head, isError } = useHead();
  return (
    <p className="live-chip">
      <span className={`dot ${head ? "good" : isError ? "bad" : ""}`} aria-hidden="true" />
      {head ? <>Live on Robinhood Chain{net} · block <span className="mono">{fmt(head)}</span></> : isError ? "Chain status unavailable" : <><span className="sr-only">Reading the chain</span><Sk w="26ch" /></>}
    </p>
  );
}

/** One way in: a large Curveil-blue button with a light running round its edge and the Curveil mark. */
function HeroActions() {
  return (
    <div className="hero-launch">
      <Link to="/app/perps" className="launch-cta">
        <span>Launch app</span>
        <span className="launch-cta-mark" aria-hidden="true"><Logo size={24} tones={["shielded", "shielded", "shielded"]} /></span>
      </Link>
      <p className="launch-cta-note mono">No sign-up · connect a wallet to start</p>
    </div>
  );
}

/** A dithered lens in the middle that rebuilds itself into each product, text on both sides. */
function HeroLens() {
  const stage = useRef<HTMLElement>(null);
  const aspect = useAspect(stage);
  return (
    <>
      <section className="hero hero-lens" aria-labelledby="hero-title" ref={stage}>
        <div className="hero-silk" aria-hidden="true"><DitherCanvas make={SILK} aspect={aspect} cell={6} animate fps={16} /></div>
        <h1 id="hero-title" className="sr-only">Open markets. Private participation.</h1>
        <div className="wrap lens-top"><LiveChip /></div>
        <div className="wrap lens-grid">
          <div className="lens-side">
            <p className="lens-k mono"><span className="dot good" aria-hidden="true" /> Public</p>
            <p className="lens-h" aria-hidden="true">Open<br />markets.</p>
            <p className="lead">Pools, swaps, launches and perps, all in one place.</p>
          </div>
          <div className="lens-mid"><Lens /><div className="lens-ca"><CaChip /></div></div>
          <div className="lens-side right">
            <p className="lens-k mono">Shielded <span className="dot shielded" aria-hidden="true" /></p>
            <p className="lens-h shielded-ink" aria-hidden="true">Private<br />participation.</p>
            <p className="lead">Every market is public. Who owns what stays private.</p>
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
  const floor = useRef<HTMLDivElement>(null);
  const aspect = useAspect(floor);
  return (
    <section className="section app-section" id="app" aria-labelledby="app-title">
      <div className="wrap">
        <SectionHead
          center n="01" kicker="The app" id="app-title"
          title={<>Every market, <span className="shielded-ink">on one screen.</span></>}
          lead="Each pool has its own page with the price, its liquidity bins and live trades. Shielded trades appear like any other, just without the trader."
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
  return (
    <section className="section" id="launch" aria-labelledby="launch-title">
      <div className="wrap">
        <LaunchScrub
          head={
            <SectionHead
              n="02" kicker="Launch" id="launch-title"
              title={<>Watch a launch <span className="shielded-ink">graduate.</span></>}
              lead="Every launch follows a reviewed template: a bonding curve, a fixed threshold, then a DAMM pool with its LP shares locked in escrow."
            />
          }
        />
      </div>
    </section>
  );
}

/* ---------- 03 Perps ---------- */

function Perps() {
  return (
    <section className="section" id="perps" aria-labelledby="perps-title">
      <div className="wrap">
        <PerpReplay
          head={
            <SectionHead
              n="03" kicker="Perpetuals" id="perps-title"
              title={<>See the liquidation <span className="shielded-ink">before it happens.</span></>}
              lead="Live on Robinhood Chain: ETH and BTC up to 5×, SOL up to 2×, isolated margin in USDG. Each position replays the last 30 days of real prices against its liquidation price."
            />
          }
        />
      </div>
    </section>
  );
}

/* ---------- 04 Launchpads ---------- */

function Launchpads() {
  return (
    <section className="section" id="launchpads" aria-labelledby="pads-title">
      <div className="wrap">
        <PadBuilder
          head={
            <SectionHead
              n="04" kicker="Launchpads" id="pads-title"
              title={<>Build your own launchpad. <span className="shielded-ink">The rules come built in.</span></>}
              lead="Developers build their own launchpad website on Curveil's contracts. You design the site, the contracts enforce the rules, and you earn a share of the fees on every token launched through it."
            />
          }
        />
      </div>
    </section>
  );
}

/* ---------- 05 Why it's safe ---------- */

function Safety() {
  return (
    <section className="section safety-section" id="safety" aria-labelledby="safety-title">
      <div className="wrap">
        <SectionHead
          n="05" kicker="Why it's safe" id="safety-title"
          title={<>Your funds <span className="shielded-ink">stay yours.</span></>}
          lead="Funds sit in contracts, not on Curveil's servers. Keys are made in your browser, and Curveil never asks for them."
          center
        />
        <MoneyFlow />
      </div>
    </section>
  );
}

/* ---------- FAQ and closing ---------- */

const FAQ = [
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

function Faq() {
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <div className="wrap faq-grid">
        <div>
          <p className="eyebrow"><span className="eyebrow-n">06</span> Questions</p>
          <h2 id="faq-title">Plain <span className="shielded-ink">answers.</span></h2>
          <p className="lead">More detail, including every contract address, is in the <Link to="/docs">docs</Link>.</p>
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
  return (
    <section className="section cta" aria-label="Get started">
      <div className="wrap">
        <h2 id="cta-title">Open markets.<br /><span className="shielded-ink">Private participation.</span></h2>
        <p className="lead">{manifest.network === "testnet" ? "Free to try on testnet. Get test tokens from the faucet." : "Swaps, pools, launches, perps and the shielded vault. Not independently audited yet, so start small."}</p>
        <div className="hero-actions">
          <Link to="/docs" search={{ page: "get-started" }} className="btn btn-primary">Get started <span aria-hidden="true">→</span></Link>
          {IS_TESTNET ? (
            <Link to="/docs" search={{ page: "testnet" }} hash="faucet" className="btn">Get test tokens <span aria-hidden="true">→</span></Link>
          ) : (
            <Link to="/docs" className="btn">Read the docs <span aria-hidden="true">→</span></Link>
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
