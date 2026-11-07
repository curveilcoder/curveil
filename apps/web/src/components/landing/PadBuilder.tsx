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
import { useT } from "../../lib/i18n";

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

/** The same steps in Chinese: the code stays, its comments are translated. */
const ZH = [
  {
    title: "在合约上注册",
    text: "一笔交易即可在 LaunchpadRegistry 合约上设置发射台的名称、品牌和手续费分成，无需部署任何合约。",
    code: STEPS[0]!.code.replace("// One transaction. Your wallet becomes the admin.", "// 一笔交易，你的钱包即成为管理员。").replace("// 25%, within the cap", "// 25%，不超过上限"),
  },
  {
    title: "搭建你自己的网站",
    text: "网站随你设计。你的网站从 API 读取发行数据，SDK 为任何钱包构建每一笔交易。",
    code: STEPS[1]!.code.replace("// Your launchpad and the tokens launched through it.", "// 你的发射台，以及通过它发行的代币。").replace("// Launching from your site records your launchpad.", "// 从你的网站发行，会记录到你的发射台。"),
  },
  {
    title: "每次发行都有收益",
    text: "通过你的网站发行的每个代币，都会把协议曲线手续费的一部分付给你。分成比例在代币创建时就已固定。",
    code: STEPS[2]!.code.replace("// Pull your fees out of each curve, then pay your recipients.", "// 从每条曲线中提取手续费，再分发给你的收款人。"),
  },
];

const RULES = [
  { h: "You build", tone: "see", items: ["Your own website and domain", "Your brand and design", "Any framework and wallet library"] },
  { h: "You set on the contract", tone: "see", items: ["Which launch templates you offer", "Your fee share, within the protocol's cap", "Who receives your fees"] },
  { h: "Nobody can, not even you", tone: "no", items: ["Change a live launch's rules", "Touch curve reserves", "Skip graduation or the LP escrow", "Pay out more fees than were collected"] },
];
const RULES_ZH = [
  { h: "由你构建", tone: "see", items: ["你自己的网站和域名", "你的品牌和设计", "任意框架和钱包库"] },
  { h: "由你在合约上设置", tone: "see", items: ["提供哪些发行模板", "你的手续费分成，不超过协议上限", "谁来接收你的手续费"] },
  { h: "任何人都不能，包括你", tone: "no", items: ["修改进行中发行的规则", "动用曲线储备", "跳过毕业或 LP 托管", "支付超过实际收取的手续费"] },
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
  const t = useT();
  const steps = t(STEPS, STEPS.map((s, n) => ({ ...s, ...ZH[n]! })));
  const ref = useRef<HTMLDivElement>(null);
  const [cur, pick] = useCycle(ref, STEPS.length, 5200);
  const field = useRef<HTMLDivElement>(null);
  const fieldAspect = useAspect(field);
  const step = steps[cur]!;
  return (
    <div ref={ref} className="pads">
      <div className="pads-top">
        <div className="pads-intro">
          {head}
          <ol className="stage-list pad-steps" aria-label={t("Running a launchpad", "运营发射台")}>
            {steps.map((s, n) => (
              <li key={s.file} data-state={n === cur ? "active" : undefined}>
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
            <p className="pad-foot mono">{t("@curveil/sdk · any wallet library · no indexer to run", "@curveil/sdk · 任意钱包库 · 无需运行索引器")}</p>
          </div>
        </div>
      </div>
      <div className="pads-rules">
        {t(RULES, RULES_ZH).map((g) => (
          <div key={g.h}>
            <p className="rule-h">{g.h}</p>
            <ul className="tick-list">
              {g.items.map((x) => <li key={x} className={g.tone}>{x}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
