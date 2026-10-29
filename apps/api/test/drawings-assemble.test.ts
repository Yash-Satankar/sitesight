/** Code step of the drawing import: extracted sheets → proposed BOQ. Never invents quantities; flags discrepancies. */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { BoqProposal, PageClassification, SheetExtraction } from "@sitesight/shared";
import { assembleProposal, DEFAULT_SLAB_STAGES, normFloor, runActions, type AssembleInput } from "../src/services/drawings/assemble.js";
import { boqItemProblem } from "../src/services/boq-rules.js";
import { formatProposal } from "../scripts/drawings-lib.js";

const cls = (sheet_type: PageClassification["sheet_type"], title: string, extra: Partial<PageClassification> = {}): PageClassification =>
  PageClassification.parse({ sheet_type, title, notes: "", ...extra });
const ev = (confidence = 0.9) => ({ evidence_text: "read", confidence });
const page = (pageNo: number, c: PageClassification, e: z.input<typeof SheetExtraction> | null = null): AssembleInput => ({
  pageNo,
  classification: c,
  extraction: e ? SheetExtraction.parse(e) : null,
});
const actions = (p: BoqProposal) => p.warnings.filter((w) => w.kind === "action").map((w) => w.text);
const notes = (p: BoqProposal) => p.warnings.filter((w) => w.kind === "note").map((w) => w.text);

const schedule = page(2, cls("footing_column_schedule", "Footing & column schedule"), {
  columns: [
    { mark: "C1", size_text: '9"x9"', count: 2, floor: null, ...ev() },
    { mark: "C2", size_text: '9"x18"', count: 10, floor: null, ...ev(0.8) },
  ],
  footings: [
    { mark: "F1", length_mm: 1829, breadth_mm: 1829, depth_mm: 457, size_text: `6'-0"x6'-0"x18"`, count: 8, ...ev() },
    { mark: "F2", length_mm: 1524, breadth_mm: 1524, depth_mm: 457, size_text: `5'-0"x5'-0"x18"`, count: null, ...ev() },
  ],
});
const columnLayout = (c2: number) =>
  page(3, cls("column_layout", "Column layout plan"), {
    layout_counts: [
      { element: "column", mark: "C1", count: 2, floor: null, evidence_text: "counted 2 C1", confidence: 0.7 },
      { element: "column", mark: "c2", count: c2, floor: null, evidence_text: `counted ${c2} C2`, confidence: 0.7 },
      { element: "footing", mark: "F2", count: 4, floor: null, evidence_text: "counted 4 F2", confidence: 0.6 },
    ],
  });

// Shaped like the real demo-residence.pdf extractions: p.9 shuttering plan, p.10 slab plan, p.12 beam + slab schedules.
const GENERAL_NOTE = (n: number) => `${n}. ALL DIMENSIONS ARE IN FEET UNLESS NOTED OTHERWISE.`;
const TB = { title_block_title: "ARCHITECTURAL FLOOR PLAN" };
const p9 = page(9, cls("slab_plan", "SHUTTERING PLAN OF G.F ROOF SLAB", TB), {
  slabs: [{ mark: "G.F roof slab", floor: "G.F", thickness_mm: null, area_m2: null, evidence_text: "SHUTTERING PLAN OF G.F ROOF SLAB", confidence: 0.8 }],
  beams: [
    { mark: "FB1", size_text: "", kind: "floor", floor: null, evidence_text: "FB1 labels on plan", confidence: 0.8 },
    { mark: "FB2", size_text: "", kind: "floor", floor: null, evidence_text: "FB2 labels on plan", confidence: 0.8 },
    { mark: "C.B", size_text: "", kind: "other", floor: null, evidence_text: "C.B label", confidence: 0.7 },
  ],
  notes: [GENERAL_NOTE(1), "Written dimensions are to be followed."],
});
const p10 = page(10, cls("slab_plan", "SLAB PLAN OF G.F ROOF SLAB", TB), {
  slabs: [
    { mark: "S1", floor: null, thickness_mm: null, area_m2: null, evidence_text: "S1 panel marks", confidence: 0.85 },
    { mark: "S2", floor: null, thickness_mm: null, area_m2: null, evidence_text: "S2 panel marks", confidence: 0.85 },
  ],
  beams: [
    { mark: "FB1", size_text: "", kind: "floor", floor: null, evidence_text: "FB1", confidence: 0.8 },
    { mark: "FB2", size_text: "", kind: "floor", floor: null, evidence_text: "FB2", confidence: 0.8 },
    { mark: "C.B", size_text: "", kind: "other", floor: null, evidence_text: "C.B", confidence: 0.7 },
  ],
  notes: ["all dimensions are in feet unless noted otherwise"],
});
const p12 = page(12, cls("beam_schedule", "R.C.C. DETAIL OF G.F. ROOF SLAB & BEAM", TB), {
  beams: [
    { mark: "FB1", size_text: '9"x17"', kind: "floor", floor: "G.F", evidence_text: 'FB1 | 9"x17"', confidence: 0.92 },
    { mark: "FB2", size_text: '9"x17"', kind: "floor", floor: "G.F", evidence_text: 'FB2 | 9"x17"', confidence: 0.92 },
    { mark: "C.B", size_text: '9"x5"', kind: "floor", floor: "G.F", evidence_text: 'C.B | 9"x5"', confidence: 0.9 },
  ],
  slabs: [
    { mark: "S1", floor: null, thickness_text: '5"', thickness_mm: 127, area_m2: null, evidence_text: 'S1 | 5" | 10MM @6"C/C', confidence: 0.9 },
    { mark: "S2", floor: null, thickness_text: '5"', thickness_mm: 127, area_m2: null, evidence_text: 'S2 | 5" | 10MM @6"C/C', confidence: 0.9 },
  ],
  notes: [GENERAL_NOTE(1)],
});

