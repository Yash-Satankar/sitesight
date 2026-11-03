/** Eval harness: case schema, scoring against labels, consistency across runs, summary/report and the budget. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EvalBudget,
  consistency,
  parseCases,
  reportMarkdown,
  scoreDrawingRun,
  scorePhotoRun,
  summarize,
  compareVerdict,
  rejectNoteConcepts,
  summaryTable,
  type DrawingCase,
  type PhotoCase,
  type PhotoRunOutput,
  type RunRecord,
} from "../scripts/eval-lib.js";

const casesPath = fileURLToPath(new URL("../../../samples/eval/cases.json", import.meta.url));

const photoCase: PhotoCase = {
  labelled_by: "human",
  id: "c1",
  kind: "photos",
  description: "",
  photos: ["a.jpg"],
  boq: "b.json",
  expected: {
    "SLB-GF": { stage: "reinforcement", basis: "observed", tolerance: 0 },
    "COL-GF": { count: 10, tolerance: 1 },
    "PB-1": { basis: "inferred", tolerance: 0 },
  },
  should_reject: [
    { note: "rebar cages are not cast columns", keywords: ["rebar", "cage"] },
    { note: "bamboo props are not columns", keywords: ["bamboo"] },
  ],
};

const output = (over: Partial<PhotoRunOutput> = {}): PhotoRunOutput => ({
  assessments: [
    { code: "SLB-GF", stageReached: "Reinforcement", qtyDone: 7.6, basis: "observed" },
    { code: "COL-GF", stageReached: null, qtyDone: 11, basis: "observed" },
  ],
  itemStatus: { "PB-1": "awaiting photo (ask-back #4)" },
  detections: { total: 5, kept: 3, rejected: 2, unverified: 0 },
  rejections: [
    { segmentId: 7, concept: "column", reason: "Rebar cage, not a cast column", photo: "a.jpg" },
    { segmentId: 9, concept: "column", reason: "duplicate of #8", photo: "a.jpg" },
  ],
  outcome: "assessed",
  error: null,
  ...over,
});

describe("cases file", () => {
  it("the shipped samples/eval/cases.json is valid and has photo and drawing cases", () => {
    const file = parseCases(readFileSync(casesPath, "utf8"));
    expect(file.cases.map((c) => c.kind)).toContain("photos");
    const drawings = file.cases.find((c) => c.id === "demo-residence-drawings")!;
    expect(drawings).toMatchObject({ kind: "drawings", pdf: "samples/demo-residence.pdf", expected: { columns: 12, footings: 10, slabs: { floor: "GF", count: 1, thickness: '5"' } } });
    expect(file.cases.find((c) => c.id === "cages-no-cast-columns")).toMatchObject({ expected: { "COL-GF": { count: 0 } } });
  });

  it("rejects bad cases with readable errors", () => {
    expect(() => parseCases(JSON.stringify({ cases: [{ id: "x", kind: "photos", photos: [], boq: "b", expected: {} }] }))).toThrow(/cases\.0\.photos/);
    expect(() =>
      parseCases(JSON.stringify({ cases: [{ id: "x", kind: "photos", photos: ["a"], boq: "b", expected: { A: { tolerance: 1 } } }] })),
    ).toThrow(/an item label needs stage, count or basis/);
    const dup = { id: "x", kind: "drawings", pdf: "a.pdf", expected: {} };
    expect(() => parseCases(JSON.stringify({ cases: [dup, dup] }))).toThrow(/case ids must be unique/);
  });
});

describe("scorePhotoRun", () => {
  it("checks stage (exact, case-insensitive), count within tolerance and basis; missing items say why", () => {
    const { checks, rejectNotes } = scorePhotoRun(photoCase, output());
    expect(checks.map((c) => [c.item, c.metric, c.expected, c.actual, c.pass])).toEqual([
      ["SLB-GF", "stage", "reinforcement", "Reinforcement", true],
      ["SLB-GF", "basis", "observed", "observed", true],
      ["COL-GF", "count", "10 ± 1", "11", true],
      ["PB-1", "basis", "inferred", "—", false],
    ]);
    expect(checks.find((c) => c.item === "PB-1")!.note).toBe("not assessed (awaiting photo (ask-back #4))");
    expect(rejectNotes).toEqual([
      { note: "rebar cages are not cast columns", matched: true, status: "caught", example: '#7 column: "Rebar cage, not a cast column"' },
      // No per-concept counts in this output: any detection (5) counts as something it could have been.
      { note: "bamboo props are not columns", matched: false, status: "not_caught", example: "5 column detection(s), none rejected as this" },
    ]);
  });

  it("a labelled false positive SAM never detected is 'not detected (nothing to reject)', not a miss", () => {
    const tarp = { ...photoCase, should_reject: [{ note: "tarps are not walls", keywords: ["tarp", "net"] }, { note: "poles are not columns", keywords: ["pole"] }] };
    // Columns detected (and none rejected as poles), no brickwork detected at all.
    const out = output({ rejections: [], detectionsByConcept: { column: 3 } });
    expect(scorePhotoRun(tarp, out).rejectNotes).toEqual([
      { note: "tarps are not walls", matched: false, status: "not_detected", example: "no brickwork detection: nothing to reject" },
      { note: "poles are not columns", matched: false, status: "not_caught", example: "3 column detection(s), none rejected as this" },
    ]);
    expect(rejectNoteConcepts({ keywords: ["neighbour"] })).toEqual(["column", "brickwork"]);
    expect(rejectNoteConcepts({ keywords: ["tarp"], concepts: ["column"] })).toEqual(["column"]);
  });

  it("fails counts outside the tolerance and wrong stages", () => {
    const { checks } = scorePhotoRun(photoCase, output({ assessments: [{ code: "SLB-GF", stageReached: "concreting", qtyDone: 12.7, basis: "observed" }, { code: "COL-GF", stageReached: null, qtyDone: 12, basis: "observed" }] }));
    expect(checks.filter((c) => !c.pass).map((c) => `${c.item} ${c.metric}`)).toEqual(["SLB-GF stage", "COL-GF count", "PB-1 basis"]);
  });

  it("an expected count of 0 passes when the agent records 0 or nothing, and fails when it counts cages", () => {
    const zero: PhotoCase = { ...photoCase, expected: { "COL-GF": { count: 0, tolerance: 0 } } };
    expect(scorePhotoRun(zero, output({ assessments: [] })).checks[0]).toMatchObject({ pass: true, actual: "—" });
    expect(scorePhotoRun(zero, output({ assessments: [{ code: "COL-GF", stageReached: null, qtyDone: 0, basis: "observed" }] })).checks[0]!.pass).toBe(true);
    expect(scorePhotoRun(zero, output({ assessments: [{ code: "COL-GF", stageReached: null, qtyDone: 6, basis: "observed" }] })).checks[0]!.pass).toBe(false);
  });
});

describe("scoreDrawingRun", () => {
  const dc: DrawingCase = { id: "d", kind: "drawings", labelled_by: "draft", description: "", pdf: "x.pdf", expected: { columns: 12, footings: 10, slabs: { floor: "GF", count: 1, thickness: '5"' } } };
  const item = (code: string, plannedQty: number, description = code, needsInput: string | null = null) => ({ code, description, plannedQty, unit: "nos", needsInput });

  it("sums columns and footings, counts slab items per floor and checks the thickness as drawn", () => {
    const checks = scoreDrawingRun(dc, {
      items: [item("FTG", 10), item("COL-GF", 8), item("COL-FF", 4), item("SLB-GF", 1, 'G.F roof slab, 5" RCC (panels S1, S2; beams FB1, FB2, C.B)')],
      actions: [],
      error: null,
    });
    expect(checks.map((c) => [c.metric, c.actual, c.pass])).toEqual([
      ["columns", "12", true],
      ["footings", "10", true],
      ["slab_items", "1", true],
      ["slab_thickness", 'G.F roof slab, 5" RCC (panels S1, S2; beams FB1, FB2, C.B)', true],
    ]);
  });

  it("fails needs-input totals, split slabs and missing items", () => {
    const checks = scoreDrawingRun(dc, {
      items: [item("COL", 0, "RCC columns", "drawing discrepancy for C2"), item("SLB-GF", 1, "G.F roof slab RCC"), item("SLB-GF-2", 1, "slab S1")],
      actions: [],
      error: null,
    });
    expect(checks.map((c) => [c.metric, c.actual, c.pass, c.note])).toEqual([
      ["columns", "needs input", false, "COL: drawing discrepancy for C2"],
      ["footings", "—", false, "no item proposed"],
      ["slab_items", "2", false, undefined],
      ["slab_thickness", "G.F roof slab RCC | slab S1", false, undefined],
    ]);
  });
});

const rec = (caseId: string, run: number, actuals: Record<string, string>, extra: Partial<RunRecord> = {}): RunRecord => ({
  caseId,
  kind: "photos",
  run,
  status: "done",
  costUsd: 0.2,
  latencyMs: 60_000,
  checks: Object.entries(actuals).map(([k, actual]) => {
    const [item, metric] = k.split(" ") as [string, "stage"];
    return { item, metric, expected: "reinforcement", actual, pass: actual === "reinforcement" };
  }),
  rejectNotes: [{ note: "rebar cages are not cast columns", matched: run !== 2 }],
  detections: { total: 4, kept: 3, rejected: 1, unverified: 0 },
  rejections: [],
  ...extra,
});

describe("consistency, summary and report", () => {
  const records = [
    rec("c1", 1, { "SLB-GF stage": "reinforcement", "PB-1 basis": "inferred" }),
    rec("c1", 2, { "SLB-GF stage": "reinforcement", "PB-1 basis": "observed" }),
    rec("c1", 3, { "SLB-GF stage": "shuttering", "PB-1 basis": "inferred" }, { costUsd: 0.3, turns: 9 }),
    rec("c2", 1, { "SLB-GF stage": "reinforcement" }),
    { caseId: "c2", kind: "photos" as const, run: 2, status: "skipped" as const, reason: "eval cost cap reached", costUsd: 0, latencyMs: 0, checks: [] },
  ];

  it("counts answers identical across completed runs (skipped runs don't count)", () => {
    expect(consistency(records)).toEqual([
      {
        caseId: "c1",
        runs: 3,
        stable: 0,
        total: 2,
        answers: [
          { key: "SLB-GF stage", values: ["reinforcement", "reinforcement", "shuttering"] },
          { key: "PB-1 basis", values: ["inferred", "observed", "inferred"] },
        ],
      },
    ]);
  });

  it("summarises accuracy, false positives, consistency, cost and latency, and prints a README table", () => {
    const s = summarize(records);
    expect(s).toMatchObject({
      stage: { pass: 3, total: 4 },
      basis: { pass: 0, total: 3 },
      detections: { total: 16, rejected: 4 },
      rejectNotes: { pass: 3, total: 4, notDetected: 0 },
      consistency: { pass: 0, total: 2 },
      runs: { done: 4, failed: 0, skipped: 1 },
      costUsd: 0.9,
      avgCostPerRunUsd: 0.225,
      avgLatencyMs: 60000,
      avgTurns: 9, // only runs that report turns
    });
    const table = summaryTable(s, { runsPerCase: 3, cases: 2, model: "muse-spark-1.3", date: "2026-11-01" });
    expect(table.split("\n").slice(0, 5)).toEqual([
      "Eval 2026-11-01 · 2 cases × 3 run(s) · muse-spark-1.3 · 0 failed, 1 skipped",
      "",
      "| Metric | Result |",
      "|---|---|",
      "| Stage, exact match | 3/4 (75%) |",
    ]);
    expect(table).toContain("| SAM detections rejected by the agent | 4/16 (25%) |");
    expect(table).toContain("| Same answer across runs | 0/2 (0%) |");
    expect(table).toContain("| Total eval cost | $0.90 |");
    expect(table).toContain("| Model turns per run (avg) | 9 |");
    expect(summaryTable(s, { runsPerCase: 3, cases: 2, model: "m", date: "d", fastPath: true }).split("\n")[0]).toContain("· AGENT_FAST_PATH=true");
  });

  it("writes a markdown report with per-case runs, answers and differing runs", () => {
    const md = reportMarkdown(records, [{ ...photoCase, id: "c1" }, { ...photoCase, id: "c2" }], {
      runsPerCase: 3,
      model: "m",
      date: "2026-11-01",
      maxCostUsd: 10,
      labelsNote: "draft labels",
      outDir: "/tmp/x",
    });
    expect(md).toContain("# SiteSight eval — 2026-11-01");
    expect(md).toContain("> Labels: draft labels");
    expect(md).toContain("## c1");
    expect(md).toContain("| 3 | done | $0.30 | 60 s | 9 | 0/2 |");
    expect(md).toContain("| 2 | skipped (eval cost cap reached) | $0.00 | 0 s | — | — |");
    expect(md).toContain("- SLB-GF stage: reinforcement / reinforcement / shuttering");
    expect(md).toContain("**Labelled false positives** (caught / not caught / not detected by SAM, over runs):");
    expect(md).toContain("| rebar cages are not cast columns | 2 | 1 | 0 |"); // c1: caught in runs 1 and 3, missed in run 2
  });
});

describe("EvalBudget", () => {
  it("gives each run at most what is left and nothing once the cap is spent", () => {
    const b = new EvalBudget(2);
    expect(b.capFor(1.5)).toBe(1.5);
    b.add(1.2);
    expect(b.capFor(1.5)).toBeCloseTo(0.8);
    b.add(0.81); // a run can overshoot by its last call
    expect(b.remaining()).toBe(0);
    expect(b.capFor(1.5)).toBeNull();
  });
});

describe("compareVerdict", () => {
  const base = summarize([rec("c1", 1, { "SLB-GF stage": "reinforcement" })]);
  const with_ = (over: Partial<typeof base>) => ({ ...base, ...over });
  it("keeps the new setting only if no accuracy metric drops and latency improves", () => {
    expect(compareVerdict(base, with_({ avgLatencyMs: base.avgLatencyMs! - 1000 }))).toEqual({ keep: true, drops: [], latencyImproved: true });
    expect(compareVerdict(base, with_({ avgLatencyMs: base.avgLatencyMs! + 1000 })).keep).toBe(false);
    const worse = compareVerdict(base, with_({ avgLatencyMs: 1, stage: { pass: 0, total: base.stage.total } }));
    expect(worse).toMatchObject({ keep: false, drops: ["Stage, exact match"] });
    expect(compareVerdict(base, with_({ avgLatencyMs: 1, runs: { ...base.runs, failed: 1 } })).drops).toEqual(["Failed runs"]);
  });
});

describe("labelled false positives in the summary", () => {
  it("leaves 'not detected' out of the rate and reports it next to it", () => {
    const r = (status: "caught" | "not_caught" | "not_detected") => ({
      caseId: "c",
      kind: "photos" as const,
      run: 1,
      status: "done" as const,
      costUsd: 0,
      latencyMs: 0,
      checks: [],
      rejectNotes: [{ note: "n", matched: status === "caught", status }],
    });
    const s = summarize([r("caught"), r("not_caught"), r("not_detected"), r("not_detected")]);
    expect(s.rejectNotes).toEqual({ pass: 1, total: 2, notDetected: 2 });
    expect(summaryTable(s, { runsPerCase: 1, cases: 1, model: "m", date: "d" })).toContain(
      "| False detections caught (labelled) | 1/2 (50%) · 2 not detected (nothing to reject) |",
    );
  });
});
