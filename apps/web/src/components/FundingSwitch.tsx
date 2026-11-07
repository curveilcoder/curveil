/** Public / Shielded: which account funds Swap and Liquidity. */
import { SHIELDED_EXECUTION, setFunding, useFunding } from "../lib/funding";
import { useT } from "../lib/i18n";

export function FundingSwitch({ className = "" }: { className?: string }) {
  const t = useT();
  const funding = useFunding();
  return (
    <div className={`account-switch ${className}`} role="group" aria-label={t("Funding account for swaps and liquidity", "兑换和流动性的付款账户")}>
      <button className="public" aria-pressed={funding === "public"} onClick={() => setFunding("public")}>{t("Public", "公开")}</button>
      <button
        className="shielded"
        aria-pressed={funding === "shielded"}
        disabled={!SHIELDED_EXECUTION}
        title={SHIELDED_EXECUTION ? t("Swap and provide liquidity from your vault notes", "用你的金库票据兑换和提供流动性") : t("Shielded execution is not deployed on this network.", "本网络尚未部署隐私执行。")}
        onClick={() => setFunding("shielded")}
      >
        {t("Shielded", "隐私")}
      </button>
    </div>
  );
}
