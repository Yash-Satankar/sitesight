/**
 * Screenshots of every screen for UI review: `pnpm ui-shots [--label before]`.
 *
 * Runs the real API in this process on a throwaway in-memory Postgres (PGlite) with local file storage, seeds a demo
 * project over HTTP (project, zones, BOQ, visits, photos) and writes what an agent run would have produced
 * (segments + masks, a panel measurement, trace steps, assessments, photo requests) straight into that database.
 * No Meta calls, nothing written to the real database. Then starts Vite and captures each screen at 390×844 and
 * 1280×800 into samples/out/ui/<timestamp>[-label]/.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webDir, "../..");
const apiDir = join(repoRoot, "apps/api");

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    label: { type: "string", default: "" },
    only: { type: "string" }, // comma-separated screen names
    "api-port": { type: "string", default: "8798" },
    "web-port": { type: "string", default: "5198" },
  },
});

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const outDir = join(repoRoot, "samples/out/ui", `${stamp}${args.label ? `-${args.label}` : ""}`);
const storageDir = join(outDir, "storage");
const API = `http://localhost:${args["api-port"]}`;

// Must be set before any apps/api module loads (config.ts reads them once; dotenv does not override).
process.env.DATABASE_URL = "pglite:memory";
process.env.STORAGE_LOCAL_DIR = storageDir;
process.env.PORT = args["api-port"];

async function http<T = unknown>(method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string }): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: raw ? { "Content-Type": raw.type } : body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: raw ? new Uint8Array(raw.data) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("API did not start");
}

/** Site photos from samples/ (gitignored, local only); synthetic images when there are none. */
async function demoImages(n: number): Promise<Buffer[]> {
  const dirs = ["samples/demo-residence/v2", "samples/demo-residence/v1", "samples"].map((d) => join(repoRoot, d));
  const files: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of (await readdir(d)).sort()) if ([".jpg", ".jpeg", ".png"].includes(extname(f).toLowerCase())) files.push(join(d, f));
    } catch {
      // folder missing
    }
  }
  const out: Buffer[] = [];
  for (const f of files.slice(0, n)) out.push(await readFile(f));
  const sharp = createRequire(join(apiDir, "package.json"))("sharp") as typeof import("sharp");
  while (out.length < n) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fb7c9"/><stop offset="1" stop-color="#7a6a58"/></linearGradient></defs><rect width="1200" height="900" fill="url(#g)"/><rect x="${200 + out.length * 40}" y="250" width="90" height="600" fill="#b8b2a7"/><rect x="800" y="250" width="90" height="600" fill="#b8b2a7"/><rect x="290" y="520" width="510" height="330" fill="#a0523d"/></svg>`;
    out.push(await sharp(Buffer.from(svg)).jpeg().toBuffer());
  }
  return out;
}

