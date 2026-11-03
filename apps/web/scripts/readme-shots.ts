/**
 * README screenshots from a running SiteSight (production or local):
 *   pnpm readme-shots --base-url https://sitesightapi-production.up.railway.app
 * Logs in through the login screen with DEMO_PASSWORD from deploy-secrets.local.txt (never printed), then captures
 * at phone width into docs/img/:
 *   trace-rejections.png  the live trace of a visit whose detections were rejected (prefers --trace-project)
 *   drawing-import.png    a finished drawing import with its page sources (title blocks blurred by the server)
 *   review-card.png       the first review card of --project's second visit
 * Title blocks of client drawings are blurred by the server (it only serves a redacted copy of each page); the script
 * refuses to capture the drawing import from a server that would still serve originals.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "base-url": { type: "string" },
    "password-file": { type: "string", default: "deploy-secrets.local.txt" },
    project: { type: "string", default: "Demo Residence" },
    "trace-project": { type: "string", default: "Plinth-stage site" },
    out: { type: "string", default: "docs/img" },
  },
});
if (!args["base-url"]) {
  console.error("usage: pnpm readme-shots --base-url <https://…> [--password-file deploy-secrets.local.txt] [--project 'Demo Residence'] [--trace-project 'Plinth-stage site']");
  process.exit(2);
}
const BASE = args["base-url"].replace(/\/+$/, "");
const outDir = resolve(repoRoot, args.out!);

const password = /DEMO_PASSWORD=(\S+)/.exec(await readFile(resolve(repoRoot, args["password-file"]!), "utf8"))?.[1];
if (!password) throw new Error(`No DEMO_PASSWORD= line in ${args["password-file"]}`);

// ---- find what to show, through the API ----
let cookie = "";
async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
{
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ password }) });
  if (!res.ok) throw new Error(`login → ${res.status}`);
  cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
}
type P = { id: number; name: string };
type PD = { visits: { id: number; visitDate: string; status: string }[] };
const projects = await api<P[]>("/projects");
const byName = (n: string) => projects.find((p) => p.name.toLowerCase() === n.toLowerCase());
const main = byName(args.project!);
if (!main) throw new Error(`Project "${args.project}" not found. Projects: ${projects.map((p) => p.name).join(", ") || "(none)"}`);
const visitsOf = async (p: P) => [...(await api<PD>(`/projects/${p.id}`)).visits].sort((a, b) => a.visitDate.localeCompare(b.visitDate) || a.id - b.id);
const mainVisits = await visitsOf(main);
const reviewVisit = mainVisits[1] ?? mainVisits[0];
if (!reviewVisit) throw new Error(`"${main.name}" has no visits`);

let drawing: { projectId: number; importId: number } | null = null;
for (const p of projects) {
  const imps = await api<{ id: number; status: string }[]>(`/projects/${p.id}/drawings`);
  const done = imps.find((i) => i.status === "done" || i.status === "cost_limit");
  if (done) {
    drawing = { projectId: p.id, importId: done.id };
    break;
  }
}

// ---- capture ----
const { chromium } = await import("playwright");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(BASE);
await page.getByLabel("Password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Enter" }).click();
await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 20_000 });
await mkdir(outDir, { recursive: true });
const saved: string[] = [];

async function settle() {
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => ((i.onload = r), (i.onerror = r))))));
  });
}

// 1. Trace with rejections: the first visit (trace project first) whose trace shows rejected detections.
const traceCandidates = [...new Set([byName(args["trace-project"]!), main].filter(Boolean) as P[])];
let traceDone = false;
for (const p of traceCandidates) {
  for (const v of (await visitsOf(p)).reverse()) {
    await page.goto(`${BASE}/visits/${v.id}`);
    await page.getByRole("heading", { name: "Agent trace" }).waitFor();
    await settle();
    const card = page.locator("article", { hasText: /Checked \d+ detections? — kept \d+, rejected [1-9]/ }).first();
    if (!(await card.count())) continue;
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(600);
    // The floating "Jump to latest" button appears once the trace is scrolled up; keep it out of the picture.
    await page.evaluate(() => {
      for (const b of document.querySelectorAll("button")) if (b.textContent?.includes("Jump to latest")) (b as HTMLElement).style.display = "none";
    });
    const file = join(outDir, "trace-rejections.png");
    await page.locator("section", { has: page.getByRole("heading", { name: "Agent trace" }) }).first().screenshot({ path: file });
    saved.push(`${file}  (${p.name}, visit ${v.visitDate})`);
    traceDone = true;
    break;
  }
  if (traceDone) break;
}
if (!traceDone) console.warn("No visit with rejected detections found: trace-rejections.png not written");

// 2. Drawing import with page sources (the server blurs title blocks in every page image it serves).
if (drawing) {
  await page.goto(`${BASE}/projects/${drawing.projectId}/boq?import=${drawing.importId}`);
  await page.getByText("Proposed BOQ").waitFor({ timeout: 20_000 });
  await settle();
  const imp = (await (await page.request.get(`${BASE}/api/projects/${drawing.projectId}/drawings/${drawing.importId}`)).json()) as { pages: { imageUrl: string }[] };
  if (!imp.pages.every((p) => /\.view\.png(\?|$)/.test(p.imageUrl))) {
    throw new Error("This server serves original drawing pages (title blocks not blurred): deploy first, then re-run.");
  }
  const file = join(outDir, "drawing-import.png");
  await page.screenshot({ path: file, fullPage: false });
  saved.push(`${file}  (${imp.pages.length} pages, title blocks blurred by the server)`);
} else {
  console.warn("No finished drawing import found: drawing-import.png not written");
}

// 3. Review card of the main project's second visit.
await page.goto(`${BASE}/visits/${reviewVisit.id}/review`);
await page.locator("article").first().waitFor({ timeout: 20_000 });
await settle();
const reviewFile = join(outDir, "review-card.png");
await page.locator("article").first().screenshot({ path: reviewFile });
saved.push(`${reviewFile}  (${main.name}, visit ${reviewVisit.visitDate})`);

await browser.close();
console.log(`Saved:\n  ${saved.join("\n  ")}`);
