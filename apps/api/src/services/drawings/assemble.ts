/**
 * Code, not the model: extracted sheet data → proposed BOQ items.
 * - Quantities come only from the drawings. Anything the drawings do not support, or contradict (schedule vs layout
 *   counts), becomes "needs input" with plannedQty 0 for the engineer to fill in.
 * - Descriptions keep the drawing's own notation (6'-0"x6'-0"x18", 5"); nothing is converted silently.
 * - Warnings are "action" (the engineer must act) or "note" (information); repeated notes are merged with their pages.
 */
import type {
  BoqProposal,
  BoqStage,
  DrawingDiscrepancy,
  DrawingSource,
  PageClassification,
  ProposalWarning,
  ProposedBoqItem,
  SheetExtraction,
} from "@sitesight/shared";

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

type Floor = { code: string; name: string; raw: string };

const FLOOR_NAMES: [RegExp, string, string][] = [
  [/^(gf|g\.\s?f\.?|ground( floor)?|plinth)$/i, "GF", "ground floor"],
  [/^(ff|f\.\s?f\.?|first( floor)?|1st( floor)?)$/i, "FF", "first floor"],
  [/^(sf|s\.\s?f\.?|second( floor)?|2nd( floor)?)$/i, "SF", "second floor"],
  [/^(tf|t\.\s?f\.?|third( floor)?|3rd( floor)?)$/i, "TF", "third floor"],
  [/^(roof|terrace)( slab| level)?$/i, "RF", "roof"],
];
// Floor tokens inside longer text, e.g. "SLAB PLAN OF G.F ROOF SLAB" or "G.F roof".
const FLOOR_TOKENS: [RegExp, string, string][] = [
  [/\b(g\.\s?f\b\.?|gf\b|ground floor)/i, "GF", "ground floor"],
  [/\b(f\.\s?f\b\.?|ff\b|first floor|1st floor)/i, "FF", "first floor"],
  [/\b(s\.\s?f\b\.?|sf\b|second floor|2nd floor)/i, "SF", "second floor"],
  [/\b(t\.\s?f\b\.?|tf\b|third floor|3rd floor)/i, "TF", "third floor"],
];

/** "Ground floor" → { code: "GF", name: "ground floor", raw }; unknown labels keep their own text. */
export function normFloor(raw: string | null | undefined): Floor | null {
  const f = raw?.trim();
  if (!f) return null;
  for (const [re, code, name] of FLOOR_NAMES) if (re.test(f)) return { code, name, raw: f };
  const found = floorInText(f);
  if (found) return found;
  const code = f.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 6) || "X";
  return { code, name: f, raw: f };
}

/** A floor named somewhere in a longer text (a mark or a sheet title), with the text as drawn ("G.F"). */
export function floorInText(text: string | null | undefined): Floor | null {
  if (!text) return null;
  for (const [re, code, name] of FLOOR_TOKENS) {
    const m = re.exec(text);
    if (m) return { code, name, raw: m[1]!.replace(/\.$/, "") };
  }
  return null;
}

const normMark = (m: string) => m.trim().toUpperCase().replace(/\s+/g, "");
const naturally = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const isPanelMark = (m: string) => /^S\d+[A-Z]?$/i.test(normMark(m));
const pagesText = (pages: number[]) => (pages.length === 1 ? `p. ${pages[0]}` : `pp. ${pages.join(", ")}`);

interface Counted {
  mark: string;
  floor: Floor | null;
  size: string | null;
  schedule: { count: number | null; src: DrawingSource } | null;
  layout: { count: number; src: DrawingSource } | null;
}

