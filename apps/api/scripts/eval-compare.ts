/**
 * Side-by-side comparison of two eval reports (e.g. baseline vs AGENT_FAST_PATH=true):
 *   pnpm eval-compare samples/out/eval/<a>/report.json samples/out/eval/<b>/report.json [--out compare.md]
 * Prints a markdown table of every summary metric, per-case turns / latency / cost, and the keep-or-drop verdict
 * (keep only if no accuracy metric drops and latency improves).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { compareMarkdown, type Report } from "./eval-lib.js";

const { values: args, positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { out: { type: "string" }, "label-a": { type: "string" }, "label-b": { type: "string" } },
  allowPositionals: true,
});
if (positionals.length !== 2) {
  console.error("usage: pnpm eval-compare <a/report.json> <b/report.json> [--out compare.md] [--label-a baseline] [--label-b fast-path]");
  process.exit(1);
}
const [a, b] = await Promise.all(positionals.map(async (p) => JSON.parse(await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), p), "utf8")) as Report));
const md = compareMarkdown(a!, b!, { a: args["label-a"] ?? a!.meta.name ?? "A", b: args["label-b"] ?? b!.meta.name ?? "B" });
console.log(md);
if (args.out) await writeFile(resolve(process.env.INIT_CWD ?? process.cwd(), args.out), md);
