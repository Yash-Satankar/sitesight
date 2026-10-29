import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Maximize2, Minimize2, Save, Trash2, TriangleAlert, X } from "lucide-react";
import type { BoqItemInput, DrawingImport, DrawingPage, DrawingSource, ProposedBoqItem, SheetType } from "@sitesight/shared";
import { api, apiUrl } from "../../lib/api";
import { ErrorNote } from "../Layout";
import { BottomBar, BottomBarSpacer, Chip, ProgressBar, type Tone } from "../ui";
import { BoqItemEditor, stagesProblem } from "./BoqItemEditor";

const SHEET_LABEL: Record<SheetType, string> = {
  column_layout: "Column layout",
  footing_layout: "Footing layout",
  footing_column_schedule: "Footing / column schedule",
  plinth_beam: "Plinth beams",
  slab_plan: "Slab plan",
  beam_schedule: "Beam schedule",
  floor_plan: "Floor plan",
  electrical: "Electrical",
  drainage: "Drainage",
  door_window: "Doors & windows",
  other: "Other sheet",
};
const STRUCTURAL = new Set<SheetType>(["column_layout", "footing_layout", "footing_column_schedule", "plinth_beam", "slab_plan", "beam_schedule"]);

function pageStatus(p: DrawingPage, running: boolean): { tone: Tone; label: string } {
  switch (p.status) {
    case "extracted":
      return { tone: "done", label: "Read" };
    case "skipped":
      return { tone: "neutral", label: "Not structural" };
    case "failed":
      return { tone: "error", label: "Couldn't read" };
    case "classified":
      return p.sheetType && STRUCTURAL.has(p.sheetType) ? (running ? { tone: "busy", label: "Reading values…" } : { tone: "neutral", label: "Not read" }) : { tone: "neutral", label: "Sorted" };
    default:
      return running ? { tone: "busy", label: "Sorting…" } : { tone: "neutral", label: "Not read" };
  }
}

type Editable = ProposedBoqItem & { proposedQty: number };

/**
 * BOQ from drawings: upload a PDF → follow each page being sorted and read → review the proposed items (source page,
 * evidence, confidence, discrepancies) and save. `importId` lives in the URL so a reload resumes.
 */
