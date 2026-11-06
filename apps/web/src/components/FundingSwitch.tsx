/** Public / Shielded: which account funds Swap and Liquidity. */
import { SHIELDED_EXECUTION, setFunding, useFunding } from "../lib/funding";

export function FundingSwitch({ className = "" }: { className?: string }) {
  const funding = useFunding();
  return (
    <div className={`account-switch ${className}`} role="group" aria-label="Funding account for swaps and liquidity">
      <button className="public" aria-pressed={funding === "public"} onClick={() => setFunding("public")}>Public</button>
      <button
        className="shielded"
        aria-pressed={funding === "shielded"}
        disabled={!SHIELDED_EXECUTION}
        title={SHIELDED_EXECUTION ? "Swap and provide liquidity from your vault notes" : "Shielded execution is not deployed on this network."}
        onClick={() => setFunding("shielded")}
      >
        Shielded
      </button>
    </div>
  );
}