async function seed() {
  const { parseBoqJson } = await import("../../api/scripts/dry-run-lib.js");
  const { db, schema } = await import("../../api/src/db/client.js");
  const { rasterToFrameMask } = await import("../../api/src/meta/masks.js");
  const { putObject } = await import("../../api/src/services/storage.js");
  const { eq } = (await import("../../api/node_modules/drizzle-orm/index.js")) as typeof import("drizzle-orm"); // the API's own copy

  const boq = parseBoqJson(await readFile(join(repoRoot, "samples/boq-demo-residence.json"), "utf8"));
  const project = await http<{ id: number }>("POST", "/projects", { name: "Demo Residence", locationLabel: "Nagpur · G+1 house" });
  const empty = await http<{ id: number }>("POST", "/projects", { name: "Patel Warehouse — Phase 2 extension with a long project name", locationLabel: "Wardha MIDC" });
  const gf = await http<{ id: number }>("POST", `/projects/${project.id}/zones`, { name: "GF", sortOrder: 0 });
  await http("POST", `/projects/${project.id}/zones`, { name: "GF – East wall", sortOrder: 1 });
  await http("POST", `/projects/${project.id}/zones`, { name: "Terrace", sortOrder: 2 });
  const items = [
    ...boq.items.map(({ zone: _zone, ...it }) => ({ ...it, zoneId: gf.id })),
    {
      code: "BWK-GF",
      description: '9" brick masonry in CM 1:6, ground-floor walls between columns',
      unit: "m2",
      plannedQty: 85,
      measureMode: "area",
      segmentTargets: ["brickwork"],
      panelPlannedQty: 9.5,
      zoneId: gf.id,
    },
  ];
  const saved = await http<{ id: number; code: string }[]>("PUT", `/projects/${project.id}/boq`, { items });
  const item = (code: string) => saved.find((s) => s.code === code)!.id;

  const images = await demoImages(4);
  async function addPhoto(visitId: number, img: Buffer) {
    const { uploadUrl, storageKey } = await http<{ uploadUrl: string; storageKey: string }>("POST", `/visits/${visitId}/photos/presign`, {
      contentType: "image/jpeg",
      kind: "photo",
    });
    await http("PUT", uploadUrl, undefined, { data: img, type: "image/jpeg" });
    return http<{ id: number; width: number; height: number }>("POST", `/visits/${visitId}/photos`, { zoneId: gf.id, storageKey });
  }
  async function segment(photo: { id: number; width: number; height: number }, concept: string, idx: number, box: [number, number, number, number], verified: boolean | null, rejectReason?: string) {
    const [fx, fy, fw, fh] = box;
    const x = Math.round(fx * photo.width), y = Math.round(fy * photo.height), w = Math.round(fw * photo.width), h = Math.round(fh * photo.height);
    const { png } = await rasterToFrameMask(new Uint8Array(w * h).fill(1), w, h, x, y, photo.width, photo.height);
    const key = `masks/ui-${photo.id}-${concept}-${idx}.png`;
    await putObject(key, png, "image/png");
    const [s] = await db
      .insert(schema.segments)
      .values({ photoId: photo.id, concept, instanceIdx: idx, maskKey: key, bbox: [x, y, w, h], areaPx: w * h, score: 0.88, verified, rejectReason: rejectReason ?? null })
      .returning();
    return s!.id;
  }
  const setStatus = (visitId: number, status: "assessed" | "reviewed" | "processing") => db.update(schema.visits).set({ status }).where(eq(schema.visits.id, visitId));

  // ---- visit 1: reviewed, accepted assessments (the "previous visit") ----
  const v1 = (await http<{ id: number }>("POST", `/projects/${project.id}/visits`, { visitDate: "2026-10-20" })).id;
  const p1 = await addPhoto(v1, images[1]!);
  const acc = (visitId: number, code: string, percentComplete: number, extra: Record<string, unknown> = {}) =>
    db
      .insert(schema.assessments)
      .values({ visitId, boqItemId: item(code), percentComplete, confidence: 0.82, rationale: "Seen in the photos.", status: "accepted", ...extra })
      .returning();
  for (const [code, pct, stage] of [["FTG-1", 100, null], ["COL-GF", 50, null], ["SLB-GF", 25, "shuttering"]] as const) {
    const [a] = await acc(v1, code, pct, { stageReached: stage });
    await db.insert(schema.assessmentEvidence).values({ assessmentId: a!.id, photoId: p1.id, segmentIds: [] });
  }
  await setStatus(v1, "reviewed");

  // ---- visit 2: assessed, full trace (the demo centrepiece) ----
  const v2 = (await http<{ id: number }>("POST", `/projects/${project.id}/visits`, { visitDate: "2026-10-28" })).id;
  const photo = await addPhoto(v2, images[0]!);
  const photo2 = await addPhoto(v2, images[2]!);
  const c1 = await segment(photo, "column", 0, [0.12, 0.18, 0.07, 0.62], true);
  const c2 = await segment(photo, "column", 1, [0.78, 0.2, 0.07, 0.6], true);
  const pole = await segment(photo, "column", 2, [0.47, 0.05, 0.02, 0.85], false, "bamboo scaffolding pole");
  const b1 = await segment(photo, "brickwork", 0, [0.2, 0.5, 0.56, 0.28], true);
  const b2 = await segment(photo, "brickwork", 1, [0.3, 0.15, 0.2, 0.1], false, "stacked bricks on the slab, not laid masonry");
  const b3 = await segment(photo, "brickwork", 2, [0.88, 0.6, 0.1, 0.2], false, "neighbouring building");
  const [panel] = await db
    .insert(schema.panelMeasurements)
    .values({
      visitId: v2,
      photoId: photo.id,
      targetSegmentIds: [b1],
      panel: { polygon: [[0.19, 0.2], [0.78, 0.2], [0.78, 0.8], [0.19, 0.8]].map(([x, y]) => [Math.round(x! * photo.width), Math.round(y! * photo.height)]) },
      panelAreaPx: 1000,
      coveredAreaPx: 640,
      fraction: 0.64,
      clipped: false,
      warnings: [],
    })
    .returning();
  const [run] = await db.insert(schema.agentRuns).values({ visitId: v2, status: "finished", steps: 18, costUsd: 0.1874, inputTokens: 48210, outputTokens: 3120 }).returning();

  const [askPb] = await db
    .insert(schema.askBacks)
    .values({
      visitId: v2,
      zoneId: gf.id,
      boqItemId: item("FTG-1"),
      instruction: "Stand at the north-east corner and photograph the footing pits along the east wall, including the column starters",
      reason: "The footings on the east side are hidden behind stacked bricks; I can't confirm they were cast.",
    })
    .returning();

  const steps: { kind: string; name: string | null; payload: unknown }[] = [
    { kind: "model", name: null, payload: { text: "I'll start by reading the BOQ and the photos for this visit, then check last visit's progress for the slab and columns." } },
    { kind: "tool_call", name: "list_boq_items", payload: {} },
    { kind: "tool_result", name: "list_boq_items", payload: saved.map((s) => ({ id: s.id, code: s.code })) },
    { kind: "tool_call", name: "list_photos", payload: {} },
    { kind: "tool_result", name: "list_photos", payload: [{ id: photo.id }, { id: photo2.id }] },
    { kind: "tool_call", name: "get_previous_assessment", payload: { boq_item_id: item("SLB-GF") } },
    { kind: "tool_result", name: "get_previous_assessment", payload: { found: true, percent_complete: 25, stage_reached: "shuttering" } },
    { kind: "tool_call", name: "segment_photo", payload: { photo_id: photo.id, targets: ["column", "brickwork"] } },
    {
      kind: "tool_result",
      name: "segment_photo",
      payload: {
        photo_id: photo.id,
        targets: [
          { target: "column", instances: [{ segment_id: c1 }, { segment_id: c2 }, { segment_id: pole }] },
          { target: "brickwork", instances: [{ segment_id: b1 }, { segment_id: b2 }, { segment_id: b3 }] },
        ],
      },
    },
    { kind: "model", name: null, payload: { text: "Segment 3 is thin and runs past the slab edge — looks like scaffolding rather than a cast column. Checking each detection against the photo." } },
    { kind: "tool_call", name: "verify_segments", payload: { photo_id: photo.id } },
    { kind: "rejection", name: null, payload: { segment_id: pole, reason: "bamboo scaffolding pole", target: "column", photo_id: photo.id } },
    { kind: "rejection", name: null, payload: { segment_id: b2, reason: "stacked bricks on the slab, not laid masonry", target: "brickwork", photo_id: photo.id } },
    { kind: "rejection", name: null, payload: { segment_id: b3, reason: "neighbouring building", target: "brickwork", photo_id: photo.id } },
    { kind: "tool_result", name: "verify_segments", payload: { photo_id: photo.id, kept: [c1, c2, b1], rejected: [pole, b2, b3] } },
    { kind: "notice", name: "context_compacted", payload: { message: "Photo verified; image replaced by a text summary to save context." } },
    { kind: "tool_call", name: "measure", payload: { photo_id: photo.id, mode: "panel", target_segment_ids: [b1] } },
    { kind: "tool_result", name: "measure", payload: { mode: "panel", photo_id: photo.id, fraction: 0.64, measurement_id: panel!.id, warnings: [] } },
    { kind: "tool_call", name: "record_assessment", payload: { boq_item_id: item("BWK-GF"), percent_complete: 64, panel_measurement_ids: [panel!.id], rationale: "One bay measured: 64% of the wall between the two columns is laid." } },
    { kind: "tool_result", name: "record_assessment", payload: { ok: true, percent_complete: 64, qty_done: 6.08, confidence: 0.74, basis: "observed" } },
    { kind: "tool_call", name: "record_assessment", payload: { boq_item_id: item("SLB-GF"), stage_reached: "reinforcement", rationale: "Bottom and top mesh visible across the slab; no concrete yet." } },
    { kind: "tool_result", name: "record_assessment", payload: { ok: true, percent_complete: 60, stage_reached: "reinforcement", qty_done: 7.62, confidence: 0.81, basis: "observed" } },
    { kind: "tool_call", name: "record_assessment", payload: { boq_item_id: item("PB-1"), percent_complete: 100, basis: "inferred", rationale: "Brick walls stand on the plinth line, so the plinth beams must be cast." } },
    { kind: "tool_result", name: "record_assessment", payload: { ok: true, percent_complete: 100, confidence: 0.5, basis: "inferred" } },
    { kind: "tool_call", name: "measure", payload: { photo_id: photo2.id, mode: "count", segment_ids: [] } },
    { kind: "tool_result", name: "measure", payload: { error: "Photo " + photo2.id + " has no verified segments. Call segment_photo and verify_segments first." } },
    { kind: "tool_call", name: "request_photo", payload: { boq_item_id: item("FTG-1"), instruction: askPb!.instruction, reason: askPb!.reason } },
    { kind: "tool_result", name: "request_photo", payload: { ask_back_id: askPb!.id, instruction: askPb!.instruction } },
    { kind: "tool_call", name: "finish", payload: { summary: "4 items assessed (1 inferred), 1 photo requested." } },
    { kind: "tool_result", name: "finish", payload: { ok: true } },
  ];
  await db.insert(schema.agentSteps).values(steps.map((s, idx) => ({ runId: run!.id, idx, kind: s.kind as "model", name: s.name, payload: s.payload as object })));

  const prop = async (code: string, pct: number, extra: Record<string, unknown>, evidence: { photoId: number; segmentIds: number[] }[]) => {
    const [a] = await db
      .insert(schema.assessments)
      .values({ visitId: v2, boqItemId: item(code), percentComplete: pct, confidence: 0.8, rationale: "", ...extra })
      .returning();
    await db.insert(schema.assessmentEvidence).values(evidence.map((e) => ({ assessmentId: a!.id, ...e })));
  };
  await prop("COL-GF", 100, {
    qtyDone: 12,
    confidence: 0.86,
    status: "accepted",
    rationale: "All 12 ground-floor columns are cast to slab level; formwork stripped on the two visible in photo 1 and on the rest in photo 2. Two thin vertical detections were scaffolding poles and were rejected.",
  }, [{ photoId: photo.id, segmentIds: [c1, c2] }]);
  await prop("SLB-GF", 60, {
    stageReached: "reinforcement",
    qtyDone: 7.62,
    confidence: 0.81,
    rationale: "Bottom and top mesh visible across the whole slab with cover blocks in place; chairs fixed; no concrete poured yet. Shuttering complete since the last visit. The electrical conduits are laid but junction boxes at the north end are not visible from this angle.",
  }, [{ photoId: photo2.id, segmentIds: [] }]);
  await prop("BWK-GF", 64, {
    qtyDone: 6.08,
    confidence: 0.74,
    panelMeasurementIds: [panel!.id],
    deviation: "Brick courses on the east bay are laid without the DPC layer shown on drawing A-102.",
    rationale: "One bay measured between columns C2 and C3: 64% of the designed wall area is laid.",
  }, [{ photoId: photo.id, segmentIds: [b1] }]);
  await prop("PB-1", 100, {
    basis: "inferred",
    confidence: 0.5,
    rationale: "Brick walls stand on the plinth line, so the plinth beams must be cast. Not seen directly.",
  }, [{ photoId: photo.id, segmentIds: [] }]);
  await setStatus(v2, "assessed");

  // ---- visit 3: agent running (live trace mid-run) ----
  const v3 = (await http<{ id: number }>("POST", `/projects/${project.id}/visits`, { visitDate: "2026-10-29" })).id;
  const p3 = await addPhoto(v3, images[3]!);
  const [run3] = await db.insert(schema.agentRuns).values({ visitId: v3, status: "running", costUsd: 0.0412 }).returning();
  await db.insert(schema.agentSteps).values([
    { runId: run3!.id, idx: 0, kind: "tool_call", name: "list_boq_items", payload: {} },
    { runId: run3!.id, idx: 1, kind: "tool_result", name: "list_boq_items", payload: saved.map((s) => ({ id: s.id })) },
    { runId: run3!.id, idx: 2, kind: "model", name: null, payload: { text: "One new photo of the terrace. Looking for columns first." } },
    { runId: run3!.id, idx: 3, kind: "tool_call", name: "segment_photo", payload: { photo_id: p3.id, targets: ["column"] } },
  ]);
  await setStatus(v3, "processing");

  // ---- visit 4: draft, for the capture screen (earlier visit's photo request shows at the top) ----
  const v4 = (await http<{ id: number }>("POST", `/projects/${project.id}/visits`, { visitDate: "2026-10-30" })).id;
  await addPhoto(v4, images[1]!);

  return { projectId: project.id, emptyProjectId: empty.id, zoneId: gf.id, v2, v3, v4, askBackId: askPb!.id };
}

