// Recordings of the real app (local stack). Each scene marks its waits so composition can speed them up 3–4×.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mark } from "./media.js";
import { sqlValue } from "./stack.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type Browser = any;

export interface Ctx {
  base: string;
  repoRoot: string;
  outDir: string;
  config: any;
  state: any;
  saveState(): void;
  browser: Browser;
  /** Separate browser with a fake microphone playing the voice-note WAV. */
  micBrowser: () => Promise<Browser>;
  spendGate(estimateUsd: number, what: string): void;
}

export interface Recording {
  clip: string; // relative to outDir
  marks: Mark[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (ctx: Ctx, p: string) => join(ctx.repoRoot, p);

// ---- API (off camera) ----

export async function api(ctx: Ctx, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${ctx.base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ctx.base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Project with a zone and (optionally) a BOQ; reused when the state already has it. */
export async function ensureProject(ctx: Ctx, key: "demo" | "plinth" | "g2", withBoq: boolean): Promise<number> {
  const def = ctx.config.projects[key];
  const known = ctx.state.projects?.[key];
  if (known) {
    try {
      await api(ctx, "GET", `/projects/${known}`);
      return known;
    } catch {
      // gone (fresh database): create again
    }
  }
  const p = await api(ctx, "POST", "/projects", { name: def.name, locationLabel: def.location });
  await api(ctx, "POST", `/projects/${p.id}/zones`, { name: def.zone, sortOrder: 0 });
  if (withBoq) await api(ctx, "PUT", `/projects/${p.id}/boq`, { items: def.boq.map((it: any) => ({ zoneId: null, stages: null, ...it })) });
  ctx.state.projects = { ...(ctx.state.projects ?? {}), [key]: p.id };
  ctx.saveState();
  return p.id;
}

export async function waitVisitDone(ctx: Ctx, visitId: number, timeoutMs = 10 * 60_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await api(ctx, "GET", `/visits/${visitId}`);
    const status = v.visit?.status ?? v.status;
    if (!["queued", "processing", "draft"].includes(status)) return v;
    if (Date.now() > until) throw new Error(`visit ${visitId} still ${status} after ${timeoutMs / 60000} min`);
    await sleep(2000);
  }
}

export async function acceptAll(ctx: Ctx, visitId: number): Promise<number> {
  const v = await api(ctx, "GET", `/visits/${visitId}`);
  const assessments = (v.visit?.assessments ?? v.assessments ?? []) as { id: number; status: string }[];
  let n = 0;
  for (const a of assessments.filter((x) => x.status === "proposed")) {
    await api(ctx, "PATCH", `/assessments/${a.id}`, { action: "accept" });
    n++;
  }
  return n;
}

// ---- recording helpers ----

async function recorder(ctx: Ctx, kind: "phone" | "desktop" | "card", browser?: Browser, warmUrl?: string) {
  const b = browser ?? ctx.browser;
  const opts =
    kind === "phone"
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, recordVideo: { dir: join(ctx.outDir, "raw"), size: { width: 390, height: 844 } } }
      : kind === "desktop"
        ? { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, recordVideo: { dir: join(ctx.outDir, "raw"), size: { width: 1280, height: 800 } } }
        : { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: join(ctx.outDir, "raw"), size: { width: 1920, height: 1080 } } };
  const context = await b.newContext({ ...opts, permissions: kind === "phone" ? ["microphone"] : [] });
  if (warmUrl) {
    // Off camera, same browser cache: load every image once so the recording doesn't show them rendering.
    const warm: Page = await context.newPage();
    await warm.goto(warmUrl);
    for (let y = 0; y < 12; y++) {
      await warm.evaluate((k: number) => window.scrollTo(0, k * 700), y);
      await sleep(400);
    }
    await warm
      .waitForFunction(() => [...document.querySelectorAll("img")].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0), null, { timeout: 60_000 })
      .catch(() => {});
    await warm.close();
  }
  const page: Page = await context.newPage();
  const t0 = performance.now();
  const marks: Mark[] = [];
  const mark = (k: Mark["kind"]) => marks.push({ at: (performance.now() - t0) / 1000, kind: k });
  return {
    page,
    context,
    mark,
    async finish(name: string): Promise<Recording> {
      mark("end");
      const video = page.video();
      await context.close();
      const src = await video.path();
      const clip = `raw/${name}.webm`;
      renameSync(src, join(ctx.outDir, clip));
      return { clip, marks };
    },
  };
}