export function assembleProposal(pages: AssembleInput[]): BoqProposal {
  const actions: ProposalWarning[] = [];
  const discrepancies: DrawingDiscrepancy[] = [];
  const items: ProposedBoqItem[] = [];
  const action = (text: string, pgs: number[] = []) => actions.push({ kind: "action", text, pages: [...new Set(pgs)].sort((a, b) => a - b) });
  const sheetName = (p: AssembleInput) => p.classification?.title?.trim() || p.classification?.sheet_type.replace(/_/g, " ") || `page ${p.pageNo}`;
  const src = (p: AssembleInput, evidence_text: string, confidence: number): DrawingSource => ({ page: p.pageNo, sheet: sheetName(p), evidence_text, confidence });

  // ---- columns and footings: schedule rows + layout counts, matched by mark (and floor when both state one) ----
  function collect(element: "column" | "footing"): Counted[] {
    const entries: Counted[] = [];
    const find = (mark: string, floor: Floor | null) => entries.find((e) => e.mark === mark && (!e.floor || !floor || e.floor.code === floor.code));
    for (const p of pages) {
      const rows =
        element === "column"
          ? (p.extraction?.columns ?? []).map((c) => ({ mark: c.mark, floor: c.floor, size: c.size_text, count: c.count, ev: c.evidence_text, conf: c.confidence }))
          : (p.extraction?.footings ?? []).map((f) => ({ mark: f.mark, floor: null, size: f.size_text, count: f.count, ev: f.evidence_text, conf: f.confidence }));
      for (const r of rows) {
        const mark = normMark(r.mark);
        const floor = normFloor(r.floor);
        const existing = find(mark, floor);
        if (existing?.schedule) {
          if (existing.schedule.count !== r.count && r.count != null) {
            action(`${element === "column" ? "Column" : "Footing"} ${mark}: two schedules disagree (p. ${existing.schedule.src.page} says ${existing.schedule.count ?? "no count"}, p. ${p.pageNo} says ${r.count}); p. ${existing.schedule.src.page} was used.`, [existing.schedule.src.page, p.pageNo]);
          }
          continue;
        }
        // Size exactly as printed; never a converted value.
        const schedule = { count: r.count, src: src(p, r.ev, r.conf) };
        const size = r.size?.trim() || null;
        if (existing) Object.assign(existing, { schedule, size, floor: existing.floor ?? floor });
        else entries.push({ mark, floor, size, schedule, layout: null });
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
          if (existing.layout.count !== lc.count) {
            action(`${element === "column" ? "Column" : "Footing"} ${mark}: two layouts disagree (p. ${existing.layout.src.page} shows ${existing.layout.count}, p. ${p.pageNo} shows ${lc.count}); p. ${existing.layout.src.page} was used.`, [existing.layout.src.page, p.pageNo]);
          }
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

  function countItem(element: "column" | "footing", entries: Counted[], floor: Floor | null, code: string, sequenceNo: number): ProposedBoqItem {
    const sorted = [...entries].sort((a, b) => naturally(a.mark, b.mark));
    const counts = sorted.map((e) => ({ e, n: resolve(element, e) }));
    const unknown = counts.filter((c) => c.n == null);
    const total = counts.reduce((s, c) => s + (c.n ?? 0), 0);
    const parts = counts.map(({ e, n }) => `${e.mark}${e.size ? ` ${e.size}` : ""} ×${n ?? "?"}`).join(", ");
    const sources = sorted.flatMap((e) => [e.schedule?.src, e.layout?.src].filter((s): s is DrawingSource => !!s));
    const noun = element === "column" ? "RCC columns" : "RCC footings";
    const disputed = unknown.filter(({ e }) => discrepancies.some((d) => d.element === element && d.mark === e.mark && d.floor === (e.floor?.code ?? null)));
    const uncounted = unknown.filter((u) => !disputed.includes(u));
    const needsInput = unknown.length
      ? [
          disputed.length ? `drawing discrepancy for ${disputed.map((u) => u.e.mark).join(", ")}` : null,
          uncounted.length ? `no count on the drawings for ${uncounted.map((u) => u.e.mark).join(", ")}` : null,
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
  else {
    const fl = pages.filter((p) => p.classification?.sheet_type === "footing_layout").map((p) => p.pageNo);
    if (fl.length) action("A footing layout was found but no footing marks could be read.", fl);
  }

  const columns = collect("column");
  const colFloors = [...new Map(columns.map((c) => [c.floor?.code ?? "", c.floor])).values()];
  for (const floor of colFloors) {
    const group = columns.filter((c) => (c.floor?.code ?? "") === (floor?.code ?? ""));
    items.push(countItem("column", group, floor, floor ? `COL-${floor.code}` : "COL", 2));
  }
  if (!columns.length) {
    const cl = pages.filter((p) => p.classification?.sheet_type === "column_layout").map((p) => p.pageNo);
    if (cl.length) action("A column layout was found but no column marks could be read.", cl);
  }

  // ---- plinth beams: lot, visual only. Only PB marks (or "plinth" beams on a plinth beam sheet) ----
  const allBeams = pages.flatMap((p) => (p.extraction?.beams ?? []).map((b) => ({ b, p })));
  const isPlinth = ({ b, p }: (typeof allBeams)[number]) => /^P\.?\s?B/i.test(b.mark.trim()) || (b.kind === "plinth" && p.classification?.sheet_type === "plinth_beam");
  const plinth = allBeams.filter(isPlinth);
  const plinthSheets = pages.filter((p) => p.classification?.sheet_type === "plinth_beam");
  if (plinth.length || plinthSheets.length) {
    const marks = [...new Map(plinth.map(({ b }) => [normMark(b.mark), b])).values()].sort((a, b) => naturally(normMark(a.mark), normMark(b.mark)));
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
        sources: plinth.length ? plinth.map(({ b, p }) => src(p, b.evidence_text, b.confidence)) : plinthSheets.map((p) => src(p, p.classification?.title ?? "plinth beam sheet", 0.6)),
      }),
    );
  }

  // ---- slabs: ONE item per floor/level, merging panels (S1, S2), the slab schedule's thickness and the floor beams ----
  const slabRows = pages.flatMap((p) => (p.extraction?.slabs ?? []).map((s) => ({ s, p, floor: normFloor(s.floor) ?? floorInText(s.mark) ?? floorInText(sheetName(p)) })));
  const floorBeams = allBeams
    .filter((x) => !isPlinth(x) && x.b.kind !== "lintel")
    .map((x) => ({ ...x, floor: normFloor(x.b.floor) ?? floorInText(sheetName(x.p)) }));
  const slabSheets = pages.filter((p) => p.classification?.sheet_type === "slab_plan");
  // Rows and beams with no floor anywhere join the only floor there is; with several floors they stay unassigned.
  const knownFloors = [...new Map([...slabRows, ...floorBeams, ...slabSheets.map((p) => ({ floor: floorInText(sheetName(p)) }))].filter((x) => x.floor).map((x) => [x.floor!.code, x.floor!])).values()];
  const soleFloor = knownFloors.length === 1 ? knownFloors[0]! : null;
  const floorKey = (f: Floor | null) => (f ?? soleFloor)?.code ?? "";
  const slabKeys = [...new Set([...slabRows.map((r) => floorKey(r.floor)), ...slabSheets.map((p) => floorKey(floorInText(sheetName(p))))])];

  for (const key of slabKeys) {
    const rows = slabRows.filter((r) => floorKey(r.floor) === key);
    const beams = floorBeams.filter((b) => floorKey(b.floor) === key);
    const floor = rows.find((r) => r.floor)?.floor ?? (key ? (knownFloors.find((f) => f.code === key) ?? null) : null);
    const panels = [...new Set(rows.filter((r) => isPanelMark(r.s.mark)).map((r) => normMark(r.s.mark)))].sort(naturally);
    // In the order the drawings list them (FB1, FB2, C.B), schedules first.
    const beamMarks = [...new Set([...beams].sort((x, y) => Number(y.p.classification?.sheet_type === "beam_schedule") - Number(x.p.classification?.sheet_type === "beam_schedule")).map((b) => normMark(b.b.mark)))];

    // Thickness as drawn: from the rows that print one (normally the slab schedule).
    const withThickness = rows.filter((r) => r.s.thickness_text || r.s.thickness_mm);
    const thicknessTexts = [...new Set(withThickness.map((r) => r.s.thickness_text?.trim() || `${r.s.thickness_mm} mm`))];
    const thickness = thicknessTexts.length === 1 ? thicknessTexts[0]! : null;
    if (thicknessTexts.length > 1) {
      action(
        `${floor?.raw ?? "Slab"}: panels print different thicknesses (${withThickness.map((r) => `${normMark(r.s.mark)} ${r.s.thickness_text ?? `${r.s.thickness_mm} mm`}`).join(", ")}); check the stages and quantity.`,
        withThickness.map((r) => r.p.pageNo),
      );
    }

    // m³ only when the drawings print an area and a thickness for the whole slab (one row with both, or every panel).
    const whole = rows.find((r) => !isPanelMark(r.s.mark) && r.s.area_m2 != null && r.s.thickness_mm != null);
    const panelRows = [...new Map(rows.filter((r) => isPanelMark(r.s.mark)).map((r) => [normMark(r.s.mark), r])).values()];
    const panelThk = (mark: string) => rows.find((r) => normMark(r.s.mark) === mark && r.s.thickness_mm != null)?.s.thickness_mm ?? null;
    const panelsComplete = panelRows.length > 0 && panelRows.every((r) => r.s.area_m2 != null && panelThk(normMark(r.s.mark)) != null);
    const volume = whole
      ? round(whole.s.area_m2! * (whole.s.thickness_mm! / 1000))
      : panelsComplete
        ? round(panelRows.reduce((sum, r) => sum + r.s.area_m2! * (panelThk(normMark(r.s.mark))! / 1000), 0))
        : null;
    const basis = whole
      ? ` = ${whole.s.area_text ?? `${whole.s.area_m2} m²`} × ${whole.s.thickness_text ?? `${whole.s.thickness_mm} mm`}`
      : panelsComplete
        ? ` = ${panelRows.map((r) => `${normMark(r.s.mark)} ${r.s.area_text ?? `${r.s.area_m2} m²`}`).join(" + ")} × ${thickness ?? "thickness"}`
        : "";

    const name = floor ? `${floor.raw} roof slab` : "Roof slab";
    const inside = [panels.length ? `panels ${panels.join(", ")}` : null, beamMarks.length ? `beams ${beamMarks.join(", ")}` : null].filter(Boolean).join("; ");
    const pagesOf = [...rows.map((r) => r.p), ...beams.map((b) => b.p)];
    const sheetSources = slabSheets.filter((p) => floorKey(floorInText(sheetName(p))) === key);
    const sources = [
      ...rows.map((r) => src(r.p, r.s.evidence_text, r.s.confidence)),
      ...beams.map((b) => src(b.p, b.b.evidence_text, b.b.confidence)),
      ...(rows.length || beams.length ? [] : sheetSources.map((p) => src(p, p.classification?.title ?? "slab plan", 0.6))),
    ];
    const code = `SLB${floor ? `-${floor.code}` : ""}`;
    items.push(
      proposed({
        key: `slab:${key || "unassigned"}`,
        code,
        description: `${name}${thickness ? `, ${thickness}` : ""} RCC${inside ? ` (${inside})` : ""}${volume != null ? `${basis} m³` : ""}`,
        unit: volume != null ? "m3" : "lot",
        plannedQty: volume ?? 1,
        measureMode: "visual_only",
        segmentTargets: [],
        stages: DEFAULT_SLAB_STAGES,
        sequenceNo: 4,
        needsInput: null,
        sources,
      }),
    );
    if (volume == null) {
      action(`${code}: the drawings give no slab area, so it is a lot item. Enter m³ if you have it.`, [...pagesOf, ...sheetSources].map((p) => p.pageNo));
    }
  }
  const strayBeams = floorBeams.filter((b) => !slabKeys.includes(floorKey(b.floor)));
  if (strayBeams.length) {
    action(`Beams ${[...new Set(strayBeams.map((b) => normMark(b.b.mark)))].sort(naturally).join(", ")} could not be matched to a slab (no floor stated).`, strayBeams.map((b) => b.p.pageNo));
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

  // Discrepancies and missing quantities first: they block saving. Then the other actions.
  const others = actions.splice(0);
  for (const d of discrepancies) action(d.message, [d.schedulePage, d.layoutPage]);
  for (const it of items.filter((i) => i.needsInput)) action(`${it.code}: enter the quantity (${it.needsInput}).`, it.sources.map((s) => s.page));
  actions.push(...others);

  return { items, discrepancies, warnings: [...actions, ...collectNotes(pages)] };
}

/**
 * Notes for information, merged across pages: the same general note printed on every sheet becomes one line with its
 * pages, and title blocks that disagree with the drawing's heading become "Title block says X on pp. …".
 */
export function collectNotes(pages: AssembleInput[]): ProposalWarning[] {
  const byText = new Map<string, { text: string; pages: number[] }>();
  const add = (key: string, text: string, page: number) => {
    const e = byText.get(key) ?? { text, pages: [] };
    if (!e.pages.includes(page)) e.pages.push(page);
    byText.set(key, e);
  };
  for (const p of pages) {
    const tb = p.classification?.title_block_title?.trim();
    if (tb && normNote(tb) !== normNote(p.classification?.title ?? "")) add(`tb:${normNote(tb)}`, `Title block says "${tb}"`, p.pageNo);
    for (const n of p.extraction?.notes ?? []) {
      const text = n.trim().replace(/^(\(?\d+[.)]\s*|[-•*]\s*)/, "");
      if (text) add(`n:${normNote(text)}`, text, p.pageNo);
    }
  }
  return [...byText.entries()].map(([key, e]) => {
    const pages = e.pages.sort((a, b) => a - b);
    return { kind: "note" as const, text: key.startsWith("tb:") ? `${e.text} on ${pagesText(pages)}` : `${e.text.replace(/\.$/, "")} (${pagesText(pages)})`, pages };
  });
}

/** For comparing notes: case, punctuation, numbering and whitespace don't matter. */
function normNote(s: string): string {
  return s.toLowerCase().replace(/^(\(?\d+[.)]\s*)/, "").replace(/[^a-z0-9]+/g, " ").trim();
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

/** Actions about the run itself: pages that could not be read, and the cost cap stopping it early. */
export function runActions(
  states: { pageNo: number; classification: PageClassification | null; extraction: SheetExtraction | null; error: string | null }[],
  stoppedByCost: boolean,
  limitUsd: number,
  isStructural: (t: PageClassification["sheet_type"] | undefined) => boolean,
): ProposalWarning[] {
  const out: ProposalWarning[] = [];
  if (stoppedByCost) {
    const todo = states.filter((s) => !s.classification || (!s.extraction && isStructural(s.classification?.sheet_type))).map((s) => s.pageNo);
    out.push({
      kind: "action",
      text: `Stopped at the cost cap ($${limitUsd.toFixed(2)}): ${todo.length ? `${pagesText(todo)} not read` : "some pages not read"}. The proposal covers the rest.`,
      pages: todo,
    });
  }
  for (const f of states.filter((s) => s.error)) out.push({ kind: "action", text: `p. ${f.pageNo} could not be read (${f.error}).`, pages: [f.pageNo] });
  return out;
}
