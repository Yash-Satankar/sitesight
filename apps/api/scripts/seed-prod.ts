/**
 * Seed the production demo through the public API (no database access):
 *   pnpm seed-prod [--drawings-ok] [--dry-run] [--max-cost 3] [--base-url https://…]
 * Logs in with DEMO_PASSWORD from deploy-secrets.local.txt (never printed). Real Meta calls, capped at --max-cost
 * (default $3): a paid step only starts if its server-side worst case still fits. Idempotent: projects, zones and
 * BOQs are matched by name / presence and skipped; only Demo Residence's earliest visit is ever touched.
 *
 *   1. "Demo Residence" (zone GF): BOQ from the demo-residence.pdf drawing import (--drawings-ok, with the proposal fixes) or
 *      samples/boq-demo-residence.json; visit 1 (7 days ago) with the samples/demo-residence/v1 photo → agent run → accept all.
 *   2. "Plinth-stage site" and 3. "G+2 frame site" (zone GF, BOQ samples/boq-demo.json), no visits.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Assessment, BoqItemInput, DrawingImport, ProjectDetail, ProjectListItem, VisitDetail } from "@sitesight/shared";
import { parseBoqJson } from "./dry-run-lib.js";
import { assertRealSitePhoto, fitsBudget, prepareDemoResidenceBoq } from "./seed-prod-lib.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "drawings-ok": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "max-cost": { type: "string", default: "3" },
    "base-url": { type: "string", default: "https://sitesightapi-production.up.railway.app" },
    "password-file": { type: "string", default: "deploy-secrets.local.txt" },
  },
});
const BASE = args["base-url"]!.replace(/\/+$/, "");
const DRY = args["dry-run"]!;
const MAX = Number(args["max-cost"]);
if (!(MAX > 0)) throw new Error("--max-cost must be a positive number");
// Server-side caps per paid step (MAX_COST_PER_DRAWING_IMPORT_USD, MAX_COST_PER_VISIT_USD defaults).
const IMPORT_CAP = 1.0;
const VISIT_CAP = 1.5;

const password = /DEMO_PASSWORD=(\S+)/.exec(readFileSync(resolve(repoRoot, args["password-file"]!), "utf8"))?.[1];
if (!password) throw new Error(`No DEMO_PASSWORD= line in ${args["password-file"]}`);

let cookie = "";
async function http<T>(method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string } | FormData): Promise<T> {
  const isForm = raw instanceof FormData;
  const res = await fetchRetrying(method, path.startsWith("http") ? path : `${BASE}/api${path}`, {
    method,
    headers: {
      Origin: BASE,
      ...(cookie && !path.startsWith("http") ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : raw && !isForm ? { "Content-Type": raw.type } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : isForm ? raw : raw ? new Uint8Array(raw.data) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set?.startsWith("sitesight_session=")) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * fetch with retries for flaky connections: a connection that never opened (connect timeout / refused) is retried for
 * any method, since nothing reached the server; other network errors only for GET (safe to repeat).
 */