/** Keep the live trace at the newest step while the agent runs (and click "Jump to latest" if it appears). */
async function followTrace(ctx: Ctx, page: Page, visitId: number): Promise<void> {
  const until = Date.now() + 10 * 60_000;
  for (;;) {
    const v = await api(ctx, "GET", `/visits/${visitId}`);
    const status = v.visit?.status ?? v.status;
    if (!["queued", "processing"].includes(status)) return;
    if (Date.now() > until) throw new Error(`visit ${visitId} did not finish`);
    const jump = page.getByText("Jump to latest");
    if (await jump.isVisible().catch(() => false)) await jump.click().catch(() => {});
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })).catch(() => {});
    await sleep(1500);
  }
}

async function scrollTo(page: Page, locator: any, hold: number): Promise<boolean> {
  const el = locator.first();
  if (!(await el.count())) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.evaluate(() => window.scrollBy({ top: -120 })).catch(() => {});
  await sleep(hold);
  return true;
}

const visitIdFromUrl = (url: string) => Number(/\/visits\/(\d+)/.exec(url)?.[1]);

/** On the phone: project page → New visit → photo (+ optional voice note) → run. Returns the visit id. */
async function captureAndRun(ctx: Ctx, rec: Awaited<ReturnType<typeof recorder>>, projectId: number, photo: string, voice: boolean): Promise<number> {
  const { page } = rec;
  await page.goto(`${ctx.base}/projects/${projectId}`);
  await page.getByRole("button", { name: /New visit/ }).waitFor();
  await sleep(1200);
  await page.getByRole("button", { name: /New visit/ }).click();
  await page.waitForURL(/\/capture/, { waitUntil: "commit" });
  await sleep(900);
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(abs(ctx, photo));
  await page.getByRole("button", { name: /Upload & take next/ }).waitFor();
  await sleep(1300);
  if (voice) {
    const hold = page.getByRole("button", { name: /Hold to add a voice note/ });
    await hold.scrollIntoViewIfNeeded();
    const box = await hold.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await sleep(3800);
    await page.mouse.up();
    await page.locator("audio").waitFor({ timeout: 15_000 });
    await sleep(1200);
  }
  await page.getByRole("button", { name: /Upload & take next/ }).click();
  await page.getByRole("button", { name: /Done · run agent on 1 photo/ }).waitFor({ timeout: 60_000 });
  await sleep(900);
  await page.getByRole("button", { name: /Done · run agent/ }).click();
  await page.waitForURL(/\/visits\/\d+$/, { waitUntil: "commit" });
  return visitIdFromUrl(page.url());
}

// ---- scenes ----

export async function sceneDrawings(ctx: Ctx): Promise<Recording> {
  ctx.spendGate(0.6, "drawing import");
  const def = ctx.config.projects.demo;
  const rec = await recorder(ctx, "desktop");
  const { page, mark } = rec;
  await page.goto(`${ctx.base}/`);
  await page.getByPlaceholder("Project name").waitFor();
  await sleep(800);
  await page.getByPlaceholder("Project name").pressSequentially(def.name, { delay: 35 });
  await page.getByPlaceholder("Location (city)").fill(def.location);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/\d+$/, { waitUntil: "commit" });
  const projectId = Number(/\/projects\/(\d+)/.exec(page.url())![1]);
  ctx.state.projects = { ...(ctx.state.projects ?? {}), demo: projectId };
  ctx.saveState();
  await page.getByPlaceholder("e.g. Floor 3 – East").fill(def.zone);
  await page.getByRole("button", { name: "Add zone" }).click();
  await page.getByText(def.zone, { exact: true }).first().waitFor();
  await sleep(500);
  await page.getByRole("link", { name: /Upload BOQ/ }).click();
  await page.getByRole("tab", { name: /From drawings/ }).click();
  await sleep(700);
  await page.locator('input[type="file"][accept*="pdf"]').setInputFiles(abs(ctx, ctx.config.inputs.drawingsPdf));
  await sleep(800);
  mark("wait");
  await page.getByText("Proposed BOQ").waitFor({ timeout: 15 * 60_000 });
  mark("normal");
  await sleep(2200);
  // Open a page from the strip: the title block is blurred by the server.
  const pageButton = page.getByRole("button", { name: "Open page 2" });
  if (await pageButton.count()) {
    await pageButton.first().click();
    await sleep(2600);
    await page.getByRole("button", { name: "Close" }).last().click();
    await sleep(500);
  }
  // Proposed items with their page sources ("12 nos · p.2").
  await scrollTo(page, page.getByText("Proposed BOQ"), 1400);
  await page.evaluate(() => window.scrollBy({ top: 320, behavior: "smooth" }));
  await sleep(1800);
  const save = page.getByRole("button", { name: /Save BOQ/ });
  await save.scrollIntoViewIfNeeded();
  await sleep(900);
  await save.click();
  await page.waitForURL(/\/projects\/\d+$/, { waitUntil: "commit" });
  await sleep(2200);
  return rec.finish("scene-03");
}

