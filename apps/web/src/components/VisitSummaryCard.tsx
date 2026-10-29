import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ArrowDownRight, ArrowUpRight, Camera, CheckCircle2, CircleDashed, Download, FileText, Minus, Sparkles, TriangleAlert, type LucideIcon } from "lucide-react";
import type { VisitProgress } from "@sitesight/shared";
import { api, apiUrl } from "../lib/api";
import { TONE, fmtDate, type Tone } from "./ui";

/** Top-of-page summary once a visit is assessed: item counts, change since the last visit, report download. */
export function VisitSummaryCard({ visitId, summary, showDownload = true }: { visitId: number; summary: VisitProgress; showDownload?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);

  async function makeReport() {
    setBusy(true);
    setError(null);
    try {
      setReportUrl(apiUrl((await api.createReport(visitId)).downloadUrl));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const changed = summary.sinceLastVisit.filter((r) => r.change !== "—" && r.change !== "no change");
  const advanced = changed.filter((r) => (r.delta ?? 0) > 0.5).length;
  const backwards = changed.filter((r) => (r.delta ?? 0) < -0.5).length;
  const fresh = changed.filter((r) => r.change === "new").length;

  return (
    <section className="card space-y-4">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-bold">Visit summary</h2>
        <span className="num text-sm text-slate-600">{summary.totalItems} BOQ items</span>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat icon={CheckCircle2} tone="done" label="Assessed" value={summary.assessed} />
        <Stat icon={TriangleAlert} tone="attention" label="Inferred" hint="not billable" value={summary.inferred} />
        <Stat icon={Camera} tone="waiting" label="Awaiting photo" value={summary.awaitingPhoto} />
        <Stat icon={CircleDashed} tone="neutral" label="Not assessed" value={summary.notAssessed} />
      </dl>

      {summary.previousVisit ? (
        <div>
          <h3 className="text-sm font-bold">
            Since last visit <span className="num font-normal text-slate-600">· {fmtDate(summary.previousVisit.visitDate)}</span>
          </h3>
          <p className="num mt-0.5 text-sm text-slate-700">
            <strong>{advanced}</strong> advanced · <strong>{fresh}</strong> newly assessed ·{" "}
            <strong className={backwards ? "text-red-800" : ""}>{backwards}</strong> went backwards
          </p>
          {changed.length > 0 && (
            <button
              type="button"
              className="mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent"
              onClick={() => setShowChanges((v) => !v)}
              aria-expanded={showChanges}
            >
              {showChanges ? "Hide changes" : `Show ${changed.length} change${changed.length === 1 ? "" : "s"}`}
              <ChevronDown className={`h-4 w-4 transition-transform ${showChanges ? "rotate-180" : ""}`} aria-hidden />
            </button>
          )}
          {changed.length > 0 && showChanges && (
            <ul className="divide-y divide-slate-100">
              {changed.map((r) => {
                const d = r.delta ?? 0;
                const tone: Tone = d < -0.5 ? "error" : d > 0.5 ? "done" : r.change === "new" ? "busy" : "neutral";
                const quiet = tone === "neutral";
                const isNew = r.change === "new";
                const Icon = d < -0.5 ? ArrowDownRight : d > 0.5 ? ArrowUpRight : isNew ? Sparkles : Minus;
                return (
                  <li key={r.code} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        <span className="mr-1.5 font-mono text-xs font-semibold text-slate-600">{r.code}</span>
                        {r.description}
                      </p>
                      <p className="num truncate text-xs text-slate-600">
                        {r.previous} → {r.now}
                      </p>
                    </div>
                    <span className={`num inline-flex shrink-0 items-center gap-1 text-sm ${quiet ? "font-medium text-slate-500" : `font-bold ${TONE[tone].text}`}`}>
                      <Icon className="h-4 w-4" aria-hidden />
                      {d > 0.5 ? `+${Math.round(d)}` : d < -0.5 ? `${Math.round(d)}` : isNew ? "New" : "Not seen"}
                      {Math.abs(d) > 0.5 && <span className="text-xs font-semibold">pts</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-600">First assessed visit of this project — nothing earlier to compare with.</p>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-900">
          {error}
          {/accept or edit/i.test(error) && (
            <>
              {" "}
              <Link className="underline" to={`/visits/${visitId}/review`}>
                Go to review
              </Link>
            </>
          )}
        </p>
      )}
      {!showDownload ? null : reportUrl ? (
        <a className="btn-secondary w-full" href={reportUrl} target="_blank" rel="noreferrer">
          <FileText className="h-5 w-5" aria-hidden /> Open report (PDF)
        </a>
      ) : (
        <button className="btn-secondary w-full" onClick={makeReport} disabled={busy}>
          <Download className="h-5 w-5" aria-hidden /> {busy ? "Building report…" : "Download report"}
        </button>
      )}
    </section>
  );
}

function Stat({ icon: Icon, tone, label, hint, value }: { icon: LucideIcon; tone: Tone; label: string; hint?: string; value: number }) {
  const t = TONE[tone];
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${value ? `${t.border} ${t.soft}` : "border-slate-200 bg-white"}`}>
      <dd className={`num text-3xl leading-none font-bold ${value ? t.text : "text-slate-400"}`}>{value}</dd>
      <dt className={`mt-1.5 flex items-center gap-1 text-xs font-semibold ${value ? t.text : "text-slate-500"}`}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {label}
          {hint && <span className="font-normal"> · {hint}</span>}
        </span>
      </dt>
    </div>
  );
}
