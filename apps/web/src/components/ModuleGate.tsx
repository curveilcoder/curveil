import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useStatus, moduleById, STATUS_LABEL, STATUS_LABEL_ZH } from "../lib/api";
import { PageHead } from "./PageHead";
import { StatusSkeleton } from "./ModuleStatus";
import { useT } from "../lib/i18n";

/** Honest availability for a module page: shows real status from the API, never a demo. */
export function ModuleGate({ id, title, summary, children, coming }: { id: string; title: string; summary: string; children?: ReactNode; coming: string[] }) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useStatus();
  const mod = moduleById(data, id);
  return (
    <div className="wrap">
      <PageHead kicker="Curveil" label={title} title={title} lead={summary} />
      <div className="stack">
        {isLoading && <StatusSkeleton />}
        {isError && (
          <div className="notice bad" role="alert">
            <span>{t("Could not reach the Curveil API, so availability is unknown. Nothing is assumed live.", "无法连接 Curveil API，因此可用状态未知。所有功能均不视为已上线。")}</span>
            <button className="btn btn-sm" onClick={() => refetch()}>{t("Retry", "重试")}</button>
          </div>
        )}
        {mod && (
          <div className={`notice ${mod.status === "not_live" ? "warn" : "good"}`}>
            <span className={`dot ${mod.status === "not_live" ? "warn" : "good"}`} style={{ marginTop: 7 }} aria-hidden="true" />
            <div>
              <strong>{t(STATUS_LABEL[mod.status], STATUS_LABEL_ZH[mod.status])}</strong>
              <p style={{ margin: "4px 0 0" }}>{mod.reason}</p>
              {mod.status === "not_live" && <p className="small muted" style={{ margin: "4px 0 0" }}>{t(`Scheduled in delivery phase ${mod.phase}. No transactions can be made here yet.`, `计划在第 ${mod.phase} 交付阶段上线。目前还不能在这里进行交易。`)}</p>}
            </div>
          </div>
        )}
        {children}
        <div className="panel">
          <h2 style={{ fontSize: 20 }}>{t("What this module will do", "该模块将提供的功能")}</h2>
          <ul className="checklist">
            {coming.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {t(<>Mechanics, fees and risks are in the <Link to="/docs">docs</Link>. Proposed settings stay labelled as proposals until deployed.</>, <>机制、费用和风险请见<Link to="/docs">文档</Link>。拟定的设置在部署前会一直标注为提案。</>)}
          </p>
        </div>
      </div>
    </div>
  );
}