describe("assembleProposal: columns and footings", () => {
  it("builds footings and columns from schedule + layout counts, with marks and sources", () => {
    const p = assembleProposal([schedule, columnLayout(10)]);
    const ftg = p.items.find((i) => i.code === "FTG")!;
    // F1 from the schedule (8), F2 only counted on the layout (4).
    expect(ftg).toMatchObject({ unit: "nos", plannedQty: 12, needsInput: null, measureMode: "visual_only" });
    const col = p.items.find((i) => i.code === "COL")!;
    expect(col).toMatchObject({ unit: "nos", plannedQty: 12, measureMode: "count", segmentTargets: ["column"], needsInput: null });
    expect(col.description).toBe('RCC columns: C1 9"x9" ×2, C2 9"x18" ×10');
    expect(col.drawingSource).toBe("12 nos per Footing & column schedule p.2; Column layout plan p.3");
    expect(col.confidence).toBe(0.7); // weakest source
    expect(p.discrepancies).toEqual([]);
    expect(actions(p)).toEqual([]);
    for (const it of p.items) expect(boqItemProblem(it)).toBeNull();
  });

  it("keeps the drawing's own units: sizes as printed, no converted mm", () => {
    const ftg = assembleProposal([schedule, columnLayout(10)]).items.find((i) => i.code === "FTG")!;
    expect(ftg.description).toBe(`RCC footings: F1 6'-0"x6'-0"x18" ×8, F2 5'-0"x5'-0"x18" ×4`);
    expect(ftg.description).not.toMatch(/mm|1829/);
    // A drawing in mm stays in mm.
    const metric = assembleProposal([
      page(1, cls("footing_column_schedule", "Footing schedule"), {
        footings: [{ mark: "F1", length_mm: 1500, breadth_mm: 1500, depth_mm: 450, size_text: "1500x1500x450 MM", count: 4, ...ev() }],
      }),
    ]);
    expect(metric.items[0]!.description).toBe("RCC footings: F1 1500x1500x450 MM ×4");
  });

  it("flags schedule vs layout disagreements as discrepancies and asks for input instead of picking one", () => {
    const p = assembleProposal([schedule, columnLayout(9)]);
    expect(p.discrepancies).toEqual([
      expect.objectContaining({ element: "column", mark: "C2", scheduleCount: 10, layoutCount: 9, schedulePage: 2, layoutPage: 3 }),
    ]);
    const col = p.items.find((i) => i.code === "COL")!;
    expect(col).toMatchObject({ plannedQty: 0, needsInput: "drawing discrepancy for C2" });
    expect(col.description).toContain('C2 9"x18" ×?');
    expect(actions(p)).toEqual(["Column C2: the schedule (p.2) says 10, the layout (p.3) shows 9.", "COL: enter the quantity (drawing discrepancy for C2)."]);
    expect(p.warnings.find((w) => w.text.startsWith("Column C2"))!.pages).toEqual([2, 3]);
  });

  it("never invents a count: marks without one make the item need input (an action)", () => {
    const p = assembleProposal([schedule]); // F2 has no count on the schedule and there is no layout
    expect(p.items.find((i) => i.code === "FTG")).toMatchObject({ plannedQty: 0, needsInput: "no count on the drawings for F2" });
    expect(actions(p)).toContain("FTG: enter the quantity (no count on the drawings for F2).");
  });

  it("splits columns per floor", () => {
    const p = assembleProposal([
      page(4, cls("footing_column_schedule", "Column schedule"), {
        columns: [
          { mark: "C1", size_text: "230x450", count: 12, floor: "Ground floor", ...ev() },
          { mark: "C1", size_text: "230x450", count: 10, floor: "FF", ...ev() },
        ],
      }),
    ]);
    expect(p.items.map((i) => [i.code, i.plannedQty, i.description])).toEqual([
      ["COL-GF", 12, "RCC columns, ground floor: C1 230x450 ×12"],
      ["COL-FF", 10, "RCC columns, first floor: C1 230x450 ×10"],
    ]);
  });
});