export async function sceneVisit1(ctx: Ctx): Promise<Recording> {
  ctx.spendGate(0.3, "visit 1");
  const projectId = ctx.state.projects?.demo;
  if (!projectId) throw new Error("Scene 4 needs the Demo Residence project from scene 3 (run scene 3 first).");
  const browser = await ctx.micBrowser();
  const rec = await recorder(ctx, "phone", browser);
  // Visit 1 is dated a week back, so visit 2 reads as "since last visit".
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  await rec.page.route("**/api/projects/*/visits", async (route: any) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.continue({ postData: JSON.stringify({ visitDate: weekAgo }), headers: { ...route.request().headers(), "content-type": "application/json" } });
  });
  const visitId = await captureAndRun(ctx, rec, projectId, ctx.config.inputs.photos.slabMesh, true);
  await sleep(5500);
  const out = await rec.finish("scene-04");
  await browser.close();
  ctx.state.visits = { ...(ctx.state.visits ?? {}), v1: visitId };
  ctx.saveState();
  // Off camera: let the run finish and accept it, so visit 2 compares against an accepted assessment.
  await waitVisitDone(ctx, visitId);
  await acceptAll(ctx, visitId);
  return out;
}

async function agentScene(ctx: Ctx, key: "plinth" | "g2", photo: string, name: string, ending: (page: Page) => Promise<void>): Promise<Recording> {
  ctx.spendGate(0.3, `${key} visit`);
  const projectId = await ensureProject(ctx, key, true);
  const rec = await recorder(ctx, "phone");
  const visitId = await captureAndRun(ctx, rec, projectId, photo, false);
  ctx.state.visits = { ...(ctx.state.visits ?? {}), [key]: visitId };
  ctx.saveState();
  await sleep(1500);
  rec.mark("wait");
  await followTrace(ctx, rec.page, visitId);
  rec.mark("normal");
  await sleep(1500);
  await ending(rec.page);
  return rec.finish(name);
}

export function scenePlinth(ctx: Ctx): Promise<Recording> {
  return agentScene(ctx, "plinth", ctx.config.inputs.photos.rebarCages, "scene-05", async (page) => {
    await scrollTo(page, page.getByText(/rebar|cage/i), 3200);
    await scrollTo(page, page.getByText(/block|deviation/i), 3000);
  });
}

export function sceneG2(ctx: Ctx): Promise<Recording> {
  return agentScene(ctx, "g2", ctx.config.inputs.photos.g2Scaffolding, "scene-06", async (page) => {
    await scrollTo(page, page.getByText(/tarp|net|sheet|scaffold/i), 2600);
    if (!(await scrollTo(page, page.getByText("Photo requested"), 3400))) await sleep(2000);
  });
}

