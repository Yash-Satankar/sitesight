/**
 * Two-visit dry run on the Demo Residence BOQ with a scripted Meta: visit 1's assessments are accepted before
 * visit 2, the agent sees them, and the progress table shows the change (including a regression).
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { create, store } = vi.hoisted(() => ({ create: vi.fn(), store: new Map<string, Buffer>() }));

vi.mock("../src/meta/client.js", () => ({ metaClient: () => ({ responses: { create } }) }));
vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("../src/db/schema.js");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
  return { db, schema, sql: { end: async () => {} } };
});
vi.mock("../src/services/storage.js", () => {
  let n = 0;
  return {
    getObject: async (key: string) => store.get(key)!,
    putObject: async (key: string, body: Buffer) => void store.set(key, body),
    presignGet: async (key: string) => `file:///${key}`,
    presignPut: async () => {
      throw new Error("no presign in tests");
    },
    newKey: (prefix: string) => `${prefix}/${++n}`,
  };
});

import { runDryRun } from "../scripts/dry-run.js";

const BOQ_DEMO_RESIDENCE = fileURLToPath(new URL("../../../samples/boq-demo-residence.json", import.meta.url));

type Body = { model: string; input: { type?: string; role?: string; content?: unknown; output?: string }[] };
type Ctx = { photos: { photo_id: number }[]; previous_visit_assessments: { boq_item_id: number; percent_complete: number; stage_reached: string | null }[] };
const context = (b: Body): Ctx => JSON.parse(String(b.input[0]!.content).split("Visit context:\n")[1]!);
const toolOutputs = (b: Body) => b.input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output!));

let seq = 0;
const call = (name: string, args: unknown) => ({
  id: `r${++seq}`,
  output: [{ type: "function_call", id: `fc${seq}`, call_id: `c${seq}`, name, arguments: JSON.stringify(args), status: "completed" }],
  output_text: "",
  usage: { input_tokens: 10, output_tokens: 10 },
});
const itemId = (b: Body, code: string) => (toolOutputs(b)[0] as { boq_item_id: number; code: string }[]).find((i) => i.code === code)!.boq_item_id;
const evidence = (b: Body) => [{ photo_id: context(b).photos[0]!.photo_id, segment_ids: [] }];

const VISIT_1: ((b: Body) => unknown)[] = [
  () => call("list_boq_items", {}),
  (b) => call("record_assessment", { boq_item_id: itemId(b, "SLB-GF"), stage_reached: "shuttering", confidence: 0.6, rationale: "Shuttering complete, no steel yet.", evidence: evidence(b) }),
  (b) => call("record_assessment", { boq_item_id: itemId(b, "COL-GF"), percent_complete: 50, qty_done: 6, confidence: 0.6, rationale: "6 of 12 columns cast.", evidence: evidence(b) }),
  () => call("finish", { summary: "visit 1 done" }),
];
const VISIT_2: ((b: Body) => unknown)[] = [
  () => call("list_boq_items", {}),
  (b) => call("get_previous_assessment", { boq_item_id: itemId(b, "SLB-GF") }),
  (b) =>
    call("record_assessment", {
      boq_item_id: itemId(b, "SLB-GF"),
      stage_reached: "concreting",
      confidence: 0.65,
      rationale: "Was shuttering on the last visit; slab now cast.",
      evidence: evidence(b),
    }),
  (b) => call("record_assessment", { boq_item_id: itemId(b, "COL-GF"), percent_complete: 40, qty_done: 5, confidence: 0.55, rationale: "Only 5 columns visible.", evidence: evidence(b) }),
  () => call("finish", { summary: "visit 2 done" }),
];

const contexts: Ctx[] = [];
const previousLookups: unknown[] = [];
let visitDirs: string[];
let outDir: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "sitesight-multi-"));
  outDir = join(root, "out");
  await mkdir(outDir);
  const jpg = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#888" } }).jpeg().toBuffer();
  visitDirs = [join(root, "v1"), join(root, "v2")];
  for (const dir of visitDirs) {
    await mkdir(dir);
    await writeFile(join(dir, "a.jpg"), jpg); // loose photos → the BOQ's single zone "GF"
  }

  create.mockImplementation(async (body: Body) => {
    const ctx = context(body);
    const step = toolOutputs(body).length; // one tool call per turn
    if (step === 0) contexts.push(ctx);
    if (step === 2 && ctx.previous_visit_assessments.length) previousLookups.push(toolOutputs(body)[1]);
    const script = ctx.previous_visit_assessments.length ? VISIT_2 : VISIT_1;
    return script[step]!(body);
  });
});

describe("multi-visit dry run", () => {
  it("runs visits in order, carries accepted assessments forward and reports progress", async () => {
    const lines: string[] = [];
    const result = await runDryRun({ visitDirs, boqPath: BOQ_DEMO_RESIDENCE, outDir, out: (l) => lines.push(l) });
    const text = lines.join("\n");

    expect(result.visits.map((v) => v.outcome)).toEqual(["assessed", "assessed"]);
    expect(text).toMatch(/=== Visit 1\/2: .*v1 ===/);
    expect(text).toMatch(/=== Visit 2\/2: .*v2 ===/);
    expect(text.match(/photo \d+: GF \/ a\.jpg/g)).toHaveLength(2); // same zone in both visits
    expect(text).toMatch(/SLB-GF {2}Ground-floor roof slab.*\[visual only, stages shuttering 25% → reinforcement 35% → concreting 40%\]/);

    // Visit 1 accepted before visit 2; the agent saw it in context and via get_previous_assessment.
    expect(text).toMatch(/Accepted 2 assessment\(s\) from visit 1 \(simulated engineer review\)\./);
    expect(contexts[0]!.previous_visit_assessments).toEqual([]);
    expect(contexts[1]!.previous_visit_assessments.map((p) => [p.percent_complete, p.stage_reached]).sort()).toEqual([
      [25, "shuttering"],
      [50, null],
    ]);
    expect(previousLookups[0]).toMatchObject({ found: true, percent_complete: 25, stage_reached: "shuttering" });

    // Visit 2 results: staged slab and the column regression recorded as a deviation.
    const v2 = result.visits[1]!;
    expect(v2.assessments.find((a) => a.code === "SLB-GF")).toMatchObject({ percentComplete: 100, stageReached: "concreting", qtyDone: 12.7 });
    expect(v2.assessments.find((a) => a.code === "COL-GF")!.deviation).toMatch(/^Progress went backwards: 50% at the visit of .*, now 40%\.$/);

    // Progress since last visit.
    expect(text).toMatch(/Progress since last visit:/);
    expect(text).toMatch(/BOQ item +\| previous +\| now +\| change/);
    expect(text).toMatch(/SLB-GF Ground-floor roof slab.*\| 25% \(shuttering\) +\| 100% \(concreting\) +\| \+75 pts/);
    expect(text).toMatch(/COL-GF RCC columns.*\| 50% +\| 40% +\| -10 pts, went backwards \(deviation\)/);
    expect(text).toMatch(/FTG-1 RCC footings.*\| not assessed +\| not assessed +\| —/);
    expect(v2.progress.find((r) => r.code === "SLB-GF")).toEqual({
      code: "SLB-GF",
      description: 'Ground-floor roof slab, 5" (125 mm) RCC',
      previous: "25% (shuttering)",
      now: "100% (concreting)",
      change: "+75 pts",
      delta: 75,
    });

    expect(text).toMatch(/=== All visits ===\nVisits: 2 {3}Steps: \d+ {3}Total cost: \$0\.0018/); // 9 Spark calls × $0.0002
    const report = JSON.parse(await readFile(join(outDir, "dry-run.json"), "utf8"));
    expect(report.visits).toHaveLength(2);
    expect(report.visits[1].progress).toHaveLength(4);
  });
});
