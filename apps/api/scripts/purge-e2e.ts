/**
 * Delete projects left behind by `pnpm e2e-smoke` (name contains "(e2e") and their stored files.
 *   pnpm db:purge-e2e             # delete
 *   pnpm db:purge-e2e --dry-run   # list only
 * Also removes the storage folders of old e2e runs (samples/out/e2e-*\/storage); logs and PDFs are kept.
 */
import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.js";
import { deleteProject, findE2eProjects } from "../src/services/projects-admin.js";

const dryRun = process.argv.includes("--dry-run");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const projects = await findE2eProjects();
if (!projects.length) console.log('No e2e projects found (names containing "(e2e").');
for (const p of projects) {
  if (dryRun) {
    console.log(`would delete project #${p.id} "${p.name}"`);
    continue;
  }
  const r = await deleteProject(p.id, { deleteFiles: true });
  if (r) console.log(`deleted project #${r.projectId} "${r.name}": ${r.visits} visit(s); ${r.storageKeys} stored file(s) deleted or already gone`);
}

const outDir = join(repoRoot, "samples", "out");
const runs = (await readdir(outDir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && d.name.startsWith("e2e-"));
for (const run of runs) {
  const storage = join(outDir, run.name, "storage");
  if (dryRun) console.log(`would remove ${storage}`);
  else await rm(storage, { recursive: true, force: true });
}
if (!dryRun && runs.length) console.log(`removed storage folders of ${runs.length} e2e run(s) (logs and PDFs kept)`);
await sql.end();
