/**
 * End-to-end dry run with a scripted Meta: real agent loop, real tools, PGlite, in-memory storage,
 * and the committed samples/boq-demo.json. The scripted model reads ids from the context and tool
 * results the way the real one would.
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
import { env } from "../src/config.js";

const BOQ_DEMO = fileURLToPath(new URL("../../../samples/boq-demo.json", import.meta.url));

// Real SAM output sample (two instances in a 320×334 frame), from @meta-sam/parser's README.
const SAM_TWO_COLUMNS =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.8|><|mask;x=0;y=0;c=0.8;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334;c=0.6|><|mask;x=0;y=0;c=0.6;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n";

type Body = { model: string; input: { type?: string; role?: string; content?: unknown; output?: string }[] };

const context = (b: Body) => JSON.parse(String(b.input[0]!.content).split("Visit context:\n")[1]!);
const toolOutputs = (b: Body) => b.input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output!));

let seq = 0;
const call = (name: string, args: unknown) => ({
  id: `r${++seq}`,
  output: [{ type: "function_call", id: `fc${seq}`, call_id: `c${seq}`, name, arguments: JSON.stringify(args), status: "completed" }],
  output_text: seq === 1 ? "Starting with the BOQ and photos." : "",
  usage: { input_tokens: 10, output_tokens: 10 }, // $0.0002 per call at the test prices
});

/** The scripted agent: one function per Spark call, in order. */
const SCRIPT: ((b: Body) => unknown)[] = [
  () => call("list_boq_items", {}),
  (b) => call("segment_photo", { photo_id: context(b).photos[0].photo_id, targets: ["column"] }),
  (b) => call("view_photo", { photo_id: context(b).photos[0].photo_id, with_masks: true }),
  (b) => {
    const legend = toolOutputs(b).at(-1).mask_legend as { segment_id: number }[];
    return call("verify_segments", {
      photo_id: context(b).photos[0].photo_id,
      decisions: [
        { segment_id: legend[0]!.segment_id, keep: true, reason: "RCC column C1" },
        { segment_id: legend[1]!.segment_id, keep: false, reason: "scaffolding pole" },
      ],
    });
  },
  (b) => {
    const items = toolOutputs(b)[0] as { boq_item_id: number; code: string }[];
    const kept = toolOutputs(b).at(-1).kept as number[];
    return call("record_assessment", {
      boq_item_id: items.find((i) => i.code === "GF-1")!.boq_item_id,
      percent_complete: 25,
      confidence: 0.72,
      rationale: "4 of 16 ground-floor columns cast in the east bay photo.",
      evidence: [{ photo_id: context(b).photos[0].photo_id, segment_ids: kept }],
    });
  },
  (b) =>
    call("request_photo", {
      zone_id: context(b).zones.find((z: { name: string }) => z.name === "GF-West").zone_id,
      instruction: "Photograph the west bay brickwork square-on from about 4 m away.",
      reason: "Brickwork extent not visible in the current photo.",
    }),
  () => call("finish", { summary: "Columns assessed; brickwork needs a photo." }),
];

let photosDir: string;
let outDir: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "sitesight-dry-run-"));
  photosDir = join(root, "photos");
  outDir = join(root, "out");
  await mkdir(outDir);
  const jpg = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#8a8a8a" } }).jpeg().toBuffer();
  for (const zone of ["GF-East", "GF-West"]) {
    await mkdir(join(photosDir, zone), { recursive: true });
    await writeFile(join(photosDir, zone, "a.jpg"), jpg);
  }
  await writeFile(join(photosDir, "GF-East", "a.jpg.txt"), "East bay, columns C1 to C4 cast last week.");

  create.mockImplementation(async (body: Body) => {
    if (body.model === env.SAM_MODEL) {
      const prompt = (body.input[0]!.content as { text?: string }[])[0]!.text;
      return { id: "sam", output: [], output_text: prompt === "concrete column" ? SAM_TWO_COLUMNS : "", usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const step = SCRIPT[seq];
    if (!step) throw new Error("scripted agent ran out of steps");
    return step(body);
  });
});