async function fetchRetrying(method: string, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code ?? "";
      const neverSent = ["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code);
      if (attempt >= 4 || !(neverSent || method === "GET")) throw err;
      console.log(`    (network ${code || "error"} on ${method} ${url.replace(BASE, "")}, retrying ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const money = (n: number) => `$${n.toFixed(4)}`;
const spendNow = async () => (await http<{ spentUsd: number }>("GET", "/spend/today")).spentUsd;
let spent = 0;
const stepCosts: [string, number][] = [];
async function paidStep<T>(name: string, capUsd: number, fn: () => Promise<T>): Promise<T | null> {
  if (!fitsBudget(spent, capUsd, MAX)) {
    console.log(`  ✗ skipped "${name}": worst case ${money(capUsd)} would exceed the ${money(MAX)} seed budget (spent ${money(spent)})`);
    return null;
  }
  const before = await spendNow();
  const out = await fn();
  const cost = Math.max(0, (await spendNow()) - before);
  spent += cost;
  stepCosts.push([name, cost]);
  console.log(`  cost of "${name}": ${money(cost)} · seed total ${money(spent)} of ${money(MAX)}`);
  return out;
}

const projects = async () => http<ProjectListItem[]>("GET", "/projects");

async function ensureProject(name: string, locationLabel: string): Promise<number | null> {
  const found = (await projects()).find((p) => p.name === name);
  if (found) {
    console.log(`  project "${name}" exists (#${found.id}), skipped`);
    return found.id;
  }
  if (DRY) {
    console.log(`  [dry run] would create project "${name}"`);
    return null;
  }
  const p = await http<{ id: number }>("POST", "/projects", { name, locationLabel });
  console.log(`  created project "${name}" (#${p.id})`);
  return p.id;
}

async function ensureZone(projectId: number, name: string): Promise<number | null> {
  const d = await http<ProjectDetail>("GET", `/projects/${projectId}`);
  const z = d.zones.find((x) => x.name === name);
  if (z) return z.id;
  if (DRY) {
    console.log(`  [dry run] would add zone ${name}`);
    return null;
  }
  return (await http<{ id: number }>("POST", `/projects/${projectId}/zones`, { name, sortOrder: 0 })).id;
}

const boqFromJson = (file: string, zoneId: number): BoqItemInput[] =>
  parseBoqJson(readFileSync(resolve(repoRoot, file), "utf8")).items.map(({ zone: _z, ...it }) => ({ ...it, zoneId, drawingSource: null }) as BoqItemInput);

async function saveBoq(projectId: number, items: BoqItemInput[], label: string) {
  if (DRY) return console.log(`  [dry run] would save ${items.length} BOQ items (${label})`);
  const saved = await http<unknown[]>("PUT", `/projects/${projectId}/boq`, { items });
  console.log(`  saved ${saved.length} BOQ items (${label})`);
}

async function hasBoq(projectId: number) {
  return (await http<ProjectDetail>("GET", `/projects/${projectId}`)).boqItems.length > 0;
}

/** Drawing import of demo-residence.pdf, waiting for the worker; returns the BOQ to save. */
async function demoResidenceBoqFromDrawings(projectId: number, zoneId: number): Promise<BoqItemInput[] | null> {
  return paidStep("drawing import demo-residence.pdf", IMPORT_CAP, async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(readFileSync(join(repoRoot, "samples/demo-residence.pdf")))], { type: "application/pdf" }), "demo-residence.pdf");
    let imp = await http<DrawingImport>("POST", `/projects/${projectId}/drawings`, undefined, form);
    console.log(`  import #${imp.id}: ${imp.pages.length} pages rasterised, reading…`);
    const until = Date.now() + 15 * 60_000;
    let last = "";
    while ((imp.status === "queued" || imp.status === "processing") && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 4000));
      imp = await http<DrawingImport>("GET", `/projects/${projectId}/drawings/${imp.id}`);
      const done = imp.pages.filter((p) => ["extracted", "skipped", "failed"].includes(p.status)).length;
      const line = `${done}/${imp.pages.length} pages · $${imp.costUsd.toFixed(3)}`;
      if (line !== last) console.log(`    ${line}`);
      last = line;
    }
    if (!imp.proposal) throw new Error(`drawing import ended as ${imp.status}${imp.error ? `: ${imp.error}` : ""}`);
    // Nothing read (e.g. every page failed): stop here rather than save an empty BOQ.
    const unread = imp.pages.filter((p) => p.status === "failed");
    if (!imp.proposal.items.length) {
      throw new Error(`drawing import #${imp.id} proposed no items${unread.length ? ` (${unread.length}/${imp.pages.length} pages failed: ${unread[0]!.error})` : ""}`);
    }
    for (const w of imp.proposal.warnings.filter((x) => x.kind === "action")) console.log(`    action: ${w.text}`);
    const reviewed = parseBoqJson(readFileSync(join(repoRoot, "samples/boq-demo-residence.json"), "utf8")).items.map(({ zone: _z, ...it }) => it);
    const { items, fixes } = prepareDemoResidenceBoq(imp.proposal, reviewed, zoneId);
    for (const f of fixes) console.log(`    fix: ${f}`);
    return items;
  });
}

