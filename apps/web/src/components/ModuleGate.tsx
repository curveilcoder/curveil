import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useStatus, moduleById, STATUS_LABEL } from "../lib/api";
import { PageHead } from "./PageHead";
import { StatusSkeleton } from "./ModuleStatus";

/** Honest availability for a module page: shows real status from the API, never a demo. */
export function ModuleGate({ id, title, summary, children, coming }: { id: string; title: string; summary: string; children?: ReactNode; coming: string[] }) {
  const { data, isLoading, isError, refetch } = useStatus();
  const mod = moduleById(data, id);
  return (
    <div className="wrap">
      <PageHead kicker="Curveil" label={title} title={title} lead={summary} />
      <div className="stack">
        {isLoading && <StatusSkeleton />}
        {isError && (
          <div className="notice bad" role="alert">
            <span>Could not reach the Curveil API, so availability is unknown. Nothing is assumed live.</span>
            <button className="btn btn-sm" onClick={() => refetch()}>Retry</button>
          </div>
        )}
        {mod && (
          <div className={`notice ${mod.status === "not_live" ? "warn" : "good"}`}>
            <span className={`dot ${mod.status === "not_live" ? "warn" : "good"}`} style={{ marginTop: 7 }} aria-hidden="true" />
            <div>
              <strong>{STATUS_LABEL[mod.status]}</strong>
              <p style={{ margin: "4px 0 0" }}>{mod.reason}</p>
              {mod.status === "not_live" && <p className="small muted" style={{ margin: "4px 0 0" }}>Scheduled in delivery phase {mod.phase}. No transactions can be made here yet.</p>}
            </div>
          </div>
        )}
        {children}
        <div className="panel">
          <h2 style={{ fontSize: 20 }}>What this module will do</h2>
          <ul className="checklist">
            {coming.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Mechanics, fees and risks are in the <Link to="/docs">docs</Link>. Proposed settings stay labelled as proposals until deployed.
          </p>
        </div>
      </div>
    </div>
  );
}
