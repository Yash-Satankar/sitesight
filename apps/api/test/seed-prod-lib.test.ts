/** seed-prod helpers: only real site photos go to production; the Demo Residence drawing proposal fixes; the budget rule. */
import { describe, expect, it } from "vitest";
import type { BoqProposal, ProposedBoqItem } from "@sitesight/shared";
import { fitsBudget, isRealSitePhoto, prepareDemoResidenceBoq, TO_PHONE } from "../scripts/seed-prod-lib.js";
import { boqItemProblem } from "../src/services/boq-rules.js";

const item = (over: Partial<ProposedBoqItem>): ProposedBoqItem => ({
  key: over.code ?? "x",
  code: "X",
  description: "x",
  unit: "nos",
  plannedQty: 1,
  measureMode: "visual_only",
  segmentTargets: [],
  panelPlannedQty: null,
  stages: null,
  sequenceNo: null,
  zoneId: null,
  drawingSource: "per drawings",
  needsInput: null,
  confidence: 0.8,
  sources: [{ page: 10, sheet: "SLAB PLAN OF G.F ROOF SLAB", evidence_text: "S1", confidence: 0.8 }],
  ...over,
});
const reviewed = [
  { code: "FTG-1", description: "RCC footings", unit: "nos" as const, plannedQty: 10, measureMode: "visual_only" as const, segmentTargets: [], panelPlannedQty: null, stages: null, sequenceNo: 1, drawingSource: null },
  { code: "COL-GF", description: "RCC columns", unit: "nos" as const, plannedQty: 12, measureMode: "count" as const, segmentTargets: ["column" as const], panelPlannedQty: null, stages: null, sequenceNo: 2, drawingSource: null },
];

describe("isRealSitePhoto", () => {
  it("allows only the WhatsApp site photos", () => {
    expect(isRealSitePhoto("samples/demo-residence/v1/WhatsApp Image 2026-10-28 at 11.21.26 AM.jpeg")).toBe(true);
    expect(isRealSitePhoto("WhatsApp Image 2026-10-24 at 3.35.51 PM (1).jpeg")).toBe(true);
    expect(isRealSitePhoto("samples/image.jpeg")).toBe(false);
    expect(isRealSitePhoto("image (3).jpg")).toBe(false);
    expect(isRealSitePhoto("WhatsApp Image 2026-10-24 at 3.35.51 PM.png")).toBe(false);
    expect(isRealSitePhoto("WhatsApp Image 2025-01-01 at 1.00.00 PM.jpeg")).toBe(false);
  });

  it("the phone photos are all real site photos", () => {
    expect(Object.keys(TO_PHONE)).toEqual(["demo-residence-v2-slab-cast.jpg", "plinth-rebar-cages.jpg", "g2-frame-scaffolding.jpg"]);
    for (const src of Object.values(TO_PHONE)) expect(isRealSitePhoto(src)).toBe(true);
  });
});

describe("prepareDemoResidenceBoq", () => {
  it("merges split slab items into one G.F roof slab, 5\" RCC item and fills needs-input counts from the reviewed BOQ", () => {
    const proposal: BoqProposal = {
      items: [
        item({ code: "FTG", description: "RCC footings: F1 ×?", needsInput: "no count on the drawings for F1", plannedQty: 0 }),
        item({ code: "COL", description: "RCC columns: C1 ×2, C2 ×?", needsInput: "drawing discrepancy for C2", plannedQty: 0, measureMode: "count", segmentTargets: ["column"] }),
        item({ code: "SLB-GF", description: "G.F roof slab RCC (panels S1, S2; beams FB1, FB2, C.B)", unit: "lot", stages: null }),
        item({ code: "SLB-S1", description: "RCC slab S1", unit: "lot", sources: [{ page: 12, sheet: "R.C.C. DETAIL", evidence_text: 'S1 5"', confidence: 0.9 }] }),
      ],
      discrepancies: [],
      warnings: [],
    };
    const { items, fixes } = prepareDemoResidenceBoq(proposal, reviewed, 7);
    expect(items.map((i) => [i.code, i.plannedQty, i.unit, i.zoneId])).toEqual([
      ["FTG", 10, "nos", 7],
      ["COL", 12, "nos", 7],
      ["SLB-GF", 1, "lot", 7],
    ]);
    const slab = items.find((i) => i.code === "SLB-GF")!;
    expect(slab.description).toBe('G.F roof slab, 5" RCC (panels S1, S2; beams FB1, FB2, C.B)');
    expect(slab.stages?.map((s) => s.name)).toEqual(["shuttering", "reinforcement", "concreting"]);
    expect(slab.drawingSource).toBe("1 lot per SLAB PLAN OF G.F ROOF SLAB p.10; R.C.C. DETAIL p.12");
    expect(items.find((i) => i.code === "COL")!.drawingSource).toBe("12 nos entered by the engineer (drawings: drawing discrepancy for C2)");
    expect(fixes).toEqual([
      "FTG: needs input (no count on the drawings for F1) → 10 nos from the reviewed BOQ",
      "COL: needs input (drawing discrepancy for C2) → 12 nos from the reviewed BOQ",
      "slabs: merged SLB-GF, SLB-S1 into one SLB-GF item",
      'SLB-GF: added the 5" thickness from the slab schedule',
    ]);
    for (const i of items) expect(boqItemProblem(i)).toBeNull();
  });

  it("leaves a correct proposal alone apart from noting nothing", () => {
    const { items, fixes } = prepareDemoResidenceBoq(
      { items: [item({ code: "SLB-GF", description: 'G.F roof slab, 5" RCC (panels S1, S2)', unit: "lot" })], discrepancies: [], warnings: [] },
      reviewed,
      1,
    );
    expect(items[0]!.description).toBe('G.F roof slab, 5" RCC (panels S1, S2)');
    expect(fixes).toEqual([]);
  });
});

describe("fitsBudget", () => {
  it("starts a paid step only if its worst case still fits", () => {
    expect(fitsBudget(0, 1.0, 3)).toBe(true); // drawing import
    expect(fitsBudget(0.3, 1.5, 3)).toBe(true); // then a visit
    expect(fitsBudget(1.8, 1.5, 3)).toBe(false);
  });
});
