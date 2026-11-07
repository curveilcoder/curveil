/**
 * Safety diagram: how money moves through the Vault, one step at a time, on its own.
 */
import { useRef } from "react";
import { useCycle, useNarrow } from "./play";
import { DitherCanvas } from "../Dither";
import { SHIELD_SWEEP } from "./Fields";
import { usePrefersReducedMotion } from "../../lib/motion";
import { useT } from "../../lib/i18n";

const STEPS = [
  {
    id: "shield",
    name: "Shield",
    text: "Deposit into the Vault. It becomes an encrypted note only your Curveil account can spend.",
    sees: ["Your depositing address", "Asset, amount and time"],
    hidden: ["Every later action this note pays for"],
  },
  {
    id: "transact",
    name: "Transact",
    text: "Swap, add liquidity or send. A zero-knowledge proof made on your device authorises it.",
    sees: ["Pool execution: route, amounts, reserves", "Broadcaster timing"],
    hidden: ["Which wallet funded it", "Who owns the output", "Private send amounts and recipients"],
  },
  {
    id: "withdraw",
    name: "Withdraw",
    text: "Release value to any public address. Your recovery phrase restores the account anywhere.",
    sees: ["Recipient, asset, amount and time"],
    hidden: ["Which deposit is being redeemed"],
  },
] as const;

const STEPS_ZH = [
  {
    name: "存入隐私",
    text: "存入金库后，资金会变成一张加密票据，只有你的 Curveil 账户可以花费。",
    sees: ["你的存款地址", "资产、金额和时间"],
    hidden: ["这张票据之后支付的每一笔操作"],
  },
  {
    name: "交易",
    text: "兑换、添加流动性或转账。由你设备上生成的零知识证明来授权。",
    sees: ["资金池执行：路径、金额、储备", "广播时间"],
    hidden: ["由哪个钱包出资", "输出归谁所有", "私密转账的金额和收款人"],
  },
  {
    name: "提取",
    text: "把资金提到任意公开地址。你的恢复短语可以在任何地方恢复账户。",
    sees: ["收款人、资产、金额和时间"],
    hidden: ["赎回的是哪一笔存款"],
  },
] as const;

// Diagram geometry (viewBox 640 × 270). The Vault sits in the middle as a dithered disc.
const VX = 320, VY = 140, VR = 60;
const EDGE = {
  shield: `M 150 140 L ${VX - VR - 8} 140`,
  transactOut: `M ${VX + VR - 4} 118 C 420 96, 440 66, 482 66`,
  transactBack: `M 482 84 C 446 84, 428 140, ${VX + VR + 2} 136`,
  withdraw: `M ${VX + VR - 4} 162 C 420 186, 440 214, 482 214`,
};

