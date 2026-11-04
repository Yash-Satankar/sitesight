// Fills the Evaluation section of site/index.html from the newest human-labelled eval report.
//   node site/update-eval.mjs [samples/out/eval]
// Reads report.json files (written by `pnpm eval`), picks the newest one with human-labelled headline numbers, and
// rewrites the block between <!-- EVAL:START --> and <!-- EVAL:END -->. Never type numbers in by hand.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(here, "..", process.argv[2] ?? "samples/out/eval");
const reports = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f === "report.json") reports.push({ p, t: statSync(p).mtimeMs });
  }
};
try {
  walk(evalDir);
} catch {
  // no eval output yet
}
const pick = reports
  .sort((a, b) => b.t - a.t)
  .map(({ p }) => JSON.parse(readFileSync(p, "utf8")))
  .find((j) => j.headline && j.meta?.humanCases > 0);

const pct = (r) => (r && r.total ? `${Math.round((r.pass / r.total) * 100)}% <span class="muted">(${r.pass}/${r.total})</span>` : null);
let block;
if (!pick) {
  block = `<p class="muted">Evaluation results coming soon: the labelled cases are being confirmed by a site engineer.</p>`;
} else {
  const h = pick.headline;
  const rows = [
    ["Stage, exact match", pct(h.stage)],
    ["Count within tolerance", pct(h.count)],
    ["Evidence basis correct", pct(h.basis)],
    ["Drawing import checks", pct(h.drawings)],
    ["False detections caught (labelled)", pct(h.rejectNotes)],
    ["Same answer across runs", pct(h.consistency)],
    ["Cost per visit (avg)", h.avgCostPerRunUsd != null ? `$${h.avgCostPerRunUsd.toFixed(2)}` : null],
  ].filter(([, v]) => v != null);
  block = [
    `<p class="muted">${pick.meta.humanCases} human-labelled case${pick.meta.humanCases === 1 ? "" : "s"} × ${pick.meta.runsPerCase} run${pick.meta.runsPerCase === 1 ? "" : "s"}, real site photos, ${pick.meta.model} (eval of ${pick.meta.date}).</p>`,
    `<table class="eval"><tbody>`,
    ...rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`),
    `</tbody></table>`,
  ].join("\n      ");
}

const file = join(here, "index.html");
const html = readFileSync(file, "utf8");
const out = html.replace(/(<!-- EVAL:START[^>]*-->)[\s\S]*?(\s*<!-- EVAL:END -->)/, `$1\n      ${block}$2`);
writeFileSync(file, out);
console.log(pick ? `Evaluation filled from the ${pick.meta.date} report (${pick.meta.humanCases} human-labelled cases).` : "No human-labelled report yet: kept \"coming soon\".");