describe("assembleProposal: slabs", () => {
  it("merges every slab mark of a floor (shuttering plan + slab plan + schedule) into ONE item with panels, thickness and beams", () => {
    const p = assembleProposal([p9, p10, p12]);
    expect(p.items).toHaveLength(1); // no separate beam items, no SLB-S1 / SLB-S2
    const slab = p.items[0]!;
    expect(slab).toMatchObject({
      code: "SLB-GF",
      description: 'G.F roof slab, 5" RCC (panels S1, S2; beams FB1, FB2, C.B)',
      unit: "lot",
      plannedQty: 1,
      measureMode: "visual_only",
      stages: DEFAULT_SLAB_STAGES,
      needsInput: null,
    });
    expect([...new Set(slab.sources.map((s) => s.page))]).toEqual([9, 10, 12]);
    expect(boqItemProblem(slab)).toBeNull();
    // No area on the drawings → lot, and the engineer is told (an action, with the pages).
    expect(p.warnings).toContainEqual({ kind: "action", text: "SLB-GF: the drawings give no slab area, so it is a lot item. Enter m³ if you have it.", pages: [9, 10, 12] });
  });

  it("is m³ only when an area and a thickness are printed, and says how (in the drawing's units)", () => {
    const p = assembleProposal([
      page(5, cls("slab_plan", "Roof slab plan"), {
        slabs: [{ mark: "FF roof slab", floor: "FF", thickness_text: "125 MM", thickness_mm: 125, area_text: "101.6 SQM", area_m2: 101.6, ...ev() }],
      }),
    ]);
    expect(p.items[0]).toMatchObject({ code: "SLB-FF", unit: "m3", plannedQty: 12.7, description: "FF roof slab, 125 MM RCC = 101.6 SQM × 125 MM m³" });
    expect(actions(p)).toEqual([]);
  });

  it("keeps two floors apart and flags panels that print different thicknesses", () => {
    const p = assembleProposal([
      page(1, cls("beam_schedule", "Slab schedule"), {
        slabs: [
          { mark: "S1", floor: "G.F", thickness_text: '5"', thickness_mm: 127, area_m2: null, ...ev() },
          { mark: "S2", floor: "G.F", thickness_text: '6"', thickness_mm: 152, area_m2: null, ...ev() },
          { mark: "S1", floor: "F.F", thickness_text: '5"', thickness_mm: 127, area_m2: null, ...ev() },
        ],
      }),
    ]);
    expect(p.items.map((i) => [i.code, i.description])).toEqual([
      ["SLB-GF", "G.F roof slab RCC (panels S1, S2)"],
      ["SLB-FF", 'F.F roof slab, 5" RCC (panels S1)'],
    ]);
    expect(actions(p)[0]).toBe('G.F: panels print different thicknesses (S1 5", S2 6"); check the stages and quantity.');
  });
});