describe("agent dry run", () => {
  it("runs the agent end to end and prints trace, results table, ask-backs, steps and cost", async () => {
    const lines: string[] = [];
    const summary = await runDryRun({ photosDir, boqPath: BOQ_DEMO, outDir, out: (l) => lines.push(l) });
    const text = lines.join("\n");

    // Setup
    expect(text).toMatch(/photo \d+: GF-East \/ a\.jpg {2}\(transcript: "East bay, columns C1 to C4 cast last week\."\)/);
    expect(text).toMatch(/photo \d+: GF-West \/ a\.jpg/);
    expect(text).toMatch(/GF-2 {2}Brickwork 230 mm.*\[area via brickwork, panel 12\.5 m2\]/);

    // Streamed trace
    expect(text).toMatch(/\[model\] \(10 in \/ 10 out tokens\) Starting with the BOQ and photos\./);
    expect(text).toMatch(/-> segment_photo\(\{"photo_id":\d+,"targets":\["column"\]\}\)/);
    expect(text).toMatch(/<- segment_photo: column: 2 instance\(s\)/);
    expect(text).toMatch(/<- verify_segments: kept \[\d+\], rejected \[\d+\], still unverified \[\]/);
    expect(text).toMatch(/x rejected segment #\d+ \(column\) on photo \d+: scaffolding pole/);
    expect(text).toMatch(/cost so far \$0\.\d{4} \/ \$0\.0100/);

    // Results
    expect(text).toMatch(/BOQ item +\| % done \| qty_done +\| conf\. \| evidence photos \| rationale/);
    expect(text).toMatch(/GF-1 RCC columns, ground floor.*\| 25% +\| — +\| 0\.72 +\| \d+ +\| 4 of 16 ground-floor columns/);
    expect(text).toMatch(/PB-1 Plinth beam.*\| — .*\(not assessed\)/);
    expect(text).toMatch(/\[open\] GF-West: Photograph the west bay brickwork square-on from about 4 m away\./);
    expect(text).toMatch(/Total steps: \d+ {3}Total cost: \$0\.0049/); // 7 Spark calls × $0.0002 + 1 SAM request × $0.0035

    expect(summary).toMatchObject({ outcome: "needs_input", error: null });
    expect(summary.assessments).toEqual([expect.objectContaining({ code: "GF-1", percentComplete: 25, confidence: 0.72 })]);
    expect(summary.askBacks).toEqual([expect.objectContaining({ zone: "GF-West", status: "open" })]);
    expect(summary.costUsd).toBeCloseTo(0.0049, 6);

    const report = JSON.parse(await readFile(join(outDir, "dry-run.json"), "utf8"));
    expect(report.assessments[0].rationale).toBe("4 of 16 ground-floor columns cast in the east bay photo.");
  });

  it("refuses BOQ items that name a zone with no photo folder", async () => {
    const bad = join(outDir, "bad-zone.json");
    await writeFile(bad, JSON.stringify([{ code: "X-1", description: "Columns", unit: "nos", plannedQty: 4, measureMode: "count", segmentTargets: ["column"], zone: "Floor 9" }]));
    await expect(runDryRun({ photosDir, boqPath: bad, outDir, out: () => {} })).rejects.toThrow(/X-1 → "Floor 9".*Folders: GF-East, GF-West/);
  });

  it("refuses inconsistent BOQ items before calling Meta", async () => {
    const callsBefore = create.mock.calls.length;
    const bad = join(outDir, "bad-mode.json");
    await writeFile(bad, JSON.stringify([{ code: "X-2", description: "Plaster", unit: "m2", plannedQty: 10, measureMode: "area", segmentTargets: [] }]));
    await expect(runDryRun({ photosDir, boqPath: bad, outDir, out: () => {} })).rejects.toThrow(/X-2: area items need a segment target/);
    expect(create.mock.calls.length).toBe(callsBefore);
  });
});
