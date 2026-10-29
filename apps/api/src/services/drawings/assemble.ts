/**
 * Code, not the model: extracted sheet data → proposed BOQ items.
 * Quantities come only from the drawings. Anything the drawings do not support, or contradict (schedule vs layout
 * counts), becomes "needs input" with plannedQty 0 for the engineer to fill in.
 */
import type { BoqProposal, BoqStage, DrawingDiscrepancy, DrawingSource, PageClassification, ProposedBoqItem, SheetExtraction } from "@sitesight/shared";

export const DEFAULT_SLAB_STAGES: BoqStage[] = [
  { name: "shuttering", weight: 0.25 },
  { name: "reinforcement", weight: 0.35 },
  { name: "concreting", weight: 0.4 },
];

export interface AssembleInput {
  pageNo: number;
  classification: PageClassification | null;
  extraction: SheetExtraction | null;
}

const FLOOR_NAMES: [RegExp, string, string][] = [
  [/^(gf|g\.?f\.?|ground( floor)?|plinth)$/i, "GF", "ground floor"],
  [/^(ff|f\.?f\.?|first( floor)?|1st( floor)?)$/i, "FF", "first floor"],
  [/^(sf|s\.?f\.?|second( floor)?|2nd( floor)?)$/i, "SF", "second floor"],
  [/^(tf|t\.?f\.?|third( floor)?|3rd( floor)?)$/i, "TF", "third floor"],
  [/^(roof|terrace)( slab| level)?$/i, "RF", "roof"],
];

/** "Ground floor" → { code: "GF", name: "ground floor" }; unknown labels are kept as printed. */
export function normFloor(raw: string | null | undefined): { code: string; name: string } | null {
  const f = raw?.trim();
  if (!f) return null;
  for (const [re, code, name] of FLOOR_NAMES) if (re.test(f)) return { code, name };
  const code = f.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 6) || "X";
  return { code, name: f };
}

const normMark = (m: string) => m.trim().toUpperCase().replace(/\s+/g, "");
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

interface Counted {
  mark: string;
  floor: { code: string; name: string } | null;
  size: string | null;
  schedule: { count: number | null; src: DrawingSource } | null;
  layout: { count: number; src: DrawingSource } | null;
}