describe("assembleProposal: other items", () => {
  it("adds plinth beams (lot) and brickwork (lot, visual only) only when the drawings show them", () => {
    const withBoth = assembleProposal([
      page(6, cls("plinth_beam", "Plinth beam layout"), { beams: [{ mark: "PB1", size_text: '9"x12"', kind: "plinth", ...ev() }] }),
      page(7, cls("floor_plan", "Ground floor plan", { shows_masonry_walls: true })),
      page(8, cls("electrical", "Electrical layout")),
    ]);
    expect(withBoth.items.map((i) => [i.code, i.unit, i.plannedQty, i.measureMode, i.description])).toEqual([
      ["PB", "lot", 1, "visual_only", 'Plinth beams PB1 9"x12"'],
      ["BWK", "lot", 1, "visual_only", "Brick masonry walls (as shown on the floor plan)"],
    ]);
    expect(assembleProposal([page(7, cls("floor_plan", "Ground floor plan")), page(8, cls("electrical", "Electrical"))]).items).toEqual([]);
  });

  it("normalises floor labels", () => {
    expect(normFloor("Ground Floor")).toMatchObject({ code: "GF", name: "ground floor" });
    expect(normFloor("1st floor")).toMatchObject({ code: "FF", name: "first floor" });
    expect(normFloor("G.F roof")).toMatchObject({ code: "GF", raw: "G.F" });
    expect(normFloor(" ")).toBeNull();
    expect(normFloor("Mezzanine")).toMatchObject({ code: "MEZZAN", name: "Mezzanine" });
  });
});

describe("warnings: actions vs notes", () => {
  it("merges repeated notes into one line with their pages and reports title-block mismatches once", () => {
    const p = assembleProposal([
      page(2, cls("floor_plan", "GROUND FLOOR PLAN", { title_block_title: "ARCHITECTURAL FLOOR PLAN" })), // same as heading? no → mismatch
      page(3, cls("floor_plan", "FIRST FLOOR PLAN", TB)),
      page(5, cls("electrical", "ELECTRICAL LAYOUT", TB)),
      p9,
      p10,
      page(11, cls("floor_plan", "Architectural floor plan", TB)), // the title block matches the heading here
      p12,
    ]);
    expect(notes(p)).toEqual([
      'Title block says "ARCHITECTURAL FLOOR PLAN" on pp. 2, 3, 5, 9, 10, 12',
      "ALL DIMENSIONS ARE IN FEET UNLESS NOTED OTHERWISE (pp. 9, 10, 12)",
      "Written dimensions are to be followed (p. 9)",
    ]);
    expect(p.warnings.find((w) => w.text.startsWith("Title block"))!.pages).toEqual([2, 3, 5, 9, 10, 12]);
  });

  it("treats unreadable pages and the cost cap as actions", () => {
    const states = [
      { pageNo: 1, classification: cls("column_layout", "Column layout"), extraction: null, error: null },
      { pageNo: 2, classification: null, extraction: null, error: "Spark returned invalid JSON after one retry" },
    ];
    expect(runActions(states, true, 1, (t) => t === "column_layout")).toEqual([
      { kind: "action", text: "Stopped at the cost cap ($1.00): pp. 1, 2 not read. The proposal covers the rest.", pages: [1, 2] },
      { kind: "action", text: "p. 2 could not be read (Spark returned invalid JSON after one retry).", pages: [2] },
    ]);
  });

  it("reads proposals stored before warnings had a kind", () => {
    const old = BoqProposal.parse({ items: [], discrepancies: [], warnings: ["p.9: something"] });
    expect(old.warnings).toEqual([{ kind: "note", text: "p.9: something", pages: [] }]);
  });

  it("the CLI prints actions first and only counts notes unless asked", () => {
    const p = assembleProposal([schedule, columnLayout(9), p9, p10, p12]);
    const out = formatProposal(p);
    expect(out.startsWith("ACTION NEEDED (3):\n  ! Column C2: the schedule (p.2) says 10, the layout (p.3) shows 9.")).toBe(true);
    expect(out).toContain("3 note(s) from the sheets (general notes, title blocks); show them with --notes.");
    expect(out).not.toContain("ALL DIMENSIONS");
    expect(formatProposal(p, { notes: true })).toContain("  - ALL DIMENSIONS ARE IN FEET UNLESS NOTED OTHERWISE (pp. 9, 10, 12)");
  });
});
