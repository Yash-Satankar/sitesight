import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCase,
  countTolerance,
  isStockImage,
  itemKind,
  labelPhoto,
  reviewDraft,
  unlabelledPhotos,
  type LabelIO,
} from "../scripts/eval-label-lib.js";
import { headlineNote, parseCases, reportMarkdown, type PhotoCase, type RunRecord } from "../scripts/eval-lib.js";

/** IO that answers from a queue and records what was printed and opened. */
function scripted(answers: string[]) {
  const printed: string[] = [];
  const opened: string[] = [];
  const next = (prompt: string) => {
    if (!answers.length) throw new Error(`no scripted answer left for: ${prompt}`);
    return answers.shift()!;
  };
  const io: LabelIO = {
    key: async (prompt, choices) => {
      const a = next(prompt);
      if (!choices.includes(a)) throw new Error(`"${a}" is not one of ${choices.join("/")} for: ${prompt}`);
      return a;
    },
    line: async (prompt, def) => {
      const a = next(prompt);
      return a === "" && def !== undefined ? def : a;
    },
    print: (t) => void printed.push(t),
    open: (p) => void opened.push(p),
  };
  return { io, printed, opened, left: () => answers.length };
}

const RESIDENCE = [
  { code: "FTG-1", description: "RCC footings F1/F2", measureMode: "visual_only" },
  { code: "COL-GF", description: "RCC columns, ground floor", measureMode: "count" },
  { code: "PB-1", description: "Plinth beams PB1/PB2", measureMode: "visual_only" },
  { code: "SLB-GF", description: "Ground-floor roof slab", measureMode: "visual_only", stages: [{ name: "shuttering" }, { name: "reinforcement" }, { name: "concreting" }] },
];
const DEMO_WALLS = { code: "GF-2", description: "Brickwork 230 mm in CM 1:6, ground floor", measureMode: "area" };

describe("photos to label", () => {
  it("skips stock images and photos a case already uses (by content), and de-duplicates copies", () => {
    const root = mkdtempSync(join(tmpdir(), "label-"));
    mkdirSync(join(root, "samples", "run1"), { recursive: true });
    writeFileSync(join(root, "samples", "a.jpeg"), "photo A");
    writeFileSync(join(root, "samples", "b.jpeg"), "photo B");
    writeFileSync(join(root, "samples", "b copy.jpeg"), "photo B");
    writeFileSync(join(root, "samples", "images(3).jpg"), "stock");
    writeFileSync(join(root, "samples", "image.jpeg"), "stock");
    writeFileSync(join(root, "samples", "boq.json"), "{}");
    writeFileSync(join(root, "samples", "run1", "used.jpeg"), "photo A"); // same bytes as a.jpeg
    const cases = parseCases(
      JSON.stringify({ cases: [{ id: "x", kind: "photos", photos: ["samples/run1/used.jpeg"], boq: "b.json", expected: { A: { basis: "observed" } } }] }),
    );
    expect(unlabelledPhotos(root, cases)).toEqual(["samples/b copy.jpeg"]);
    expect(isStockImage("images (12).jpg")).toBe(true);
    expect(isStockImage("WhatsApp Image 2026-10-24 at 3.35.50 PM.jpeg")).toBe(false);
  });
});

describe("answers → labels", () => {
  it("asks the right question per item", () => {
    expect(RESIDENCE.map(itemKind)).toEqual(["generic", "count", "plinth", "stage"]);
    expect(itemKind(DEMO_WALLS)).toBe("walls");
  });

  it("scores stage, count and basis; keeps material and 'not visible' as observations", () => {
    const c = buildCase(
      {
        photo: "samples/p.jpeg",
        boq: "samples/boq-demo-residence.json",
        items: {
          "SLB-GF": { kind: "stage", stage: "reinforcement" },
          "COL-GF": { kind: "count", visible: 8 },
          "PB-1": { kind: "visibility", visible: "h" },
          "FTG-1": { kind: "visibility", visible: "n" },
          "GF-2": { kind: "walls", visible: "y", material: "AAC" },
        },
        falsePositives: ["1", "3"],
        notes: "slab steel tied",
      },
      new Set(["demo-residence-p"]),
    );
    expect(c).toMatchObject({
      id: "demo-residence-p-2",
      labelled_by: "human",
      description: "slab steel tied",
      expected: {
        "SLB-GF": { stage: "reinforcement", basis: "observed" },
        "COL-GF": { count: 8, tolerance: 1 },
        "PB-1": { basis: "inferred" },
        "GF-2": { basis: "observed" },
      },
      observations: { "FTG-1": "not built or not in view", "GF-2 material": "AAC" },
    });
    expect(c.expected["FTG-1"]).toBeUndefined();
    expect(c.should_reject.map((r) => r.keywords[0])).toEqual(["scaffold", "rebar"]);
    expect([countTolerance(5), countTolerance(6)]).toEqual([0, 1]);
    // The result is a valid case for the eval.
    expect(() => parseCases(JSON.stringify({ cases: [c] }))).not.toThrow();
  });
});

const draft = {
  id: "cages",
  kind: "photos",
  description: "rebar cages",
  photos: ["samples/run2/x.jpeg"],
  boq: "samples/eval/boq-cages.json",
  expected: { "COL-GF": { count: 0, tolerance: 0 }, "PB-1": { basis: "observed" } },
  should_reject: [{ note: "cages are not columns", keywords: ["cage"] }],
  labelled_by: "draft",
};

