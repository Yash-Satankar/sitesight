import { useState } from "react";
import { Link } from "react-router-dom";
import type { VisitProgress } from "@sitesight/shared";
import { api, apiUrl } from "../lib/api";

/** Top-of-page summary once a visit is assessed: item counts, change since the last visit, report download. */
export function VisitSummaryCard({ visitId, summary }: { visitId: number; summary: VisitProgress }) {
  const [busy, setBusy] = useState(false);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Visit summary</h2>
        <div className="ml-auto flex items-center gap-2">
          {reportUrl ? (
            <a className="btn" href={reportUrl} target="_blank" rel="noreferrer">
              Open report (PDF)
            </a>
          ) : (
            <button className="btn" onClick={makeReport} disabled={busy}>
              {busy ? "Building report…" : "Download report"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="text-sm text-red-700">
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

      <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        <Stat label="assessed" value={summary.assessed} tone="text-green-700" />
        <Stat label="inferred" value={summary.inferred} tone="text-violet-700" />
        <Stat label="awaiting photo" value={summary.awaitingPhoto} tone="text-sky-700" />
        <Stat label="not assessed" value={summary.notAssessed} tone="text-gray-600" />
      </dl>
      <p className="text-xs text-gray-500">of {summary.totalItems} BOQ items · inferred items are not billed</p>

      {summary.previousVisit ? (
        <div>
          <h3 className="text-sm font-medium">
            Since last visit <span className="font-normal text-gray-500">({summary.previousVisit.visitDate})</span>
          </h3>
          <p className="text-xs text-gray-600">
            {advanced} advanced · {fresh} newly assessed · {backwards} went backwards
          </p>
          {changed.length > 0 && (
            <ul className="mt-2 divide-y divide-gray-100 text-sm">
              {changed.map((r) => (
                <li key={r.code} className="flex flex-wrap items-baseline gap-x-2 py-1">
                  <span className="font-mono text-xs">{r.code}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-700">{r.description}</span>
                  <span className="text-xs text-gray-500">
                    {r.previous} → {r.now}
                  </span>
                  <span className={`text-xs font-medium ${(r.delta ?? 0) < -0.5 ? "text-red-700" : (r.delta ?? 0) > 0.5 ? "text-green-700" : "text-gray-600"}`}>
                    {r.change}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-500">First assessed visit of this project: no earlier visit to compare with.</p>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-2 py-2">
      <dd className={`text-2xl font-semibold ${tone}`}>{value}</dd>
      <dt className="text-xs text-gray-500">{label}</dt>
    </div>
  );
}