/** Follow the live trace until the run settles. */
async function followRun(visitId: number): Promise<string> {
  const res = await fetch(`${BASE}/api/visits/${visitId}/trace`, { headers: { Cookie: cookie } });
  if (!res.ok || !res.body) throw new Error(`trace → HTTP ${res.status}`);
  await http("POST", `/visits/${visitId}/run`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let steps = 0;
  let sawWork = false;
  const until = Date.now() + 12 * 60_000;
  try {
    while (Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev || !data) continue;
        if (ev === "step" && ++steps % 10 === 0) console.log(`    ${steps} trace steps…`);
        if (ev === "status") {
          const st = JSON.parse(data).status as string;
          if (st === "queued" || st === "processing") sawWork = true;
          if (st === "assessed" || st === "needs_input" || (st === "draft" && sawWork)) {
            console.log(`    run finished: ${st} after ${steps} steps`);
            return st;
          }
        }
      }
    }
    throw new Error("run did not finish within 12 minutes");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function demoResidenceVisit1(projectId: number, zoneId: number) {
  const detail = await http<ProjectDetail>("GET", `/projects/${projectId}`);
  const earliest = [...detail.visits].sort((a, b) => a.visitDate.localeCompare(b.visitDate) || a.id - b.id)[0];
  let visitId = earliest?.id;
  if (!visitId) {
    if (DRY) return console.log("  [dry run] would create visit 1 (7 days ago), upload the v1 photo, run the agent and accept all");
    const date = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    visitId = (await http<{ id: number }>("POST", `/projects/${projectId}/visits`, { visitDate: date })).id;
    console.log(`  created visit 1 (#${visitId}, ${date})`);
  } else {
    console.log(`  visit 1 exists (#${visitId}, ${earliest!.visitDate}, ${earliest!.status})`);
  }
  let visit = await http<VisitDetail>("GET", `/visits/${visitId}`);
  if (!visit.photos.length) {
    const dir = join(repoRoot, "samples/demo-residence/v1");
    for (const f of readdirSync(dir).filter((x) => /\.jpe?g$/i.test(x))) {
      const path = join(dir, f);
      assertRealSitePhoto(path);
      if (DRY) {
        console.log(`  [dry run] would upload ${f}`);
        continue;
      }
      const pre = await http<{ uploadUrl: string; storageKey: string }>("POST", `/visits/${visitId}/photos/presign`, { contentType: "image/jpeg", kind: "photo" });
      await http("PUT", pre.uploadUrl, undefined, { data: readFileSync(path), type: "image/jpeg" });
      const ph = await http<{ id: number }>("POST", `/visits/${visitId}/photos`, { zoneId, storageKey: pre.storageKey });
      console.log(`  uploaded ${f} (photo #${ph.id})`);
    }
    visit = await http<VisitDetail>("GET", `/visits/${visitId}`);
  }
  if (!visit.assessments.length && visit.status === "draft") {
    if (DRY) return console.log("  [dry run] would run the agent on visit 1 and accept all assessments");
    await paidStep("agent run, Demo Residence visit 1", VISIT_CAP, () => followRun(visitId!));
    visit = await http<VisitDetail>("GET", `/visits/${visitId}`);
  }
  const proposed = visit.assessments.filter((a) => a.status === "proposed");
  if (DRY) return console.log(`  [dry run] would accept ${proposed.length} assessment(s)`);
  for (const a of proposed) await http("PATCH", `/assessments/${a.id}`, { action: "accept" });
  if (proposed.length) console.log(`  accepted ${proposed.length} assessment(s)`);
  return http<VisitDetail>("GET", `/visits/${visitId}`);
}

// ---- run ----
console.log(`Seeding ${BASE}${DRY ? " (dry run: no changes, no spend)" : ""} · budget ${money(MAX)}${args["drawings-ok"] ? " · BOQ from drawings" : " · BOQ from samples/boq-demo-residence.json"}`);
await http("POST", "/auth/login", { password });
console.log(`Logged in. Today's spend before seeding: ${money(await spendNow())}`);

console.log("\n1. Demo Residence");
const failures: string[] = [];
/** Run one part of the seed; a failure is reported and the rest continues. */
async function part(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name} failed: ${msg}`);
  }
}

let demoResidence: number | null = null;
let demoResidenceVisit: VisitDetail | void = undefined;
await part("Demo Residence", async () => {
  demoResidence = await ensureProject("Demo Residence", "Nagpur · G+1 house");
  if (!demoResidence) {
    if (DRY) console.log("  [dry run] would add zone GF, the BOQ, and visit 1");
    return;
  }
  const gf = await ensureZone(demoResidence, "GF");
  if (!gf) return;
  if (await hasBoq(demoResidence)) console.log("  BOQ exists, skipped");
  else if (args["drawings-ok"]) {
    const items = await demoResidenceBoqFromDrawings(demoResidence, gf);
    if (items) await saveBoq(demoResidence, items, "from demo-residence.pdf, fixed");
  } else await saveBoq(demoResidence, boqFromJson("samples/boq-demo-residence.json", gf), "samples/boq-demo-residence.json");
  if (DRY || (await hasBoq(demoResidence))) demoResidenceVisit = await demoResidenceVisit1(demoResidence, gf);
});

for (const [n, name] of [
  [2, "Plinth-stage site"],
  [3, "G+2 frame site"],
] as const) {
  console.log(`\n${n}. ${name}`);
  await part(name, async () => {
    const id = await ensureProject(name, "demo site");
    if (!id) {
      if (DRY) console.log("  [dry run] would add zone GF and the BOQ from samples/boq-demo.json");
      return;
    }
    const gf = await ensureZone(id, "GF");
    if (!gf) return;
    if (await hasBoq(id)) console.log("  BOQ exists, skipped");
    else await saveBoq(id, boqFromJson("samples/boq-demo.json", gf), "samples/boq-demo.json");
  });
}

// ---- summary ----
console.log("\n=== Summary ===");
for (const p of await projects()) {
  const d = await http<ProjectDetail>("GET", `/projects/${p.id}`);
  console.log(`  #${p.id} ${p.name}: ${d.boqItems.length} BOQ items, ${d.visits.length} visit(s)`);
}
// Assigned inside part() closures, which TypeScript's narrowing can't follow.
const seededVisit = demoResidenceVisit as VisitDetail | void;
const demoResidenceId = demoResidence as number | null;
if (seededVisit && demoResidenceId) {
  const demoResidenceVisit = seededVisit;
  const items = (await http<ProjectDetail>("GET", `/projects/${demoResidenceId}`)).boqItems;
  console.log(`\nDemoResidence visit 1 (${demoResidenceVisit.visitDate}, ${demoResidenceVisit.status}):`);
  console.log(`  ${"item".padEnd(10)} ${"%".padStart(5)}  ${"stage".padEnd(14)} ${"basis".padEnd(9)} ${"conf".padStart(4)}  status`);
  for (const a of demoResidenceVisit.assessments as Assessment[]) {
    const code = items.find((b) => b.id === a.boqItemId)?.code ?? `#${a.boqItemId}`;
    console.log(`  ${code.padEnd(10)} ${String(Math.round(a.percentComplete)).padStart(5)}  ${(a.stageReached ?? "—").padEnd(14)} ${a.basis.padEnd(9)} ${a.confidence.toFixed(2).padStart(4)}  ${a.status}`);
  }
  const open = demoResidenceVisit.askBacks.filter((x) => x.status === "open");
  for (const ab of open) console.log(`  open photo request: ${ab.instruction}`);
}
console.log(`\nCost: ${stepCosts.map(([n, c]) => `${n} ${money(c)}`).join(" · ") || "nothing paid"} · total ${money(spent)} of ${money(MAX)}`);
if (failures.length) {
  console.log(`\n${failures.length} part(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