describe("reviewing a draft case", () => {
  it("confirm marks it human and opens the photo", async () => {
    const s = scripted(["c"]);
    expect(await reviewDraft(draft, s.io)).toMatchObject({ id: "cages", labelled_by: "human", expected: draft.expected });
    expect(s.opened).toEqual(["samples/run2/x.jpeg"]);
  });

  it("skip leaves it as it is; q quits", async () => {
    expect(await reviewDraft(draft, scripted(["s"]).io)).toBeNull();
    expect(await reviewDraft(draft, scripted(["q"]).io)).toBe("quit");
  });

  it("edit goes field by field: Enter keeps, - removes, new values replace", async () => {
    const s = scripted([
      "e",
      "", // COL-GF.stage (none) → keep none
      "2", // COL-GF.count 0 → 2
      "", // COL-GF.tolerance keep 0
      "", // COL-GF.basis none
      "", // PB-1.stage none
      "inferred", // PB-1.basis observed → inferred
      "n", // drop "cages are not columns"
      "4", // add tree
      "", // description keep
    ]);
    const out = (await reviewDraft(draft, s.io)) as unknown as PhotoCase;
    expect(out.labelled_by).toBe("human");
    expect(out.expected).toEqual({ "COL-GF": { count: 2, tolerance: 0 }, "PB-1": { basis: "inferred" } });
    expect(out.should_reject.map((r) => r.keywords[0])).toEqual(["tree"]);
    expect(out.description).toBe("rebar cages");
    expect(s.left()).toBe(0);
  });
});

describe("labelling a new photo", () => {
  const boqs = [
    { key: "d", path: "samples/boq-demo.json", items: [DEMO_WALLS] },
    { key: "r", path: "samples/boq-demo-residence.json", items: RESIDENCE },
  ];

  it("walks every item of the chosen BOQ with single keys", async () => {
    const s = scripted(["r", "y", "n", "h", "2", "14", "notes here"]);
    const out = (await labelPhoto("samples/WhatsApp 1.jpeg", boqs, new Set(), s.io)) as unknown as PhotoCase & { observations: Record<string, string> };
    expect(out).toMatchObject({
      labelled_by: "human",
      boq: "samples/boq-demo-residence.json",
      photos: ["samples/WhatsApp 1.jpeg"],
      expected: { "FTG-1": { basis: "observed" }, "PB-1": { basis: "inferred" }, "SLB-GF": { stage: "reinforcement", basis: "observed" } },
      observations: { "COL-GF": "columns not visible" },
      description: "notes here",
    });
    expect(out.should_reject.map((r) => r.keywords[0])).toEqual(["scaffold", "tree"]);
    expect(s.opened).toEqual(["samples/WhatsApp 1.jpeg"]);
  });

  it("re-asks a bad column count, and asks wall material", async () => {
    const s = scripted(["d", "y", "c", "", ""]);
    const out = (await labelPhoto("samples/p.jpeg", boqs, new Set(), s.io)) as unknown as PhotoCase & { observations: Record<string, string> };
    expect(out.expected).toEqual({ "GF-2": { basis: "observed", tolerance: 0 } });
    expect(out.observations).toEqual({ "GF-2 material": "concrete block" });

    const bad = scripted(["r", "s", "lots", "3", "s", "s", "", ""]);
    const out2 = (await labelPhoto("samples/q.jpeg", boqs, new Set(), bad.io)) as unknown as PhotoCase;
    expect(out2.expected).toEqual({ "COL-GF": { count: 3, tolerance: 0 } });
    expect(bad.printed).toContain("  type a number, n or s");
  });

  it("skips a photo with nothing scorable, and supports s / q at the BOQ question", async () => {
    expect(await labelPhoto("samples/p.jpeg", boqs, new Set(), scripted(["d", "n", "n", "", ""]).io)).toBeNull();
    expect(await labelPhoto("samples/p.jpeg", boqs, new Set(), scripted(["s"]).io)).toBeNull();
    expect(await labelPhoto("samples/p.jpeg", boqs, new Set(), scripted(["q"]).io)).toBe("quit");
  });
});

describe("headline numbers use human-labelled cases only", () => {
  const base = { kind: "photos", description: "", photos: ["p"], boq: "b", should_reject: [] } as const;
  const cases = parseCases(
    JSON.stringify({
      cases: [
        { ...base, id: "h", expected: { A: { stage: "x" } }, labelled_by: "human" },
        { ...base, id: "d", expected: { A: { stage: "x" } } },
      ],
    }),
  ).cases;
  const rec = (caseId: string, pass: boolean, labelledBy: "human" | "draft"): RunRecord => ({
    caseId,
    kind: "photos",
    run: 1,
    labelledBy,
    status: "done",
    costUsd: 0.1,
    latencyMs: 1000,
    checks: [{ item: "A", metric: "stage", expected: "x", actual: pass ? "x" : "y", pass }],
  });

  it("reports the human cases in the headline and the drafts separately", () => {
    expect(cases.map((c) => c.labelled_by)).toEqual(["human", "draft"]);
    const md = reportMarkdown([rec("h", true, "human"), rec("d", false, "draft")], cases, {
      runsPerCase: 1,
      model: "m",
      date: "d",
      maxCostUsd: 1,
      labelsNote: "",
      outDir: "/x",
    });
    expect(md).toContain("**Headline: 1 human-labelled case × 1 run** (1 draft case(s) excluded from the headline).");
    const [headline, all] = md.split("### All cases");
    expect(headline).toContain("| Stage, exact match | 1/1 (100%) |");
    expect(all).toContain("| Stage, exact match | 1/2 (50%) |");
    expect(headlineNote(0, 5, 3)).toMatch(/^\*\*Headline: 0 human-labelled cases\*\* \(5 draft\)\. Run `pnpm eval-label`/);
  });
});
