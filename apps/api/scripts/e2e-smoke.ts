/**
 * End-to-end smoke test of the real app: real API + worker processes, real Postgres (DATABASE_URL), real Meta calls,
 * local file storage. Drives everything over HTTP the way the web app does.
 *
 *   pnpm e2e-smoke
 *   pnpm e2e-smoke --visits "samples/demo-residence/v1,samples/demo-residence/v2" --boq samples/boq-demo-residence.json --port 8799
 *
 * Steps: project + zones + BOQ → per visit: create, presign + upload + register photos, run, follow the SSE trace
 * until assessed/needs_input, accept assessments → PDF report for the last visit. Fails loudly at any step.
 * Costs real money: up to MAX_COST_PER_VISIT_USD per visit.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeStep, discoverZones, expandVisitDirs, parseBoqJson, type DiscoveredZone, type StepLike } from "./dry-run-lib.js";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(apiDir, "../..");
const cwd = process.env.INIT_CWD ?? process.cwd();

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    boq: { type: "string", default: "samples/boq-demo-residence.json" },
    visits: { type: "string", multiple: true, default: ["samples/demo-residence/v1,samples/demo-residence/v2"] },
    name: { type: "string" },
    port: { type: "string", default: "8799" },
    "timeout-min": { type: "string", default: "15" },
  },
  strict: true,
});

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const outDir = join(repoRoot, "samples", "out", `e2e-${stamp}`);
const storageDir = join(outDir, "storage");
const BASE = `http://localhost:${args.port}`;
const TIMEOUT_MS = Number(args["timeout-min"]) * 60_000;
const children: ChildProcess[] = [];
const logTails: Record<string, string[]> = { api: [], worker: [] };

// ---------------------------------------------------------------------------------------------

class StepError extends Error {}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n→ ${name}`);
  try {
    return await fn();
  } catch (err) {
    throw new StepError(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function http<T = unknown>(method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string }): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: raw ? { "Content-Type": raw.type } : body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: raw ? new Uint8Array(raw.data) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    return text as T;
  }
}

function startProcess(label: "api" | "worker", entry: string) {
  const log = createWriteStream(join(outDir, `${label}.log`));
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: apiDir,
    env: { ...process.env, PORT: args.port, STORAGE_LOCAL_DIR: storageDir, WORKER_POLL_MS: "500" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (chunk: Buffer) => {
    log.write(chunk);
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      logTails[label]!.push(line);
      if (logTails[label]!.length > 40) logTails[label]!.shift();
    }
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.on("exit", (code) => logTails[label]!.push(`[${label} exited with code ${code}]`));
  children.push(child);
}

async function stopAll() {
  for (const c of children) if (c.exitCode == null) c.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  for (const c of children) if (c.exitCode == null) c.kill("SIGKILL");
}

async function waitForHealth() {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not up yet
    }
    if (children[0]?.exitCode != null) throw new Error("API process exited during startup");
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API did not answer /health within 60 s");
}

/** Follow /visits/:id/trace until the visit is assessed or needs input. Throws if the run fails. */
async function followTrace(visitId: number): Promise<{ status: string; steps: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let steps = 0;
  let sawWork = false;
  try {
    const res = await fetch(`${BASE}/visits/${visitId}/trace`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`trace stream → HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("trace stream closed before the run finished");
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === "step") {
          steps++;
          for (const line of describeStep(payload as StepLike)) console.log(`   ${line}`);
        } else if (event === "status") {
          const status = payload.status as string;
          console.log(`   [visit status: ${status}]`);
          if (status === "queued" || status === "processing") sawWork = true;
          if (status === "assessed" || status === "needs_input") return { status, steps };
          if (status === "draft" && sawWork) throw new Error("the worker gave up on the run (visit went back to draft); see worker.log");
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`run did not finish within ${args["timeout-min"]} min`);
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const CONTENT_TYPE: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

// ---------------------------------------------------------------------------------------------

async function main() {
  await mkdir(storageDir, { recursive: true });
  const isDir = (p: string) => {
    try {
      return statSync(resolve(cwd, p)).isDirectory();
    } catch {
      return false;
    }
  };
  const visitDirs = expandVisitDirs(args.visits!.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean), isDir).map((v) => resolve(cwd, v));
  const boq = parseBoqJson(await readFile(resolve(cwd, args.boq!), "utf8"));
  const zoneNames = boq.zones ?? ["Site"];
  const photoSets: DiscoveredZone[][] = [];
  for (const dir of visitDirs) photoSets.push(await discoverZones(dir, { declaredZones: zoneNames, looseZoneName: zoneNames[0] }));

  console.log(`SiteSight e2e smoke · ${visitDirs.length} visit(s) · API ${BASE} · output ${outDir}`);
  startProcess("api", "src/index.ts");
  startProcess("worker", "src/worker/index.ts");
  await step("API and worker start", waitForHealth);

  const project = await step("create project, zones and BOQ over HTTP", async () => {
    const p = await http<{ id: number; name: string }>("POST", "/projects", { name: args.name ?? `Demo Residence (e2e ${stamp})`, locationLabel: "e2e smoke" });
    const zones = new Map<string, number>();
    for (const [i, name] of zoneNames.entries()) {
      const z = await http<{ id: number }>("POST", `/projects/${p.id}/zones`, { name, sortOrder: i });
      zones.set(name, z.id);
    }
    const items = boq.items.map(({ zone, ...it }) => ({ ...it, zoneId: zone ? zones.get(zone)! : null }));
    const saved = await http<unknown[]>("PUT", `/projects/${p.id}/boq`, { items });
    console.log(`   project #${p.id} "${p.name}", zones ${zoneNames.join(", ")}, ${saved.length} BOQ items`);
    return { ...p, zones };
  });

  const results: { visitId: number; status: string; steps: number; assessments: number; accepted: number; askBacks: number }[] = [];
  for (const [i, dir] of visitDirs.entries()) {
    const n = i + 1;
    const visitId = await step(`visit ${n}: create`, async () => (await http<{ id: number }>("POST", `/projects/${project.id}/visits`, {})).id);

    await step(`visit ${n}: upload photos via presign + register (${dir})`, async () => {
      for (const zone of photoSets[i]!) {
        for (const photo of zone.photos) {
          const contentType = CONTENT_TYPE[extname(photo.file).toLowerCase()] ?? "image/jpeg";
          const { uploadUrl, storageKey } = await http<{ uploadUrl: string; storageKey: string }>("POST", `/visits/${visitId}/photos/presign`, {
            contentType,
            kind: "photo",
          });
          await http("PUT", uploadUrl, undefined, { data: await readFile(photo.path), type: contentType });
          const reg = await http<{ id: number; width: number; height: number }>("POST", `/visits/${visitId}/photos`, {
            zoneId: project.zones.get(zone.name),
            storageKey,
          });
          console.log(`   photo #${reg.id} ${zone.name} / ${photo.file} (${reg.width}×${reg.height})`);
        }
      }
    });

    await step(`visit ${n}: start agent run`, () => http("POST", `/visits/${visitId}/run`));
    const run = await step(`visit ${n}: follow SSE trace until assessed / needs_input`, () => followTrace(visitId));

    const accepted = await step(`visit ${n}: accept assessments via PATCH`, async () => {
      const detail = await http<{ assessments: { id: number; status: string; boqItemId: number }[]; askBacks: { id: number; status: string; instruction: string }[] }>(
        "GET",
        `/visits/${visitId}`,
      );
      if (!detail.assessments.length) console.log("   ⚠ the agent recorded no assessments for this visit");
      let count = 0;
      for (const a of detail.assessments.filter((x) => x.status === "proposed")) {
        await http("PATCH", `/assessments/${a.id}`, { action: "accept" });
        count++;
      }
      for (const ab of detail.askBacks.filter((x) => x.status === "open")) console.log(`   open ask-back #${ab.id}: ${ab.instruction}`);
      console.log(`   accepted ${count} of ${detail.assessments.length} assessment(s)`);
      return { count, total: detail.assessments.length, askBacks: detail.askBacks.filter((x) => x.status === "open").length };
    });
    results.push({ visitId, status: run.status, steps: run.steps, assessments: accepted.total, accepted: accepted.count, askBacks: accepted.askBacks });
  }

  const last = results.at(-1)!;
  const pdfPath = await step(`PDF report for visit ${results.length}`, async () => {
    const { downloadUrl } = await http<{ downloadUrl: string }>("POST", `/visits/${last.visitId}/report`);
    const res = await fetch(downloadUrl.startsWith("/") ? `${BASE}${downloadUrl}` : downloadUrl);
    if (!res.ok) throw new Error(`download → HTTP ${res.status}`);
    const pdf = Buffer.from(await res.arrayBuffer());
    if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("downloaded file is not a PDF");
    const path = join(outDir, `report-visit-${last.visitId}.pdf`);
    await writeFile(path, pdf);
    return path;
  });

  // Cost per visit (not exposed by the API; read from the same database).
  const { visitSpendUsd } = await import("../src/meta/cost.js");
  console.log("\n=== e2e smoke passed ===");
  for (const [i, r] of results.entries()) {
    console.log(
      `visit ${i + 1} (#${r.visitId}): ${r.status}, ${r.steps} trace steps, ${r.accepted}/${r.assessments} assessments accepted, ${r.askBacks} open ask-back(s), cost $${(await visitSpendUsd(r.visitId)).toFixed(4)}`,
    );
  }
  console.log(`PDF: ${pdfPath}`);
  console.log(`Logs: ${join(outDir, "api.log")}, ${join(outDir, "worker.log")}`);
}

main()
  .then(async () => {
    await stopAll();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`\n✗ E2E SMOKE FAILED at ${err instanceof StepError ? err.message : `startup: ${err instanceof Error ? err.message : err}`}`);
    for (const [label, lines] of Object.entries(logTails)) {
      if (lines.length) console.error(`\n--- last ${label} log lines ---\n${lines.slice(-15).join("\n")}`);
    }
    console.error(`\nLogs: ${outDir}`);
    await stopAll();
    process.exit(1);
  });
