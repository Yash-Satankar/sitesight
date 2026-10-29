import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeStep, discoverZones, parseBoqJson, parseDryRunArgs } from "../scripts/dry-run-lib.js";

describe("parseDryRunArgs", () => {
  it("requires --photos and --boq", () => {
    expect(parseDryRunArgs(["--photos", "p", "--boq", "b.json"])).toEqual({ visits: ["p"], boq: "b.json", help: false });
    expect(parseDryRunArgs(["--", "--photos=p", "--boq=b.xlsx"])).toMatchObject({ visits: ["p"], boq: "b.xlsx" });
    expect(parseDryRunArgs(["--visits", "samples/demo-residence/v1, samples/demo-residence/v2,", "--boq", "b.json"]).visits).toEqual(["samples/demo-residence/v1", "samples/demo-residence/v2"]);
    expect(() => parseDryRunArgs(["--photos", "p", "--visits", "a,b", "--boq", "b.json"])).toThrow(/either --photos .* or --visits/);
    expect(() => parseDryRunArgs(["--boq", "b.json"])).toThrow(/--photos <dir> or --visits <dir1,dir2,…> is required/);
    expect(() => parseDryRunArgs(["--photos", "p"])).toThrow(/--boq .* is required/);
    expect(() => parseDryRunArgs(["--photo", "p"])).toThrow(/Unknown option/);
    expect(parseDryRunArgs(["-h"]).help).toBe(true);
  });
});

describe("discoverZones", () => {
  async function tree(files: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "zones-"));
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(join(root, rel, ".."), { recursive: true });
      await writeFile(join(root, rel), body);
    }
    return root;
  }

  it("makes one zone per photo subfolder, in natural order, and reads transcripts", async () => {
    const root = await tree({
      "Floor 10/a.jpg": "x",
      "Floor 2/b.png": "x",
      "Floor 2/b.txt": "west wall done",
      "empty/notes.md": "x",
      "out/old.jpg": "x", // spike/dry-run output folder is skipped
    });
    const zones = await discoverZones(root);
    expect(zones.map((z) => z.name)).toEqual(["Floor 2", "Floor 10"]);
    expect(zones[0]!.photos[0]).toMatchObject({ file: "b.png", transcript: "west wall done" });
  });

  it("puts loose photos in one zone named after the folder", async () => {
    const root = await tree({ "img (2).jpg": "x", "img (10).jpg": "x", "img (1).JPG": "x" });
    const zones = await discoverZones(root);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.name).toBe(basename(root));
    expect(zones[0]!.photos.map((p) => p.file)).toEqual(["img (1).JPG", "img (2).jpg", "img (10).jpg"]);
  });

  it("fails clearly when there are no photos", async () => {
    const root = await tree({ "readme.txt": "x" });
    await expect(discoverZones(root)).rejects.toThrow(/No \.jpg\/\.png\/\.webp photos found/);
  });
});

describe("parseBoqJson", () => {
  it("accepts the committed demo BOQ", async () => {
    const text = await readFile(fileURLToPath(new URL("../../../samples/boq-demo.json", import.meta.url)), "utf8");
    const { items, zones } = parseBoqJson(text);
    expect(zones).toBeNull();
    expect(items.map((i) => [i.code, i.measureMode, i.segmentTargets, i.panelPlannedQty])).toEqual([
      ["PB-1", "visual_only", [], null],
      ["GF-1", "count", ["column"], null],
      ["RF-1", "visual_only", [], null],
      ["GF-2", "area", ["brickwork"], 12.5],
    ]);
  });

  it("accepts a bare array and reports every invalid item at once", () => {
    expect(parseBoqJson(JSON.stringify([{ code: "A", description: "x", unit: "nos", plannedQty: 1, measureMode: "visual_only" }])).items).toHaveLength(1);
    expect(() =>
      parseBoqJson(
        JSON.stringify({
          items: [
            { code: "A", description: "x", unit: "sqft", plannedQty: 1, measureMode: "visual_only" },
            { code: "B", description: "x", unit: "m2", plannedQty: -3, measureMode: "area" },
          ],
        }),
      ),
    ).toThrow(/A: unit .*\n {2}B: plannedQty/);
    expect(() => parseBoqJson("{nope")).toThrow(/not valid JSON/);
    expect(() => parseBoqJson("{}")).toThrow(/must be an array/);
  });
});

