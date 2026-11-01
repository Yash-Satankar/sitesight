import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Camera, ClipboardCheck, Play, RotateCcw } from "lucide-react";
import type { AgentStep } from "@sitesight/shared";
import { api, subscribeTrace } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { AgentTrace } from "../components/AgentTrace";
import { AskBackCard } from "../components/AskBackCard";
import { VisitSummaryCard } from "../components/VisitSummaryCard";
import { AssessmentChip } from "../components/AssessmentChip";
import { ErrorNote } from "../components/Layout";
import { BottomBar, BottomBarSpacer, Loading, ProgressBar, SectionTitle, TopBar, VisitStatusChip, capitalize, fmtDate, fmtQty, photoLabel } from "../components/ui";

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
  const photoIds = useMemo(() => (data?.visit.photos ?? []).map((p) => p.id), [data]);
  const photoName = useCallback((id: number) => photoLabel(photoIds, id).toLowerCase(), [photoIds]);

  if (error) return <div className="pt-4"><ErrorNote error={error} /></div>;
  if (!data) return <Loading />;
  const { visit, project } = data;
  const itemById = new Map(project.boqItems.map((b) => [b.id, b]));
  const zoneName = (id: number) => project.zones.find((z) => z.id === id)?.name;
  const openAskBacks = visit.askBacks.filter((a) => a.status === "open");
  const awaitingItems = new Set([...openAskBacks, ...visit.earlierOpenAskBacks].map((a) => a.boqItemId));
  const status = liveStatus ?? visit.status;
  const busy = status === "queued" || status === "processing";
  const canRun =
    visit.status === "draft" || visit.status === "assessed" || visit.status === "reviewed" || (visit.status === "needs_input" && openAskBacks.length === 0);
  const toReview = visit.assessments.filter((a) => a.status === "proposed").length;

  async function run() {
    try {
      await api.runVisit(visitId);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <TopBar
        back={`/projects/${project.id}`}
        title={project.name}
        subtitle={
          <>
            <span className="num shrink-0">Visit · {fmtDate(visit.visitDate)}</span>
            <VisitStatusChip status={status} />
          </>
        }
        right={
          <Link className="btn-ghost" to={`/visits/${visitId}/capture`} aria-label="Add photos">
            <Camera className="h-6 w-6" />
          </Link>
        }
      />
      <div className="space-y-5">
        <ErrorNote error={actionError} />
        {visit.assessments.length > 0 && !busy && <VisitSummaryCard visitId={visitId} summary={visit.summary} />}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <AgentTrace steps={steps} costUsd={costUsd} status={status} itemCode={itemCode} photoName={photoName} />

          <div className="min-w-0 space-y-4">
            {openAskBacks.map((a) => (
              <AskBackCard
                key={a.id}
                askBack={a}
                zoneName={zoneName(a.zoneId)}
                itemCode={a.boqItemId != null ? itemById.get(a.boqItemId)?.code : undefined}
                onSkip={async () => {
                  await api.skipAskBack(a.id);
                  await reload();
                }}
              />
            ))}
            {visit.earlierOpenAskBacks.length > 0 && <h2 className="eyebrow pt-1">Still open from earlier visits</h2>}
            {visit.earlierOpenAskBacks.map((a) => (
              <AskBackCard
                key={a.id}
                askBack={a}
                zoneName={zoneName(a.zoneId)}
                itemCode={a.boqItemId != null ? itemById.get(a.boqItemId)?.code : undefined}
                captureVisitId={visitId}
                fromVisitDate={a.visitDate}
                onSkip={async () => {
                  await api.skipAskBack(a.id);
                  await reload();
                }}
              />
            ))}

            <section className="card">
              <SectionTitle right={<span className="num text-sm text-slate-600">{visit.photos.length} photo{visit.photos.length === 1 ? "" : "s"}</span>}>
                Assessments
              </SectionTitle>
              {!visit.assessments.length && (
                <p className="text-sm text-slate-600">{busy ? "They appear here as the agent records them." : "None yet. Run the agent to assess this visit."}</p>
              )}
              <ul className="divide-y divide-slate-100">
                {visit.assessments.map((a) => {
                  const item = itemById.get(a.boqItemId);
                  return (
                    <li key={a.id} className="py-3 first:pt-1 last:pb-1">
                      <div className="flex items-start gap-3">
                        <p className="min-w-0 flex-1 text-[15px] leading-snug">
                          <span className="mr-1.5 font-mono text-xs font-semibold text-slate-600">{item?.code}</span>
                          {item?.description}
                        </p>
                        <span className="num shrink-0 text-2xl leading-none font-bold">{Math.round(a.percentComplete)}%</span>
                      </div>
                      <ProgressBar pct={a.percentComplete} tone={a.basis === "inferred" ? "attention" : "done"} className="mt-2" />
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <AssessmentChip assessment={a} awaitingPhoto={awaitingItems.has(a.boqItemId)} />
                        <span className="num text-xs text-slate-600">
                          {a.stageReached ? `${capitalize(a.stageReached)} stage · ` : ""}
                          {a.qtyDone != null ? `${fmtQty(a.qtyDone)} ${item?.unit ?? ""} · ` : ""}
                          confidence {Math.round(a.confidence * 100)}%
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </div>

        <BottomBarSpacer />
        <BottomBar>
          {canRun && visit.photos.length > 0 && visit.assessments.length > 0 && (
            <button className="btn-secondary shrink-0 px-3" onClick={run} aria-label="Re-run agent">
              <RotateCcw className="h-5 w-5" aria-hidden />
              <span className="hidden sm:inline">Re-run agent</span>
            </button>
          )}
          {visit.assessments.length > 0 ? (
            <Link className="btn flex-1" to={`/visits/${visitId}/review`}>
              <ClipboardCheck className="h-5 w-5" aria-hidden />
              {toReview ? `Review ${toReview} assessment${toReview === 1 ? "" : "s"}` : "Open review"}
            </Link>
          ) : visit.photos.length === 0 ? (
            <Link className="btn flex-1" to={`/visits/${visitId}/capture`}>
              <Camera className="h-5 w-5" aria-hidden /> Add photos
            </Link>
          ) : (
            <button className="btn flex-1" onClick={run} disabled={!canRun || busy}>
              <Play className="h-5 w-5" aria-hidden /> {busy ? "Agent running…" : "Run agent"}
            </button>
          )}
        </BottomBar>
      </div>
    </div>
  );
}
