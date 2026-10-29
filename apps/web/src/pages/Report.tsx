import { useState } from "react";
import { useParams } from "react-router-dom";
import { Download, FileText, RefreshCw } from "lucide-react";
import { api, apiUrl } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorNote } from "../components/Layout";
import { VisitSummaryCard } from "../components/VisitSummaryCard";
import { BottomBar, BottomBarSpacer, Chip, SectionTitle, TopBar, capitalize, fmtDate, fmtQty } from "../components/ui";

export function ReportPage() {
  const visitId = Number(useParams().visitId);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Preview of what goes into the report (same calls as the visit page).
  const { data } = useAsync(async () => {
    const visit = await api.getVisit(visitId);
    const project = await api.getProject(visit.projectId);
    return { visit, project };
  }, [visitId]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setUrl(apiUrl((await api.createReport(visitId)).downloadUrl));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const items = data?.project.boqItems ?? [];
  const included = data?.visit.assessments.filter((a) => a.status !== "proposed") ?? [];
  const notYet = (data?.visit.assessments.length ?? 0) - included.length;

  return (
    <div className="mx-auto max-w-3xl">
      <TopBar
        back={`/visits/${visitId}/review`}
        title="Progress report"
        subtitle={data ? <span className="num truncate">{data.project.name} · {fmtDate(data.visit.visitDate)}</span> : undefined}
      />
      <div className="space-y-5">
        <p className="text-sm text-slate-700">The PDF includes accepted and edited assessments with their evidence photos. Inferred items are listed but not billed.</p>
        <ErrorNote error={error} />

        {data && data.visit.assessments.length > 0 && <VisitSummaryCard visitId={visitId} summary={data.visit.summary} showDownload={false} />}

        {data && (
          <section className="card">
            <SectionTitle right={<span className="num text-sm text-slate-600">{included.length} item{included.length === 1 ? "" : "s"}</span>}>In the report</SectionTitle>
            {included.length ? (
              <ul className="divide-y divide-slate-100">
                {included.map((a) => {
                  const item = items.find((b) => b.id === a.boqItemId);
                  return (
                    <li key={a.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          <span className="mr-1.5 font-mono text-xs font-semibold text-slate-600">{item?.code}</span>
                          {item?.description}
                        </p>
                        <p className="num text-xs text-slate-600">
                          {a.stageReached ? `${capitalize(a.stageReached)} stage · ` : ""}
                          {a.qtyDone != null ? `${fmtQty(a.qtyDone)} / ${fmtQty(item?.plannedQty)} ${item?.unit}` : "no quantity"}
                        </p>
                        {a.basis === "inferred" && (
                          <div className="mt-1">
                            <Chip tone="attention">Inferred — not billable</Chip>
                          </div>
                        )}
                      </div>
                      <span className="num shrink-0 text-xl font-bold">{Math.round(a.percentComplete)}%</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-slate-600">Nothing accepted yet. Accept or edit assessments on the review screen first.</p>
            )}
            {notYet > 0 && <p className="num mt-2 text-sm text-slate-600">{notYet} assessment{notYet === 1 ? "" : "s"} still to review won't be included.</p>}
          </section>
        )}

        {url && <iframe title="Report preview" src={url} className="hidden h-[75vh] w-full rounded-2xl border border-slate-200 bg-white md:block" />}

        <BottomBarSpacer />
        <BottomBar>
          {url ? (
            <>
              <button className="btn-secondary shrink-0 px-3" onClick={generate} disabled={busy} aria-label="Regenerate PDF">
                <RefreshCw className={`h-5 w-5 ${busy ? "animate-spin" : ""}`} aria-hidden />
              </button>
              <a className="btn flex-1" href={url} target="_blank" rel="noreferrer">
                <Download className="h-5 w-5" aria-hidden /> Download PDF
              </a>
            </>
          ) : (
            <button className="btn flex-1" onClick={generate} disabled={busy}>
              <FileText className="h-5 w-5" aria-hidden /> {busy ? "Generating…" : "Generate PDF"}
            </button>
          )}
        </BottomBar>
      </div>
    </div>
  );
}
