import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Unit, type BoqItemInput } from "@sitesight/shared";
import { api } from "../lib/api";
import { FileSpreadsheet, Loader2, Save, TriangleAlert } from "lucide-react";
import { ErrorNote } from "../components/Layout";
import { BottomBar, BottomBarSpacer, TopBar } from "../components/ui";

// Only columns (count) and brickwork (area) can be measured from photos; the API rejects other combinations.
const MEASURED_AS = {
  visual_only: { label: "Visual check only", patch: { measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null } },
  column: { label: "Count columns", patch: { measureMode: "count", segmentTargets: ["column"], panelPlannedQty: null, stages: null } },
  brickwork: { label: "Area of brickwork", patch: { measureMode: "area", segmentTargets: ["brickwork"], stages: null } },
} satisfies Record<string, { label: string; patch: Pick<BoqItemInput, "measureMode" | "segmentTargets"> & Partial<BoqItemInput> }>;

function measuredAs(it: BoqItemInput): keyof typeof MEASURED_AS {
  if (it.measureMode === "count" && it.segmentTargets.includes("column")) return "column";
  if (it.measureMode === "area" && it.segmentTargets.includes("brickwork")) return "brickwork";
  return "visual_only";
}

export function BoqReviewPage() {
  const projectId = Number(useParams().projectId);
  const [items, setItems] = useState<BoqItemInput[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
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
      navigate(`/projects/${projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<BoqItemInput>) =>
    setItems((prev) => prev && prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  return (
    <div className="mx-auto max-w-3xl">
      <TopBar back={`/projects/${projectId}`} title="Upload BOQ" subtitle="Check the parsed items, then save" />
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
              <li key={i} className="card space-y-3">
                <p className="text-[15px] leading-snug">
                  <span className="mr-1.5 font-mono text-xs font-semibold text-slate-600">{it.code}</span>
                  {it.description}
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <label className="block text-xs font-semibold text-slate-600">
                    Planned qty
                    <input className="input num mt-1" type="number" inputMode="decimal" min={0} value={it.plannedQty} onChange={(e) => update(i, { plannedQty: Number(e.target.value) })} />
                  </label>
                  <label className="block text-xs font-semibold text-slate-600">
                    Unit
                    <select className="input mt-1" value={it.unit} onChange={(e) => update(i, { unit: e.target.value as Unit })}>
                      {Unit.options.map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                  </label>
                  <label className="col-span-2 block text-xs font-semibold text-slate-600">
                    Measured as
                    <select className="input mt-1" value={measuredAs(it)} onChange={(e) => update(i, MEASURED_AS[e.target.value as keyof typeof MEASURED_AS].patch)}>
                      {Object.entries(MEASURED_AS).map(([key, opt]) => (
                        <option key={key} value={key}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {it.measureMode === "area" && (
                    <label className="col-span-2 block text-xs font-semibold text-slate-600" title="Planned quantity inside one photographed panel, e.g. one brick bay between two columns">
                      Qty in one bay (optional)
                      <input
                        className="input num mt-1"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        placeholder="optional"
                        value={it.panelPlannedQty ?? ""}
                        onChange={(e) => update(i, { panelPlannedQty: e.target.value === "" ? null : Number(e.target.value) })}
                      />
                    </label>
                  )}
                </div>
                {it.stages?.length ? (
                  <p className="num text-xs text-slate-600">
                    <span className="font-semibold">Stages:</span> {it.stages.map((s) => `${s.name} ${Math.round(s.weight * 100)}%`).join(" → ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {items && (
          <>
            <BottomBarSpacer />
            <BottomBar>
              <button className="btn flex-1" onClick={save} disabled={busy}>
                <Save className="h-5 w-5" aria-hidden /> Save {items.length} items
              </button>
            </BottomBar>
          </>
        )}
      </div>
    </div>
  );
}