async function main() {
  await mkdir(storageDir, { recursive: true });
  await import("../../api/src/index.js");
  await waitForHealth();
  const ids = await seed();
  console.log(`seeded: project #${ids.projectId}, visits #${ids.v2} (assessed) #${ids.v3} (running) #${ids.v4} (draft)`);

  const { createServer } = await import("vite");
  const vite = await createServer({
    root: webDir,
    configFile: join(webDir, "vite.config.ts"),
    mode: "development",
    logLevel: "warn",
    server: { port: Number(args["web-port"]), strictPort: true, host: "127.0.0.1" },
  });
  await vite.listen();
  const WEB = `http://127.0.0.1:${args["web-port"]}`;

  // A photo to upload on the capture screen (proves the strip refreshes with the real thumbnail).
  const uploadFile = join(outDir, "upload.jpg");
  await writeFile(uploadFile, (await demoImages(3))[2]!);
  const screens: { name: string; path: string; ready: string; act?: (page: import("playwright").Page) => Promise<void> }[] = [
    { name: "01-projects", path: "/", ready: "text=Demo Residence" },
    { name: "02-project", path: `/projects/${ids.projectId}`, ready: "text=SLB-GF" },
    { name: "03-project-empty", path: `/projects/${ids.emptyProjectId}`, ready: "text=Patel Warehouse" },
    { name: "04-boq-upload", path: `/projects/${ids.emptyProjectId}/boq`, ready: "text=Choose the BOQ" },
    { name: "05-capture", path: `/visits/${ids.v4}/capture`, ready: "text=GF" },
    {
      name: "05b-capture-uploaded",
      path: `/visits/${ids.v4}/capture`,
      ready: "text=GF",
      act: async (page) => {
        await page.locator("input[type=file][accept='image/*']").setInputFiles(uploadFile);
        await page.getByRole("button", { name: /Upload & take next/ }).click();
        await page.getByText(/In this visit · 2 photos/).waitFor({ timeout: 15_000 });
      },
    },
    { name: "06-capture-request", path: `/visits/${ids.v4}/capture?zone=${ids.zoneId}&askBack=${ids.askBackId}`, ready: "text=footing" },
    { name: "07-visit-assessed", path: `/visits/${ids.v2}`, ready: "text=Measured" },
    { name: "08-visit-running", path: `/visits/${ids.v3}`, ready: "text=columns" },
    { name: "09-review", path: `/visits/${ids.v2}/review`, ready: "text=SLB-GF" },
    { name: "10-report", path: `/visits/${ids.v2}/report`, ready: "main" },
  ];
  const only = args.only?.split(",");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const viewports = [
    { tag: "390", width: 390, height: 844, mobile: true },
    { tag: "1280", width: 1280, height: 800, mobile: false },
  ];
  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.warn(`  [page error] ${e.message}`));
    for (const s of screens.filter((x) => !only || only.some((o) => x.name.includes(o)))) {
      await page.goto(`${WEB}${s.path}`);
      try {
        await page.locator(s.ready).first().waitFor({ timeout: 15_000 });
      } catch {
        console.warn(`  ${s.name}: "${s.ready}" not found; capturing anyway`);
      }
      if (s.act) {
        try {
          await s.act(page);
        } catch (err) {
          console.warn(`  ${s.name}: action failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
        }
      }
      await page.waitForTimeout(1200); // SSE replay, smooth scroll
      // Scroll through the page so lazy images load, then back to the top for the capture.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      });
      await page.evaluate(async () => {
        await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => ((i.onload = r), (i.onerror = r))))));
      });
      await page.waitForTimeout(300);
      const file = join(outDir, `${s.name}-${vp.tag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  ${file}`);
      // What a phone actually shows first: the viewport, with the sticky bars where they really sit.
      if (vp.mobile) await page.screenshot({ path: join(outDir, `${s.name}-${vp.tag}-fold.png`) });
    }
    await ctx.close();
  }
  await browser.close();
  await vite.close();
  await rm(storageDir, { recursive: true, force: true });
  console.log(`\nScreenshots in ${outDir}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
