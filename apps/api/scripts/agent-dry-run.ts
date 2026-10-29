/**
 * Run the real agent loop on a folder of photos and a BOQ, without the HTTP API, worker, Docker or R2.
 *
 *   pnpm agent-dry-run --photos samples/site-a --boq samples/boq-demo.json
 *   pnpm agent-dry-run --visits samples/demo-residence/v1,samples/demo-residence/v2 --boq samples/boq-demo-residence.json
 *
 * Uses an in-memory Postgres (PGlite) and stores photos/masks under samples/out/dry-run-<time>/.
 * Calls Meta for real: needs META_API_KEY / META_BASE_URL and the price settings in .env.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DRY_RUN_USAGE, parseDryRunArgs, type DryRunArgs } from "./dry-run-lib.js";

let args: DryRunArgs;
try {
  args = parseDryRunArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : err}\n\n${DRY_RUN_USAGE}`);
  process.exit(1);
}
if (args.help) {
  console.log(DRY_RUN_USAGE);
  process.exit(0);
}

const cwd = process.env.INIT_CWD ?? process.cwd(); // where the user ran pnpm
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const outDir = join(repoRoot, "samples", "out", `dry-run-${stamp}`);
await mkdir(outDir, { recursive: true });

// Must happen before anything imports src/config.ts (dotenv does not override variables already set).
process.env.DATABASE_URL = "pglite:memory";
process.env.STORAGE_LOCAL_DIR = join(outDir, "storage");

const { runDryRun } = await import("./dry-run.js");
try {
  const summary = await runDryRun({ visitDirs: args.visits.map((v) => resolve(cwd, v)), boqPath: resolve(cwd, args.boq), outDir });
  process.exit(summary.visits.some((v) => v.outcome === "failed") ? 1 : 0);
} catch (err) {
  console.error(`\nDry run could not start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
