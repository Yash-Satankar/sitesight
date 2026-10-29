import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiUrl } from "../lib/api";
import { ErrorNote } from "../components/Layout";

export function ReportPage() {
  const visitId = Number(useParams().visitId);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="space-y-4">
      <Link to={`/visits/${visitId}/review`} className="text-sm text-gray-500 hover:underline">
        ← Review
      </Link>
      <h1 className="text-xl font-semibold">Progress report</h1>
      <p className="text-sm text-gray-600">Includes accepted and edited assessments, with evidence photos.</p>
      <div className="flex gap-2">
        <button className="btn" onClick={generate} disabled={busy}>
          {busy ? "Generating…" : url ? "Regenerate PDF" : "Generate PDF"}
        </button>
        {url && (
          <a className="btn-secondary" href={url} target="_blank" rel="noreferrer">
            Download PDF
          </a>
        )}
      </div>
      <ErrorNote error={error} />
      {url && <iframe title="Report preview" src={url} className="h-[75vh] w-full rounded-xl border border-gray-200 bg-white" />}
    </div>
  );
}
