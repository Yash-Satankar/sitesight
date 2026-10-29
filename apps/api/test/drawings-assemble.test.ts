/** Code step of the drawing import: extracted sheets → proposed BOQ. Never invents quantities; flags discrepancies. */
import { describe, expect, it } from "vitest";
import { SheetExtraction, type PageClassification } from "@sitesight/shared";
import { assembleProposal, DEFAULT_SLAB_STAGES, normFloor, type AssembleInput } from "../src/services/drawings/assemble.js";
import { boqItemProblem } from "../src/services/boq-rules.js";

const cls = (sheet_type: PageClassification["sheet_type"], title: string, shows_masonry_walls = false): PageClassification => ({ sheet_type, title, notes: "", shows_masonry_walls });
const ev = (confidence = 0.9) => ({ evidence_text: "read", confidence });
const page = (pageNo: number, c: PageClassification, e: Partial<SheetExtraction> | null = null): AssembleInput => ({
  pageNo,
  classification: c,
  extraction: e ? SheetExtraction.parse(e) : null,
});

const schedule = page(2, cls("footing_column_schedule", "Footing & column schedule"), {
  columns: [
    { mark: "C1", size_text: '9"x9"', count: 2, floor: null, ...ev() },
    { mark: "C2", size_text: '9"x18"', count: 10, floor: null, ...ev(0.8) },
  ],
  footings: [
    { mark: "F1", length_mm: 1500, breadth_mm: 1500, depth_mm: 450, size_text: "5'x5'x1'6\"", count: 8, ...ev() },
    { mark: "F2", length_mm: 1200, breadth_mm: 1200, depth_mm: 450, size_text: "4'x4'x1'6\"", count: null, ...ev() },
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

describe("assembleProposal", () => {
  it("builds footings and columns from schedule + layout counts, with marks and sources", () => {
    const p = assembleProposal([schedule, columnLayout(10)]);
    const ftg = p.items.find((i) => i.code === "FTG")!;
    // F1 from the schedule (8), F2 only counted on the layout (4).
    expect(ftg).toMatchObject({ unit: "nos", plannedQty: 12, needsInput: null, measureMode: "visual_only" });
    expect(ftg.description).toBe("RCC footings: F1 1500×1500×450 mm ×8, F2 1200×1200×450 mm ×4");
    const col = p.items.find((i) => i.code === "COL")!;
    expect(col).toMatchObject({ unit: "nos", plannedQty: 12, measureMode: "count", segmentTargets: ["column"], needsInput: null });
    expect(col.description).toBe('RCC columns: C1 9"x9" ×2, C2 9"x18" ×10');
    expect(col.drawingSource).toBe("12 nos per Footing & column schedule p.2; Column layout plan p.3");
    expect(col.confidence).toBe(0.7); // weakest source
    expect(p.discrepancies).toEqual([]);
    for (const it of p.items) expect(boqItemProblem(it)).toBeNull();
  });

  it("flags schedule vs layout disagreements as discrepancies and asks for input instead of picking one", () => {
    const p = assembleProposal([schedule, columnLayout(9)]);
    expect(p.discrepancies).toEqual([
      expect.objectContaining({ element: "column", mark: "C2", scheduleCount: 10, layoutCount: 9, schedulePage: 2, layoutPage: 3 }),
    ]);
    expect(p.discrepancies[0]!.message).toBe("Column C2: the schedule (p.2) says 10, the layout (p.3) shows 9.");
    const col = p.items.find((i) => i.code === "COL")!;
    expect(col.plannedQty).toBe(0);
    expect(col.needsInput).toBe("drawing discrepancy for C2");
    expect(col.description).toContain("C2 9\"x18\" ×?");
    expect(col.drawingSource).toMatch(/^needs input \(drawing discrepancy for C2\)/);
  });

  it("never invents a count: marks without one make the item need input", () => {
    const p = assembleProposal([schedule]); // F2 has no count on the schedule and there is no layout
    const ftg = p.items.find((i) => i.code === "FTG")!;
    expect(ftg).toMatchObject({ plannedQty: 0, needsInput: "no count on the drawings for F2" });
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

  it("slabs are m3 only when area and thickness are both on the drawings, otherwise lot; default stages", () => {
    const p = assembleProposal([
      page(5, cls("slab_plan", "Roof slab plan"), {
        slabs: [
          { mark: "S1", floor: "GF", thickness_mm: 125, area_m2: 101.6, ...ev() },
          { mark: "S2", floor: "FF", thickness_mm: 125, area_m2: null, ...ev() },
        ],
      }),
    ]);
    const [s1, s2] = p.items;
    expect(s1).toMatchObject({ code: "SLB-GF", unit: "m3", plannedQty: 12.7, measureMode: "visual_only", stages: DEFAULT_SLAB_STAGES, needsInput: null });
    expect(s2).toMatchObject({ code: "SLB-FF", unit: "lot", plannedQty: 1, stages: DEFAULT_SLAB_STAGES });
    expect(p.warnings.some((w) => w.includes("no area on the drawings"))).toBe(true);
    for (const it of p.items) expect(boqItemProblem(it)).toBeNull();
  });

  it("adds plinth beams (lot) and brickwork (lot, visual only) only when the drawings show them", () => {
    const withBoth = assembleProposal([
      page(6, cls("plinth_beam", "Plinth beam layout"), { beams: [{ mark: "PB1", size_text: '9"x12"', kind: "plinth", ...ev() }, { mark: "B1", size_text: "9x15", kind: "roof", ...ev() }] }),
      page(7, cls("floor_plan", "Ground floor plan", true)),
      page(8, cls("electrical", "Electrical layout")),
    ]);
    expect(withBoth.items.map((i) => [i.code, i.unit, i.plannedQty, i.measureMode, i.description])).toEqual([
      ["PB", "lot", 1, "visual_only", 'Plinth beams PB1 9"x12"'],
      ["BWK", "lot", 1, "visual_only", "Brick masonry walls (as shown on the floor plan)"],
    ]);
    const without = assembleProposal([page(7, cls("floor_plan", "Ground floor plan", false)), page(8, cls("electrical", "Electrical"))]);
    expect(without.items).toEqual([]);
  });

  it("normalises floor labels", () => {
    expect(normFloor("Ground Floor")).toEqual({ code: "GF", name: "ground floor" });
    expect(normFloor("1st floor")).toEqual({ code: "FF", name: "first floor" });
    expect(normFloor(" ")).toBeNull();
    expect(normFloor("Mezzanine")).toEqual({ code: "MEZZAN", name: "Mezzanine" });
  });
});