describe("describeStep", () => {
  it("formats tool results the reader cares about", () => {
    expect(describeStep({ kind: "tool_result", name: "measure", payload: { mode: "panel", fraction: 0.42, covered_area_px: 42, panel_area_px: 100, measurement_id: 3, warnings: [] } })).toEqual([
      "  <- measure: panel fraction 0.42 (42/100 px), measurement #3",
    ]);
    expect(describeStep({ kind: "tool_result", name: "measure", payload: { error: "measure only accepts verified segments." } })[0]).toMatch(/ERROR measure only accepts/);
    expect(describeStep({ kind: "error", name: "cost_limit", payload: { message: "Visit cost $1.51 exceeded" } })).toEqual(["!! Visit cost $1.51 exceeded"]);
  });
});

describe("DATABASE_URL=pglite:memory", () => {
  it("gives an in-memory database with migrations applied", () => {
    const apiDir = fileURLToPath(new URL("..", import.meta.url));
    const code = `const { db, schema, sql } = await import("./src/db/client.ts");
const [p] = await db.insert(schema.projects).values({ name: "x" }).returning();
const rows = await db.select().from(schema.panelMeasurements);
console.log(JSON.stringify({ id: p.id, panelRows: rows.length }));
await sql.end();`;
    const res = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: "pglite:memory" },
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(JSON.parse(res.stdout.trim().split("\n").at(-1)!)).toEqual({ id: 1, panelRows: 0 });
  }, 120_000); // child process + PGlite start-up is slow when the suite runs in parallel
});

describe("--visits from PowerShell", () => {
  const dirs = new Set(["samples/demo-residence/v1", "samples/demo-residence/v2", "site photos/day 1"]);
  const isDir = (p: string) => dirs.has(p);

  it("splits a space-joined list (unquoted a,b in PowerShell) when every part is a folder", async () => {
    const { expandVisitDirs } = await import("../scripts/dry-run-lib.js");
    expect(expandVisitDirs(["samples/demo-residence/v1 samples/demo-residence/v2"], isDir)).toEqual(["samples/demo-residence/v1", "samples/demo-residence/v2"]);
    expect(expandVisitDirs(["samples/demo-residence/v1", "samples/demo-residence/v2"], isDir)).toEqual(["samples/demo-residence/v1", "samples/demo-residence/v2"]);
  });

  it("keeps existing folders that contain spaces whole", async () => {
    const { expandVisitDirs } = await import("../scripts/dry-run-lib.js");
    expect(expandVisitDirs(["site photos/day 1", "samples/demo-residence/v2"], isDir)).toEqual(["site photos/day 1", "samples/demo-residence/v2"]);
  });

  it("names missing folders and shows the PowerShell quoting", async () => {
    const { expandVisitDirs } = await import("../scripts/dry-run-lib.js");
    expect(() => expandVisitDirs(["samples/demo-residence/v1 samples/demo-residence/v9"], isDir)).toThrow(
      /Visit folder not found: "samples\/demo-residence\/v1 samples\/demo-residence\/v9"\. In PowerShell, quote the list: --visits "samples\/demo-residence\/v1,samples\/demo-residence\/v2"/,
    );
  });

  it("accepts repeated --visits flags", () => {
    expect(parseDryRunArgs(["--visits", "a", "--visits", "b,c", "--boq", "x.json"]).visits).toEqual(["a", "b", "c"]);
  });
});