export function assembleProposal(pages: AssembleInput[]): BoqProposal {
  const warnings: string[] = [];
  const discrepancies: DrawingDiscrepancy[] = [];
  const items: ProposedBoqItem[] = [];
  const sheetName = (p: AssembleInput) => p.classification?.title?.trim() || p.classification?.sheet_type.replace(/_/g, " ") || `page ${p.pageNo}`;
  const src = (p: AssembleInput, evidence_text: string, confidence: number): DrawingSource => ({ page: p.pageNo, sheet: sheetName(p), evidence_text, confidence });

  for (const p of pages) for (const n of p.extraction?.notes ?? []) warnings.push(`p.${p.pageNo}: ${n}`);

  // ---- columns and footings: schedule rows + layout counts, matched by mark (and floor when both state one) ----
  function collect(element: "column" | "footing"): Counted[] {
    const entries: Counted[] = [];
    const find = (mark: string, floor: Counted["floor"]) =>
      entries.find((e) => e.mark === mark && (!e.floor || !floor || e.floor.code === floor.code));
    for (const p of pages) {
      const rows =
        element === "column"
          ? (p.extraction?.columns ?? []).map((c) => ({ mark: c.mark, floor: c.floor, size: c.size_text || null, count: c.count, ev: c.evidence_text, conf: c.confidence }))
          : (p.extraction?.footings ?? []).map((f) => ({
              mark: f.mark,
              floor: null,
              size: f.length_mm && f.breadth_mm && f.depth_mm ? `${f.length_mm}×${f.breadth_mm}×${f.depth_mm} mm` : f.size_text || null,
              count: f.count,
              ev: f.evidence_text,
              conf: f.confidence,
            }));
      for (const r of rows) {
        const mark = normMark(r.mark);
        const floor = normFloor(r.floor);
        const existing = find(mark, floor);
        if (existing?.schedule) {
          if (existing.schedule.count !== r.count && r.count != null) {
            warnings.push(`${element} ${mark}: two schedule rows disagree (p.${existing.schedule.src.page} says ${existing.schedule.count ?? "no count"}, p.${p.pageNo} says ${r.count}); kept p.${existing.schedule.src.page}.`);
          }
          continue;
        }
        const schedule = { count: r.count, src: src(p, r.ev, r.conf) };
        if (existing) Object.assign(existing, { schedule, size: r.size, floor: existing.floor ?? floor });
        else entries.push({ mark, floor, size: r.size, schedule, layout: null });
      }
    }
    for (const p of pages) {
      for (const lc of p.extraction?.layout_counts ?? []) {
        if (lc.element !== element) continue;
        const mark = normMark(lc.mark);
        const floor = normFloor(lc.floor);
        const existing = find(mark, floor);
        const layout = { count: lc.count, src: src(p, lc.evidence_text, lc.confidence) };
        if (existing?.layout) {
          // Same mark counted on two layout sheets of the same floor: keep the first, but say so.
          if (existing.layout.count !== lc.count) warnings.push(`${element} ${mark}: layout p.${existing.layout.src.page} shows ${existing.layout.count}, p.${p.pageNo} shows ${lc.count}; kept p.${existing.layout.src.page}.`);
          continue;
        }
        if (existing) Object.assign(existing, { layout, floor: existing.floor ?? floor });
        else entries.push({ mark, floor, size: null, schedule: null, layout });
      }
    }
    return entries;
  }

  /** Count for one mark: schedule and layout agree, or only one states it; a disagreement is a discrepancy (no count). */
  function resolve(element: "column" | "footing", e: Counted): number | null {
    const s = e.schedule?.count ?? null;
    const l = e.layout?.count ?? null;
    if (s != null && l != null && s !== l) {
      const where = e.floor ? ` (${e.floor.name})` : "";
      discrepancies.push({
        element,
        mark: e.mark,
        floor: e.floor?.code ?? null,
        scheduleCount: s,
        layoutCount: l,
        schedulePage: e.schedule!.src.page,
        layoutPage: e.layout!.src.page,
        message: `${element === "column" ? "Column" : "Footing"} ${e.mark}${where}: the schedule (p.${e.schedule!.src.page}) says ${s}, the layout (p.${e.layout!.src.page}) shows ${l}.`,
      });
      return null;
    }
    return s ?? l;
  }

  function countItem(element: "column" | "footing", entries: Counted[], floor: Counted["floor"], code: string, sequenceNo: number): ProposedBoqItem {
    const sorted = [...entries].sort((a, b) => a.mark.localeCompare(b.mark, undefined, { numeric: true }));
    const counts = sorted.map((e) => ({ e, n: resolve(element, e) }));
    const unknown = counts.filter((c) => c.n == null);
    const total = counts.reduce((s, c) => s + (c.n ?? 0), 0);
    const parts = counts.map(({ e, n }) => `${e.mark}${e.size ? ` ${e.size}` : ""} ×${n ?? "?"}`).join(", ");
    const sources = sorted.flatMap((e) => [e.schedule?.src, e.layout?.src].filter((s): s is DrawingSource => !!s));
    const noun = element === "column" ? "RCC columns" : "RCC footings";
    const disputed = unknown.filter(({ e }) => discrepancies.some((d) => d.element === element && d.mark === e.mark && d.floor === (e.floor?.code ?? null)));
    const needsInput = unknown.length
      ? [
          disputed.length ? `drawing discrepancy for ${disputed.map((u) => u.e.mark).join(", ")}` : null,
          unknown.length > disputed.length ? `no count on the drawings for ${unknown.filter((u) => !disputed.includes(u)).map((u) => u.e.mark).join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ")
      : null;
    return proposed({
      key: `${element}:${floor?.code ?? "all"}`,
      code,
      description: `${noun}${floor ? `, ${floor.name}` : ""}: ${parts}`,
      unit: "nos",
      plannedQty: needsInput ? 0 : total,
      measureMode: element === "column" ? "count" : "visual_only",
      segmentTargets: element === "column" ? ["column"] : [],
      sequenceNo,
      needsInput,
      sources,
    });
  }

  const footings = collect("footing");
  if (footings.length) items.push(countItem("footing", footings, null, "FTG", 1));
  else if (pages.some((p) => p.classification?.sheet_type === "footing_layout")) warnings.push("A footing layout was found but no footing marks could be read.");

  const columns = collect("column");
  const colFloors = [...new Map(columns.map((c) => [c.floor?.code ?? "", c.floor])).values()];
  for (const floor of colFloors) {
    const group = columns.filter((c) => (c.floor?.code ?? "") === (floor?.code ?? ""));
    const code = floor && colFloors.length > 1 ? `COL-${floor.code}` : floor ? `COL-${floor.code}` : "COL";
    items.push(countItem("column", group, floor, code, 2));
  }
  if (!columns.length && pages.some((p) => p.classification?.sheet_type === "column_layout")) warnings.push("A column layout was found but no column marks could be read.");

  // ---- plinth beams: lot, visual only ----
  const plinth = pages.flatMap((p) =>
    (p.extraction?.beams ?? []).filter((b) => b.kind === "plinth" || /^PB/i.test(b.mark)).map((b) => ({ b, s: src(p, b.evidence_text, b.confidence) })),
  );
  const plinthSheets = pages.filter((p) => p.classification?.sheet_type === "plinth_beam");
  if (plinth.length || plinthSheets.length) {
    const marks = [...new Map(plinth.map(({ b }) => [normMark(b.mark), b])).values()];
    items.push(
      proposed({
        key: "plinth_beams",
        code: "PB",
        description: marks.length ? `Plinth beams ${marks.map((b) => `${normMark(b.mark)}${b.size_text ? ` ${b.size_text}` : ""}`).join(", ")}` : "Plinth beams",
        unit: "lot",
        plannedQty: 1,
        measureMode: "visual_only",
        segmentTargets: [],
        sequenceNo: 3,
        needsInput: null,
        sources: plinth.length ? plinth.map((x) => x.s) : plinthSheets.map((p) => src(p, p.classification?.title ?? "plinth beam sheet", 0.6)),
      }),
    );
  }

  // ---- slabs: m3 when area and thickness are both on the drawings, otherwise lot; default stages ----
  const slabs = pages.flatMap((p) => (p.extraction?.slabs ?? []).map((s) => ({ s, p })));
  const seenSlabs = new Set<string>();
  for (const { s, p } of slabs) {
    const floor = normFloor(s.floor);
    const key = `${normMark(s.mark)}|${floor?.code ?? ""}`;
    if (seenSlabs.has(key)) continue;
    seenSlabs.add(key);
    const both = s.area_m2 != null && s.thickness_mm != null;
    const volume = both ? round(s.area_m2! * (s.thickness_mm! / 1000)) : null;
    const label = /slab/i.test(s.mark) ? s.mark : `slab ${s.mark}`;
    items.push(
      proposed({
        key: `slab:${key}`,
        code: `SLB-${floor?.code ?? normMark(s.mark).slice(0, 6)}`,
        description: `RCC ${label}${floor ? `, ${floor.name}` : ""}${s.thickness_mm ? `, ${s.thickness_mm} mm thick` : ""}${both ? ` (${s.area_m2} m² × ${s.thickness_mm} mm)` : ""}`,
        unit: both ? "m3" : "lot",
        plannedQty: volume ?? 1,
        measureMode: "visual_only",
        segmentTargets: [],
        stages: DEFAULT_SLAB_STAGES,
        sequenceNo: 4,
        needsInput: null,
        sources: [src(p, s.evidence_text, s.confidence)],
      }),
    );
    if (!both) warnings.push(`${label}${floor ? ` (${floor.name})` : ""}: ${s.area_m2 == null ? "no area" : "no thickness"} on the drawings, so it is a lot item; enter m³ if you have it.`);
  }
  if (!slabs.length) {
    for (const p of pages.filter((x) => x.classification?.sheet_type === "slab_plan")) {
      items.push(
        proposed({
          key: `slab:p${p.pageNo}`,
          code: "SLB",
          description: `RCC slab (${sheetName(p)})`,
          unit: "lot",
          plannedQty: 1,
          measureMode: "visual_only",
          segmentTargets: [],
          stages: DEFAULT_SLAB_STAGES,
          sequenceNo: 4,
          needsInput: null,
          sources: [src(p, p.classification?.title ?? "slab plan", 0.6)],
        }),
      );
    }
  }

  // ---- brickwork: lot, visual only, when a floor plan shows masonry walls ----
  const wallPlans = pages.filter((p) => p.classification?.sheet_type === "floor_plan" && p.classification.shows_masonry_walls);
  if (wallPlans.length) {
    items.push(
      proposed({
        key: "brickwork",
        code: "BWK",
        description: "Brick masonry walls (as shown on the floor plan)",
        unit: "lot",
        plannedQty: 1,
        measureMode: "visual_only",
        segmentTargets: [],
        sequenceNo: 5,
        needsInput: null,
        sources: wallPlans.map((p) => src(p, p.classification?.notes || p.classification?.title || "floor plan with walls", 0.7)),
      }),
    );
  }

  // Unique codes.
  const used = new Map<string, number>();
  for (const it of items) {
    const n = (used.get(it.code) ?? 0) + 1;
    used.set(it.code, n);
    if (n > 1) it.code = `${it.code}-${n}`;
  }
  return { items, discrepancies, warnings };
}

function proposed(x: Omit<ProposedBoqItem, "zoneId" | "panelPlannedQty" | "stages" | "drawingSource" | "confidence"> & { stages?: BoqStage[] | null }): ProposedBoqItem {
  const confidence = x.sources.length ? Math.min(...x.sources.map((s) => s.confidence)) : 0.5;
  return {
    zoneId: null,
    panelPlannedQty: null,
    stages: x.stages ?? null,
    ...x,
    confidence,
    drawingSource: drawingSourceText(x.plannedQty, x.unit, x.needsInput, x.sources),
  };
}

/** One line for the agent and the BOQ, e.g. "12 nos per Column schedule p.2; Column layout plan p.3". */
export function drawingSourceText(qty: number, unit: string, needsInput: string | null, sources: DrawingSource[]): string {
  const where = [...new Map(sources.map((s) => [`${s.sheet} p.${s.page}`, s])).keys()].join("; ") || "drawings";
  return (needsInput ? `needs input (${needsInput}); see ${where}` : `${qty} ${unit} per ${where}`).slice(0, 500);
}
