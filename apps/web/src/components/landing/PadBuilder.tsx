/**
 * Launchpads: developers build their own launchpad site on Curveil's contracts. Three steps
 * play in turn (register, build, earn), each with the code it takes, next to what a launchpad
 * controls and what nobody can change.
 */
import { useRef, type ReactNode } from "react";
import { DitherCanvas } from "../Dither";
import { TILES } from "./Fields";
import { useAspect } from "./HeroArt";
import { useCycle } from "./play";
import { NETWORK } from "../../lib/config";

const STEPS = [
  {
    title: "Register on the contract",
    text: "One transaction sets your launchpad's name, brand and fee share on the LaunchpadRegistry contract. There is nothing to deploy.",
    file: "register.ts",
    code: `import { encodeBrandURI, registerOperatorTx } from "@curveil/sdk";

// One transaction. Your wallet becomes the admin.
await wallet.sendTransaction(registerOperatorTx({
  registry, slug: "northbank",
  brandURI: encodeBrandURI({ name: "Northbank" }),
  shareBps: 2500,               // 25%, within the cap
  templates: [1],
  recipients: [{ address: treasury, weightBps: 10_000 }],
}));`,
  },
  {
    title: "Build your own site",
    text: "Design it however you like. Your site reads launches from the API, and the SDK builds every transaction for any wallet.",
    file: "site.ts",
    code: `const curveil = createClient({ network: "${NETWORK}" });

// Your launchpad and the tokens launched through it.
const { operator: pad } = await curveil.operator("northbank");
const { launches } = await curveil.launches({ operator: pad.address });

// Launching from your site records your launchpad.
await wallet.sendTransaction(createLaunchTx({
  factory, templateId: 1, operator: pad.address, …
}));`,
  },
  {
    title: "Earn on every launch",
    text: "Each token launched through your site pays you part of the protocol's curve fee. The share is fixed when the token is created.",
    file: "fees.ts",
    code: `const rev = await curveil.revenue("northbank");

// Pull your fees out of each curve, then pay your recipients.
await wallet.sendTransaction(collectTx(operator, curves, usdg));
await wallet.sendTransaction(releaseTx(operator, usdg, treasury));`,
  },
];

function Code({ src }: { src: string }) {
  return (
    <pre className="pad-code" aria-label="SDK example" tabIndex={0}>
      <code>
        {src.split("\n").map((line, n) => {
          const at = line.indexOf("//");
          return (
            <span key={n} className="pc-line">
              {at < 0 ? line : <>{line.slice(0, at)}<span className="pc-note">{line.slice(at)}</span></>}
              {"\n"}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export function PadBuilder({ head }: { head?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cur, pick] = useCycle(ref, STEPS.length, 5200);
  const field = useRef<HTMLDivElement>(null);
  const fieldAspect = useAspect(field);
  const step = STEPS[cur]!;
  return (
    <div ref={ref} className="pads">
      <div className="pads-top">
        <div className="pads-intro">
          {head}
          <ol className="stage-list pad-steps" aria-label="Running a launchpad">
            {STEPS.map((s, n) => (
              <li key={s.title} data-state={n === cur ? "active" : undefined}>
                <span className="mono">{String(n + 1).padStart(2, "0")}</span>
                <button type="button" onClick={() => pick(n)} aria-pressed={n === cur}>
                  <strong>{s.title}</strong>
                  {n === cur && <span className="stage-text">{s.text}</span>}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="pads-art">
          <div className="pads-field" ref={field} aria-hidden="true"><DitherCanvas make={TILES} aspect={fieldAspect} cell={4} animate fps={12} /></div>
          <div className="pad-editor">
            <div className="pad-tabs" aria-hidden="true">
              {STEPS.map((s, n) => <span key={s.file} className={n === cur ? "on" : ""}>{s.file}</span>)}
            </div>
            <Code key={cur} src={step.code} />
            <p className="pad-foot mono">@curveil/sdk · any wallet library · no indexer to run</p>
          </div>
        </div>
      </div>
      <div className="pads-rules">
        <div>
          <p className="rule-h">You build</p>
          <ul className="tick-list">
            <li className="see">Your own website and domain</li>
            <li className="see">Your brand and design</li>
            <li className="see">Any framework and wallet library</li>
          </ul>
        </div>
        <div>
          <p className="rule-h">You set on the contract</p>
          <ul className="tick-list">
            <li className="see">Which launch templates you offer</li>
            <li className="see">Your fee share, within the protocol's cap</li>
            <li className="see">Who receives your fees</li>
          </ul>
        </div>
        <div>
          <p className="rule-h">Nobody can, not even you</p>
          <ul className="tick-list">
            <li className="no">Change a live launch's rules</li>
            <li className="no">Touch curve reserves</li>
            <li className="no">Skip graduation or the LP escrow</li>
            <li className="no">Pay out more fees than were collected</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
