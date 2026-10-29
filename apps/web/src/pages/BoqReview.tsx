import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FileSpreadsheet, FileText, Loader2, Save, TriangleAlert } from "lucide-react";
import type { BoqItemInput } from "@sitesight/shared";
import { api } from "../lib/api";
import { ErrorNote } from "../components/Layout";
import { BottomBar, BottomBarSpacer, TopBar } from "../components/ui";
import { BoqItemEditor, stagesProblem } from "../components/boq/BoqItemEditor";
import { DrawingImportFlow } from "../components/boq/DrawingImportFlow";

/** BOQ setup: parse a spreadsheet, or import from drawings (PDF). Either way the engineer reviews before saving. */
export function BoqReviewPage() {
  const projectId = Number(useParams().projectId);
  const [params, setParams] = useSearchParams();
  const source = params.get("source") === "drawings" || params.get("import") ? "drawings" : "spreadsheet";
  const importId = params.get("import") ? Number(params.get("import")) : null;
  const navigate = useNavigate();

  const setSource = (s: "spreadsheet" | "drawings") => setParams(s === "drawings" ? { source: "drawings" } : {}, { replace: true });

  return (
    <div className="mx-auto max-w-3xl">
      <TopBar back={`/projects/${projectId}`} title="Set up the BOQ" subtitle="Review the items, then save" />
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-200/70 p-1" role="tablist" aria-label="BOQ source">
          {(
            [
              ["spreadsheet", "Spreadsheet", FileSpreadsheet],
              ["drawings", "From drawings", FileText],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={source === key}
              onClick={() => setSource(key)}
              className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-2 text-sm font-semibold transition-colors ${
                source === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        {source === "drawings" ? (
          <DrawingImportFlow
            projectId={projectId}
            importId={importId}
            setImportId={(id) => setParams(id ? { source: "drawings", import: String(id) } : { source: "drawings" }, { replace: true })}
            onSaved={() => navigate(`/projects/${projectId}`)}
          />
        ) : (
          <SpreadsheetFlow projectId={projectId} onSaved={() => navigate(`/projects/${projectId}`)} />
        )}
      </div>
    </div>
  );
}

function SpreadsheetFlow({ projectId, onSaved }: { projectId: number; onSaved: () => void }) {
  const [items, setItems] = useState<BoqItemInput[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.parseBoq(projectId, file);
      setItems(res.items);
      setWarnings(res.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!items) return;
    setBusy(true);
    try {
      await api.saveBoq(projectId, items);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<BoqItemInput>) => setItems((prev) => prev && prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const badStages = items?.filter((it) => stagesProblem(it.stages)) ?? [];

  return (
    <div className="space-y-5">
      <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent/50 bg-accent-soft px-4 py-5 text-center text-accent-strong">
        {busy && !items ? <Loader2 className="h-8 w-8 animate-spin" aria-hidden /> : <FileSpreadsheet className="h-8 w-8" aria-hidden />}
        <span className="text-base font-bold">{busy && !items ? "Parsing the BOQ…" : fileName ? fileName : "Choose the BOQ spreadsheet (.xlsx)"}</span>
        <span className="text-sm text-slate-700">Muse Spark reads it into line items you can check below.</span>
        <input
          type="file"
          accept=".xlsx"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFileName(f.name);
            void onFile(f);
          }}
        />
      </label>
      <ErrorNote error={error} />
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-2xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}

      {items && (
        <ul className="space-y-3">
          {items.map((it, i) => (
            <BoqItemEditor key={i} item={it} onChange={(patch) => update(i, patch)} />
          ))}
        </ul>
      )}

      {items && (
        <>
          <BottomBarSpacer />
          <BottomBar>
            <div className="min-w-0 flex-1">
              {badStages.length > 0 && <p className="mb-2 text-sm font-medium text-amber-900">Fix the stages of {badStages.map((i) => i.code).join(", ")}</p>}
              <button className="btn w-full" onClick={save} disabled={busy || badStages.length > 0}>
                <Save className="h-5 w-5" aria-hidden /> Save {items.length} items
              </button>
            </div>
          </BottomBar>
        </>
      )}
    </div>
  );
}
