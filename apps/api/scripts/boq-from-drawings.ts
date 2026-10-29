/**
 * Dry run of the drawing import, without the database:
 *   pnpm boq-from-drawings --pdf drawings.pdf [--out samples/out/drawings] [--max-cost 0.50] [--notes]
 * Rasterises the PDF, classifies every page and extracts the structural sheets with Muse Spark (real calls, capped by
 * MAX_COST_PER_DRAWING_IMPORT_USD or --max-cost), assembles the proposed BOQ in code and prints it with the cost.
 * Action items are always printed; notes only as a count unless --notes. --out also writes page PNGs and proposal.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { env } from "../src/config.js";
import { assembleProposal, runActions } from "../src/services/drawings/assemble.js";
import { ImportCostMeter } from "../src/services/drawings/cost.js";
import { isStructural, runPipeline, type PageState } from "../src/services/drawings/pipeline.js";
import { rasterizePdf } from "../src/services/drawings/rasterize.js";
import { formatProposal } from "./drawings-lib.js";

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { pdf: { type: "string" }, out: { type: "string" }, "max-cost": { type: "string" }, notes: { type: "boolean", default: false } },
});
const cwd = process.env.INIT_CWD ?? process.cwd();

async function main() {
  if (!args.pdf) {
    console.error("usage: pnpm boq-from-drawings --pdf <file.pdf> [--out <dir>] [--max-cost <usd>]");
    process.exit(2);
  }
  const limit = args["max-cost"] ? Number(args["max-cost"]) : env.MAX_COST_PER_DRAWING_IMPORT_USD;
  if (!(limit > 0)) throw new Error("--max-cost must be a positive number");

  const started = Date.now();
  const pages = await rasterizePdf(await readFile(resolve(cwd, args.pdf)), { maxEdge: 2000, maxPages: env.DRAWING_MAX_PAGES });
  console.log(`${pages.length} page(s) rasterised in ${((Date.now() - started) / 1000).toFixed(1)} s · cost cap $${limit.toFixed(2)} · model ${env.SPARK_MODEL}`);
  const outDir = args.out ? resolve(cwd, args.out) : null;
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    for (const p of pages) await writeFile(join(outDir, `page-${String(p.pageNo).padStart(2, "0")}.png`), p.png);
  }

  const meter = new ImportCostMeter(limit);
  const states: PageState[] = pages.map((p) => ({ pageNo: p.pageNo, classification: null, extraction: null, error: null }));
  const { stoppedByCost } = await runPipeline(
    states,
    {
      png: async (n) => pages[n - 1]!.png,
      onClassified: (n, c) => console.log(`  p.${n} ${c.sheet_type.padEnd(24)} ${c.title}${isStructural(c.sheet_type) ? "" : "  (skipped)"}`),
      onExtracted: (n, e) =>
        console.log(
          `  p.${n} extracted: ${e.columns.length} column rows, ${e.footings.length} footing rows, ${e.beams.length} beams, ${e.slabs.length} slabs, ${e.layout_counts.length} layout counts`,
        ),
      onFailed: (n, err) => console.log(`  p.${n} FAILED: ${err}`),
    },
    meter,
    env.DRAWING_CONCURRENCY,
  );

  const proposal = assembleProposal(states);
  proposal.warnings.unshift(...runActions(states, stoppedByCost, limit, isStructural));
  console.log(`\n${formatProposal(proposal, { notes: args.notes })}`);
  console.log(
    `\nCost: $${meter.spentUsd.toFixed(4)} (${meter.calls} Spark call(s), ${meter.inputTokens} in / ${meter.outputTokens} out tokens) · ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  if (outDir) {
    await writeFile(join(outDir, "proposal.json"), JSON.stringify({ pages: states, proposal, costUsd: meter.spentUsd }, null, 2));
    console.log(`Pages and proposal.json in ${outDir}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