export function MoneyFlow() {
  const t = useT();
  type Step = { id: string; name: string; text: string; sees: readonly string[]; hidden: readonly string[] };
  const steps = t<readonly Step[]>(STEPS, STEPS.map((st, n) => ({ ...st, ...STEPS_ZH[n]! })));
  const ref = useRef<HTMLDivElement>(null);
  const [i, pick, auto] = useCycle(ref, STEPS.length, 4200);
  const reduced = usePrefersReducedMotion();
  const narrow = useNarrow(820);
  const s = steps[i]!;
  const on = (id: string) => (s.id === id ? "on" : "");
  const note = s.id === "transact" ? t("Proof made on your device", "证明在你的设备上生成") : s.id === "shield" ? t("Note created for your account", "已为你的账户创建票据") : t("Note spent, value released", "票据已花费，资金已释放");
  return (
    <div ref={ref} className="vault-flow">
      <div className="vf-stage">
          {narrow ? <MiniFlow step={s.id} t={t} /> : (
          <div className="vf-diagram">
          <svg viewBox="0 0 640 270" className="flow-svg" role="img" aria-label={`${s.name}: ${s.text}`}>
            <defs>
              <marker id="fa" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {/* The link an observer cannot draw. */}
            <g className={`flow-broken ${s.id !== "shield" ? "on" : ""}`}>
              <path d={`M 76 112 C 120 30, 420 24, 560 50`} fill="none" strokeDasharray="3 5" />
              <circle cx={VX} cy={38} r={9} />
              <path d={`M ${VX - 4} 34 L ${VX + 4} 42 M ${VX + 4} 34 L ${VX - 4} 42`} />
              <text x={VX} y={20} textAnchor="middle">{t("no public link to your wallet", "与你的钱包没有公开关联")}</text>
            </g>
            <Node x={0} y={112} title={t("Your wallet", "你的钱包")} sub={t("Public address", "公开地址")} active={s.id === "shield"} />
            <g className={`flow-vault ${s.id}`}>
              <circle className="vault-halo" cx={VX} cy={VY} r={VR + 22} />
              <text x={VX} y={VY + 104} textAnchor="middle" className="t1">{t("Vault", "金库")}</text>
              <text x={VX} y={VY + 118} textAnchor="middle" className="t3">{note}</text>
            </g>
            <Node x={482} y={44} title={t("Pools", "资金池")} sub={t("Public execution", "公开执行")} active={s.id === "transact"} />
            <Node x={482} y={192} title={t("Any address", "任意地址")} sub={t("You choose it", "由你选择")} active={s.id === "withdraw"} />
            <Edge d={EDGE.shield} on={on("shield")} label={t("deposit", "存入")} lx={206} ly={130} reduced={reduced} />
            <Edge d={EDGE.transactOut} on={on("transact")} label={t("proof", "证明")} lx={430} ly={70} reduced={reduced} />
            <Edge d={EDGE.transactBack} on={on("transact")} reduced={reduced} />
            <Edge d={EDGE.withdraw} on={on("withdraw")} label={t("withdraw", "提取")} lx={418} ly={236} reduced={reduced} />
            </svg>
          <div className="vf-shield" aria-hidden="true"><DitherCanvas make={SHIELD_SWEEP} aspect={1.2} cell={3} animate fps={20} /></div>
          </div>
          )}
      </div>
      <ol className="vf-steps">
        {steps.map((st, n) => (
          <li key={st.id} className={n === i ? "on" : ""}>
            <button type="button" onClick={() => pick(n)} aria-pressed={n === i}>
              <span className="vf-bar" aria-hidden="true">{n === i && <i key={`t${i}`} className={auto ? "run" : "full"} />}</span>
              <span className="vf-name"><span className="mono">0{n + 1}</span> {st.name}</span>
              <span className="vf-text">{st.text}</span>
            </button>
            <div className="vf-lists">
              <div>
                <p className="flow-h">{t("Public sees", "公开可见")}</p>
                <ul className="tick-list">{st.sees.map((t) => <li key={t} className="see">{t}</li>)}</ul>
              </div>
              <div>
                <p className="flow-h shielded-ink">{t("Stays private", "保持私密")}</p>
                <ul className="tick-list">{st.hidden.map((t) => <li key={t} className="hide">{t}</li>)}</ul>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Node({ x, y, title, sub, active }: { x: number; y: number; title: string; sub: string; active: boolean }) {
  return (
    <g className={`flow-node ${active ? "on" : ""}`}>
      <rect x={x + 0.5} y={y + 0.5} width={157} height={55} rx={4} />
      <text x={x + 14} y={y + 24} className="t1">{title}</text>
      <text x={x + 14} y={y + 41} className="t2">{sub}</text>
    </g>
  );
}

function Edge({ d, on, label, lx, ly, reduced }: { d: string; on: string; label?: string; lx?: number; ly?: number; reduced: boolean }) {
  return (
    <g className={`flow-edge ${on}`}>
      <path d={d} fill="none" markerEnd="url(#fa)" />
      {label && <text x={lx} y={ly} textAnchor="middle">{label}</text>}
      {on && !reduced && (
        <>
          <rect x={-3} y={-3} width={6} height={6}>
            <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
          </rect>
          <rect x={-2} y={-2} width={4} height={4} className="trail">
            <animateMotion dur="1.6s" begin="0.8s" repeatCount="indefinite" path={d} />
          </rect>
        </>
      )}
    </g>
  );
}

/** The same flow as a short vertical list, for phones. */
function MiniFlow({ step, t }: { step: string; t: ReturnType<typeof useT> }) {
  const VAULT = t("Curveil Vault", "Curveil 金库");
  const [from, via, to] = step === "shield" ? [t("Your wallet", "你的钱包"), t("Deposit", "存入"), VAULT] : step === "transact" ? [VAULT, t("Proof", "证明"), t("Pools", "资金池")] : [VAULT, t("Withdraw", "提取"), t("Any address", "任意地址")];
  return (
    <div className="flow-mini" aria-hidden="true">
      <div className="vf-shield-mini"><DitherCanvas make={SHIELD_SWEEP} aspect={1.2} cell={3} animate fps={20} /></div>
      <span className={`fm-node ${from === VAULT ? "vault" : ""}`}>{from}</span>
      <span className="fm-edge mono">{via} ↓</span>
      <span className={`fm-node on ${to === VAULT ? "vault" : ""}`}>{to}</span>
      {step !== "shield" && <span className="fm-broken mono">✕ {t("No public link to your wallet", "与你的钱包没有公开关联")}</span>}
    </div>
  );
}
