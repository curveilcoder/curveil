import { useStatus, moduleById, STATUS_LABEL, STATUS_LABEL_ZH } from "../lib/api";
import { Link } from "@tanstack/react-router";
import { Loading, Sk } from "./Skeleton";
import { useT } from "../lib/i18n";

/** The risk that matters most where each module is used. The full list is on the Risks page. */
const RISK: Record<string, string> = {
  swap: "The price can move before your swap lands; your minimum received protects you. USDG's issuer can freeze or pause it.",
  markets: "Liquidity can end up worth less than holding both tokens, and USDG's issuer can freeze or pause it.",
  liquidity: "Liquidity can end up worth less than holding both tokens, and USDG's issuer can freeze or pause it.",
  launch: "Most launched tokens lose value. Anyone can launch a token with any name, so check the address before you buy.",
  vault: "Amounts and timing of deposits and withdrawals are public, so a deposit and a withdrawal close in size and time can be linked. Lose your recovery phrase and backup and the funds are gone.",
  perps: "Leverage multiplies losses, and a position is liquidated when its margin runs out. Prices come from an oracle that can be delayed.",
};
const RISK_ZH: Record<string, string> = {
  swap: "价格可能在你的兑换上链前变动；最低到账金额会保护你。USDG 的发行方可以冻结或暂停它。",
  markets: "提供的流动性最终可能不如同时持有两种代币，且 USDG 的发行方可以冻结或暂停它。",
  liquidity: "提供的流动性最终可能不如同时持有两种代币，且 USDG 的发行方可以冻结或暂停它。",
  launch: "大多数新发行的代币都会贬值。任何人都能用任何名称发行代币，买入前请核对地址。",
  vault: "存款和提款的金额与时间是公开的，金额和时间相近的一笔存款和一笔提款可能被关联起来。丢失恢复短语和备份，资金就会永久丢失。",
  perps: "杠杆会放大亏损，保证金耗尽时仓位会被强平。价格来自可能出现延迟的预言机。",
};

/**
 * Availability notice, straight from the API. Shown only when a module is not usable (not
 * live yet, paused, or the API is unreachable); a live module shows nothing.
 */
export function ModuleStatus({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useStatus();
  const mod = moduleById(data, id);
  if (isLoading) return null;
  if (isError) {
    return (
      <div className="notice bad" role="alert">
        <span>{t("Could not reach the Curveil API, so availability is unknown.", "无法连接 Curveil API，因此可用状态未知。")}</span>
        <button className="btn btn-sm" onClick={() => refetch()}>{t("Retry", "重试")}</button>
      </div>
    );
  }
  if (!mod) return null;
  const ok = mod.status === "live" || mod.status === "testnet";
  if (ok) return null;
  return (
    <div className={`notice ${ok ? "good" : "warn"}`}>
      <span className={`dot ${ok ? "good" : "warn"}`} style={{ marginTop: 7 }} aria-hidden="true" />
      <div>
        <strong>{t(STATUS_LABEL[mod.status], STATUS_LABEL_ZH[mod.status])}</strong>
        <p style={{ margin: "4px 0 0" }}>{mod.reason}</p>
        {RISK[id] && (
          <p className="small" style={{ margin: "6px 0 0" }}>
            {t(RISK[id], RISK_ZH[id])} <Link to="/docs" search={{ page: "risks" }}>{t("Read the risks", "阅读风险说明")}</Link>
          </p>
        )}
      </div>
    </div>
  );
}

/** The status notice while availability loads: a dot, a label and one line. */
export function StatusSkeleton() {
  const t = useT();
  return (
    <div className="notice" aria-busy="true">
      <Loading label={t("Checking availability", "正在检查可用状态")} />
      <Sk w={8} h={8} style={{ borderRadius: "50%", marginTop: 7, flex: "none" }} />
      <div style={{ flex: 1 }}><Sk w="8ch" /><Sk block w="70%" style={{ marginTop: 8 }} /></div>
    </div>
  );
}

/** Where indexed data stands, so numbers are never shown without their freshness. */
export function IndexerNote() {
  const t = useT();
  const { data } = useStatus();
  const ix = data?.indexer;
  if (!ix) return null;
  if (ix.status === "not_started") return <p className="small muted">{t("The market indexer has not started yet. Pool lists fill in once it runs.", "市场索引器尚未启动。它运行后资金池列表才会填充。")}</p>;
  const text =
    ix.status === "ok"
      ? t(`Indexed to block ${ix.indexedBlock?.toLocaleString("en-US")}`, `已索引到区块 ${ix.indexedBlock?.toLocaleString("en-US")}`)
      : ix.status === "lagging"
        ? t(`Indexer is ${ix.lagBlocks?.toLocaleString("en-US")} blocks behind; recent trades may be missing`, `索引器落后 ${ix.lagBlocks?.toLocaleString("en-US")} 个区块；可能缺少最近的成交`)
        : t("Indexer is stalled; figures may be out of date", "索引器已停滞；数据可能已过时");
  return (
    <p className="small muted index-note">
      <span className={`dot ${ix.status === "ok" ? "good" : "warn"}`} aria-hidden="true" /> {text}
    </p>
  );
}
