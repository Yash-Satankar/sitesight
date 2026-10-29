import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { AgentStep } from "@sitesight/shared";
import { api, subscribeTrace } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { AgentTrace } from "../components/AgentTrace";
import { AskBackCard } from "../components/AskBackCard";
import { VisitSummaryCard } from "../components/VisitSummaryCard";
import { ProgressBar } from "../components/BoqTable";
import { ErrorNote, InferredBadge, StatusBadge } from "../components/Layout";

/** Left: live agent trace. Right: assessments as they land, plus ask-back cards. */
export function VisitPage() {
  const visitId = Number(useParams().visitId);
  const { data, error, reload } = useAsync(async () => {
    const visit = await api.getVisit(visitId);
    const project = await api.getProject(visit.projectId);
    return { visit, project };
  }, [visitId]);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setSteps([]);
    setCostUsd(null);
    return subscribeTrace(visitId, {
      onStep: (s) => {
        setSteps((prev) => [...prev, s]);
        if (s.kind === "tool_result" && (s.name === "record_assessment" || s.name === "request_photo")) void reload();
      },
      onStatus: (status) => {
        setLiveStatus(status);
        void reload();
      },
      onCost: setCostUsd,
    });
  }, [visitId, reload]);

  const codes = useMemo(() => new Map((data?.project.boqItems ?? []).map((b) => [b.id, b.code])), [data]);
  const itemCode = useCallback((id: number) => codes.get(id), [codes]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const { visit, project } = data;
  const itemById = new Map(project.boqItems.map((b) => [b.id, b]));
  const zoneName = (id: number) => project.zones.find((z) => z.id === id)?.name;
  const openAskBacks = visit.askBacks.filter((a) => a.status === "open");

  async function run() {
    try {
      await api.runVisit(visitId);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <Link to={`/projects/${project.id}`} className="text-sm text-gray-500 hover:underline">
            ← {project.name}
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Visit {visit.visitDate} <StatusBadge status={visit.status} />
          </h1>
        </div>
        <div className="ml-auto flex gap-2">
          <Link className="btn-secondary" to={`/visits/${visitId}/capture`}>
            Add photos
          </Link>
          {(visit.status === "draft" || visit.status === "assessed" || visit.status === "reviewed") && (
            <button className="btn-secondary" onClick={run} disabled={!visit.photos.length}>
              {visit.status === "draft" ? "Run agent" : "Re-run agent"}
            </button>
          )}
          {visit.assessments.length > 0 && (
            <Link className="btn" to={`/visits/${visitId}/review`}>
              Review
            </Link>
          )}
        </div>
      </div>
      <ErrorNote error={actionError} />
      {visit.assessments.length > 0 && visit.status !== "queued" && visit.status !== "processing" && <VisitSummaryCard visitId={visitId} summary={visit.summary} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <AgentTrace steps={steps} costUsd={costUsd} status={liveStatus ?? visit.status} itemCode={itemCode} />

        <section className="space-y-3">
          {openAskBacks.map((a) => (
            <AskBackCard
              key={a.id}
              askBack={a}
              zoneName={zoneName(a.zoneId)}
              onSkip={async () => {
                await api.skipAskBack(a.id);
                await reload();
              }}
            />
          ))}
          {visit.earlierOpenAskBacks.length > 0 && (
            <h2 className="pt-1 text-sm font-semibold text-gray-700">Still open from earlier visits</h2>
          )}
          {visit.earlierOpenAskBacks.map((a) => (
            <AskBackCard
              key={a.id}
              askBack={a}
              zoneName={zoneName(a.zoneId)}
              captureVisitId={visitId}
              fromVisitDate={a.visitDate}
              onSkip={async () => {
                await api.skipAskBack(a.id);
                await reload();
              }}
            />
          ))}
          <div className="card">
            <h2 className="mb-3 font-semibold">Assessments</h2>
            {!visit.assessments.length && <p className="text-sm text-gray-500">None yet.</p>}
            <ul className="space-y-3">
              {visit.assessments.map((a) => {
                const item = itemById.get(a.boqItemId);
                return (
                  <li key={a.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{item?.code}</span>
                      <span className="flex-1 truncate">{item?.description}</span>
                      <StatusBadge status={a.status} />
                      <InferredBadge basis={a.basis} />
                    </div>
                    <ProgressBar pct={a.percentComplete} />
                    <p className="text-xs text-gray-500">
                      confidence {(a.confidence * 100).toFixed(0)}% · {a.rationale}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="text-xs text-gray-500">{visit.photos.length} photo(s) in this visit</p>
        </section>
      </div>
    </div>
  );
}