export function DrawingImportFlow({
  projectId,
  importId,
  setImportId,
  onSaved,
}: {
  projectId: number;
  importId: number | null;
  setImportId: (id: number | null) => void;
  onSaved: () => void;
}) {
  const [imp, setImp] = useState<DrawingImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Editable[] | null>(null);
  const [viewer, setViewer] = useState<{ page: DrawingPage; evidence: DrawingSource[] } | null>(null);
  const loadedFor = useRef<number | null>(null);

  const running = imp?.status === "queued" || imp?.status === "processing";

  // Load, then poll while the worker reads the pages.
  useEffect(() => {
    if (importId == null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await api.getDrawingImport(projectId, importId);
        if (stop) return;
        setImp(next);
        setError(null);
        if (next.status === "queued" || next.status === "processing") timer = setTimeout(tick, 1500);
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [projectId, importId]);

  // The proposal becomes the editable list once (edits survive later polls).
  useEffect(() => {
    if (imp?.proposal && loadedFor.current !== imp.id) {
      loadedFor.current = imp.id;
      setItems(imp.proposal.items.map((it) => ({ ...it, proposedQty: it.plannedQty })));
    }
  }, [imp]);

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.uploadDrawings(projectId, file);
      setImp(created);
      setItems(null);
      loadedFor.current = null;
      setImportId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const update = (key: string, patch: Partial<BoqItemInput>) => setItems((prev) => prev && prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  const missingQty = items?.filter((it) => it.needsInput && !(it.plannedQty > 0)) ?? [];
  const badStages = items?.filter((it) => stagesProblem(it.stages)) ?? [];
  const blocker = missingQty.length
    ? `Enter a quantity for ${missingQty.map((i) => i.code).join(", ")}`
    : badStages.length
      ? `Fix the stages of ${badStages.map((i) => i.code).join(", ")}`
      : null;

  async function save() {
    if (!items || blocker) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveBoq(projectId, items.map(toBoqInput));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const pageByNo = new Map((imp?.pages ?? []).map((p) => [p.pageNo, p]));
  const done = imp?.pages.filter((p) => p.status === "extracted" || p.status === "skipped" || p.status === "failed").length ?? 0;

  if (importId == null || !imp) {
    return (
      <div className="space-y-4">
        <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent/50 bg-accent-soft px-4 py-6 text-center text-accent-strong">
          {busy || importId != null ? <Loader2 className="h-8 w-8 animate-spin" aria-hidden /> : <FileText className="h-8 w-8" aria-hidden />}
          <span className="text-base font-bold">{busy ? "Preparing the pages…" : importId != null ? "Loading…" : "Choose the drawing set (PDF)"}</span>
          <span className="text-sm text-slate-700">Architectural and structural sheets, up to 25 MB. Muse Spark sorts the sheets and reads the schedules and layouts.</span>
          <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        <ErrorNote error={error} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ErrorNote error={error ?? imp.error} />

      <section className="card space-y-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold">{imp.fileName}</h2>
            <p className="num text-sm text-slate-600">
              {done} of {imp.pages.length} pages · ${imp.costUsd.toFixed(2)} of ${imp.costLimitUsd.toFixed(2)} cap
            </p>
          </div>
          {running ? <Chip tone="busy">Reading</Chip> : imp.status === "done" ? <Chip tone="done">Done</Chip> : imp.status === "cost_limit" ? <Chip tone="attention">Cost cap reached</Chip> : <Chip tone="error">Failed</Chip>}
        </div>
        <ProgressBar pct={imp.pages.length ? (done / imp.pages.length) * 100 : 0} tone={running ? "busy" : "done"} />
        <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
          {imp.pages.map((p) => {
            const s = pageStatus(p, running);
            return (
              <li key={p.id} className="w-32 shrink-0">
                <button type="button" className="block w-full text-left" onClick={() => setViewer({ page: p, evidence: [] })} aria-label={`Open page ${p.pageNo}`}>
                  <img src={apiUrl(p.thumbUrl)} alt="" loading="lazy" className="aspect-[4/3] w-full rounded-lg border border-slate-200 bg-white object-contain" />
                  <p className="mt-1 truncate text-xs font-semibold">
                    p.{p.pageNo} · {p.sheetType ? SHEET_LABEL[p.sheetType] : "…"}
                  </p>
                </button>
                <div className="mt-1">
                  <Chip tone={s.tone}>{s.label}</Chip>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {imp.proposal && imp.proposal.discrepancies.length > 0 && (
        <section className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4">
          <h2 className="flex items-center gap-2 text-base font-bold text-amber-950">
            <TriangleAlert className="h-5 w-5 text-amber-700" aria-hidden /> Drawing discrepancies
          </h2>
          <p className="mt-1 text-sm text-amber-950">The sheets disagree. Check the drawings and enter the right quantity below.</p>
          <ul className="mt-2 space-y-1.5">
            {imp.proposal.discrepancies.map((d, i) => (
              <li key={i} className="text-sm text-amber-950">
                <span className="font-semibold">{d.message}</span>{" "}
                {[d.schedulePage, d.layoutPage].map((n) => {
                  const pg = pageByNo.get(n);
                  return pg ? (
                    <button key={n} type="button" className="mr-2 underline" onClick={() => setViewer({ page: pg, evidence: [] })}>
                      open p.{n}
                    </button>
                  ) : null;
                })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {imp.proposal && imp.proposal.warnings.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">
            {imp.proposal.warnings.length} note{imp.proposal.warnings.length === 1 ? "" : "s"} from reading the drawings
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {imp.proposal.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {items && (
        <section className="space-y-3">
          <h2 className="text-base font-bold">
            Proposed BOQ <span className="num font-normal text-slate-600">· {items.length} item{items.length === 1 ? "" : "s"}</span>
          </h2>
          {!items.length && <p className="text-sm text-slate-600">No structural quantities could be read from these drawings.</p>}
          <ul className="space-y-3">
            {items.map((it) => {
              const pages = [...new Map(it.sources.map((s) => [s.page, s])).keys()];
              return (
                <BoqItemEditor
                  key={it.key}
                  item={it}
                  onChange={(patch) => update(it.key, patch)}
                  highlightQty={!!it.needsInput && !(it.plannedQty > 0)}
                  className={it.needsInput ? "border-amber-300" : ""}
                  header={
                    <div className="space-y-2">
                      <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 text-[15px] leading-snug">
                          <span className="mr-1.5 font-mono text-xs font-semibold text-slate-600">{it.code}</span>
                          {it.description}
                        </p>
                        <button type="button" className="btn-ghost -mt-2 -mr-2 text-slate-500" aria-label={`Remove ${it.code}`} onClick={() => setItems((prev) => prev && prev.filter((x) => x.key !== it.key))}>
                          <Trash2 className="h-5 w-5" />
                        </button>
                      </div>
                      {it.needsInput && (
                        <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950">
                          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                          <span>
                            <span className="font-semibold">Needs input:</span> {it.needsInput}
                          </span>
                        </p>
                      )}
                      <div>
                        <div className="mb-1 flex justify-between text-xs font-semibold text-slate-600">
                          <span>Read from the drawings with confidence</span>
                          <span className="num">{Math.round(it.confidence * 100)}%</span>
                        </div>
                        <ProgressBar pct={it.confidence * 100} tone={it.confidence < 0.6 ? "attention" : "neutral"} />
                      </div>
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {pages.map((n) => {
                          const pg = pageByNo.get(n);
                          if (!pg) return null;
                          return (
                            <button
                              key={n}
                              type="button"
                              className="w-28 shrink-0 text-left"
                              onClick={() => setViewer({ page: pg, evidence: it.sources.filter((s) => s.page === n) })}
                              aria-label={`Open page ${n} with the evidence`}
                            >
                              <img src={apiUrl(pg.thumbUrl)} alt="" loading="lazy" className="aspect-[4/3] w-full rounded-lg border border-slate-200 bg-white object-contain" />
                              <span className="mt-0.5 block truncate text-xs font-medium text-slate-700">
                                p.{n} · {pg.sheetType ? SHEET_LABEL[pg.sheetType] : ""}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  }
                />
              );
            })}
          </ul>
        </section>
      )}

      {items && (
        <>
          <BottomBarSpacer />
          <BottomBar>
            <div className="min-w-0 flex-1">
              {blocker && <p className="mb-2 text-sm font-medium text-amber-900">{blocker}</p>}
              <button className="btn w-full" onClick={save} disabled={busy || !!blocker || !items.length}>
                <Save className="h-5 w-5" aria-hidden /> {busy ? "Saving…" : `Save BOQ (${items.length} items)`}
              </button>
            </div>
          </BottomBar>
        </>
      )}

      {viewer && <PageViewer page={viewer.page} evidence={viewer.evidence} onClose={() => setViewer(null)} />}
    </div>
  );
}

/** What the saved BOQ item says about its source: the drawings, or the engineer when they changed or filled the qty. */
function toBoqInput(it: Editable): BoqItemInput {
  const changed = it.needsInput || it.plannedQty !== it.proposedQty;
  const drawingSource = changed
    ? `${it.plannedQty} ${it.unit} entered by the engineer (drawings: ${it.needsInput ?? it.drawingSource ?? "—"})`.slice(0, 500)
    : it.drawingSource;
  return {
    zoneId: it.zoneId,
    code: it.code,
    description: it.description,
    unit: it.unit,
    plannedQty: it.plannedQty,
    measureMode: it.measureMode,
    segmentTargets: it.segmentTargets,
    panelPlannedQty: it.panelPlannedQty,
    stages: it.stages,
    sequenceNo: it.sequenceNo,
    drawingSource,
  };
}

/** Full-screen page image (fit or actual size) with the evidence read from it. */
function PageViewer({ page, evidence, onClose }: { page: DrawingPage; evidence: DrawingSource[]; onClose: () => void }) {
  const [actual, setActual] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 text-white" role="dialog" aria-modal="true" aria-label={`Page ${page.pageNo}`}>
      <div className="flex min-h-14 items-center gap-2 px-3">
        <p className="min-w-0 flex-1 truncate font-semibold">
          p.{page.pageNo} · {page.titleGuess ?? (page.sheetType ? SHEET_LABEL[page.sheetType] : "Drawing")}
        </p>
        <button type="button" className="btn-ghost text-white hover:bg-white/10" onClick={() => setActual((v) => !v)} aria-label={actual ? "Fit to screen" : "Actual size"}>
          {actual ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
        </button>
        <button type="button" className="btn-ghost text-white hover:bg-white/10" onClick={onClose} aria-label="Close">
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-white">
        <img src={apiUrl(page.imageUrl)} alt={`Page ${page.pageNo}`} className={actual ? "max-w-none" : "mx-auto h-full w-full object-contain"} style={actual ? { width: page.width } : undefined} />
      </div>
      {evidence.length > 0 && (
        <div className="max-h-[35vh] overflow-y-auto border-t border-white/10 px-4 py-3">
          <p className="text-xs font-semibold tracking-wide text-slate-300 uppercase">Read on this page</p>
          <ul className="mt-1 space-y-1.5">
            {evidence.map((e, i) => (
              <li key={i} className="text-sm">
                “{e.evidence_text}” <span className="num text-slate-400">· {Math.round(e.confidence * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