export async function sceneVisit2(ctx: Ctx): Promise<Recording> {
  ctx.spendGate(0.3, "visit 2");
  const projectId = ctx.state.projects?.demo;
  if (!ctx.state.visits?.v1) throw new Error("Scene 7 needs visit 1 (scene 4) first.");
  const rec = await recorder(ctx, "phone");
  const visitId = await captureAndRun(ctx, rec, projectId, ctx.config.inputs.photos.slabCast, false);
  ctx.state.visits = { ...(ctx.state.visits ?? {}), v2: visitId };
  ctx.saveState();
  await sleep(1500);
  rec.mark("wait");
  await followTrace(ctx, rec.page, visitId);
  rec.mark("normal");
  await rec.page.reload();
  await rec.page.getByText(/Since last visit/).first().waitFor({ timeout: 20_000 }).catch(() => {});
  await rec.page.evaluate(() => window.scrollTo({ top: 0 }));
  await scrollTo(rec.page, rec.page.getByText(/Since last visit/), 1600);
  // Expand the per-item changes ("+40 pts").
  const changes = rec.page.getByRole("button", { name: /Show \d+ changes?/ });
  if (await changes.count()) {
    await changes.first().click();
    await sleep(3600);
  }
  await scrollTo(rec.page, rec.page.getByText(/concreting/i), 2200);
  return rec.finish("scene-07");
}

export async function sceneReview(ctx: Ctx, rasterize: (pdf: Buffer) => Promise<Buffer>): Promise<Recording> {
  const visitId = ctx.state.visits?.v2;
  if (!visitId) throw new Error("Scene 8 needs visit 2 (scene 7) first.");
  // Re-recordable: put this visit's review back to "proposed" in the throwaway local database (the app refuses an
  // undo once a report exists, which is right for real use).
  const id = Number(visitId);
  sqlValue(`delete from reports where visit_id = ${id}; update assessments set status = 'proposed', engineer_note = null, reviewed_at = null where visit_id = ${id}; update visits set status = 'assessed' where id = ${id} and status in ('reviewed', 'reported');`);
  const rec = await recorder(ctx, "desktop", undefined, `${ctx.base}/visits/${visitId}/review`);
  const { page } = rec;
  await page.goto(`${ctx.base}/visits/${visitId}/review`);
  await page.locator("article").first().waitFor();
  // Evidence photos are mask overlays rendered by the server: don't hold on empty placeholders.
  rec.mark("wait");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page
    .waitForFunction(() => [...document.querySelectorAll("article img")].slice(0, 1).every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0), null, { timeout: 30_000 })
    .catch(() => {});
  await sleep(800);
  rec.mark("normal");
  await sleep(1200);
  await scrollTo(page, page.getByText(/Inferred — not billable/), 2600);
  for (let i = 0; i < 8; i++) {
    const accept = page.getByRole("button", { name: /^Accept$/ });
    if (!(await accept.count())) break;
    await accept.first().scrollIntoViewIfNeeded();
    await accept.first().click();
    await sleep(700);
  }
  await page.getByRole("link", { name: /Create report|Continue to report/ }).click();
  await page.waitForURL(/\/report$/, { waitUntil: "commit" });
  await sleep(1200);
  await page.getByRole("button", { name: /Generate PDF/ }).click();
  const download = page.getByRole("link", { name: /Download PDF/ });
  await download.waitFor({ timeout: 120_000 });
  await sleep(1200);
  const href = await download.getAttribute("href");
  const url = new URL(href, ctx.base).toString();
  const pdf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const png = await rasterize(pdf);
  writeFileSync(join(ctx.outDir, "report-page-1.png"), png);
  await page.setContent(
    `<html><body style="margin:0;background:#334155;display:flex;flex-direction:column;align-items:center;font-family:Segoe UI,sans-serif">
      <div style="color:#e2e8f0;font-size:18px;padding:14px">Report PDF · page 1</div>
      <img src="data:image/png;base64,${png.toString("base64")}" style="height:720px;box-shadow:0 10px 40px rgba(0,0,0,.4);background:#fff"/>
    </body></html>`,
  );
  await sleep(4200);
  return rec.finish("scene-08");
}

// ---- cards ----

export async function recordCard(ctx: Ctx, html: string, seconds: number, name: string): Promise<Recording> {
  const rec = await recorder(ctx, "card");
  await rec.page.setContent(html);
  await sleep(seconds * 1000);
  return rec.finish(name);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
