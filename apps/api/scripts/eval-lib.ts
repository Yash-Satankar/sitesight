// Pure helpers for scripts/eval.ts: case schema, scoring, consistency, the report and the global budget.
// No imports from src/ (eval.ts sets DATABASE_URL / STORAGE_LOCAL_DIR before src/config.ts loads).
import { z } from "zod";

// ---- cases ----

const ItemLabel = z
  .object({
    /** Staged items: the latest completed stage, exact match (case-insensitive). */
    stage: z.string().min(1).optional(),
    /** Count items: qty_done must be within ± tolerance. 0 also passes when the item is (rightly) not assessed. */
    count: z.number().int().nonnegative().optional(),
    tolerance: z.number().nonnegative().default(0),
    basis: z.enum(["observed", "inferred"]).optional(),
  })
  .refine((l) => l.stage != null || l.count != null || l.basis != null, "an item label needs stage, count or basis");

const RejectNote = z.object({
  note: z.string().min(1),
  /** Passes when any rejected detection's reason contains one of these (case-insensitive). */
  keywords: z.array(z.string().min(1)).min(1),
});

export const PhotoCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.literal("photos"),
  description: z.string().default(""),
  photos: z.array(z.string().min(1)).min(1),
  boq: z.string().min(1),
  expected: z.record(z.string(), ItemLabel),
  should_reject: z.array(RejectNote).default([]),
});
export type PhotoCase = z.infer<typeof PhotoCase>;

export const DrawingCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.literal("drawings"),
  description: z.string().default(""),
  pdf: z.string().min(1),
  expected: z.object({
    columns: z.number().int().nonnegative().optional(),
    footings: z.number().int().nonnegative().optional(),
    slabs: z.object({ floor: z.string().min(1), count: z.number().int().positive(), thickness: z.string().optional() }).optional(),
  }),
});
export type DrawingCase = z.infer<typeof DrawingCase>;

export const EvalCases = z.object({
  labels_note: z.string().default(""),
  cases: z
    .array(z.discriminatedUnion("kind", [PhotoCase, DrawingCase]))
    .min(1)
    .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "case ids must be unique"),
});
export type EvalCases = z.infer<typeof EvalCases>;
export type EvalCase = EvalCases["cases"][number];

export function parseCases(text: string): EvalCases {
  const r = EvalCases.safeParse(JSON.parse(text));
  if (!r.success) throw new Error(`Invalid cases file:\n  ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  return r.data;
}

// ---- what a run produced (filled by eval.ts) ----

export interface PhotoRunOutput {
  assessments: { code: string; stageReached: string | null; qtyDone: number | null; basis: "observed" | "inferred" }[];
  /** Item status when not assessed, e.g. "awaiting photo (ask-back #3)". */
  itemStatus: Record<string, string>;
  detections: { total: number; kept: number; rejected: number; unverified: number };
  rejections: { segmentId: number; concept: string; reason: string; photo: string }[];
  outcome: string;
  error: string | null;
}

export interface DrawingRunOutput {
  items: { code: string; description: string; plannedQty: number; unit: string; needsInput: string | null }[];
  actions: string[];
  error: string | null;
}

export interface Check {
  item: string;
  metric: "stage" | "count" | "basis" | "columns" | "footings" | "slab_items" | "slab_thickness";
  expected: string;
  actual: string;
  pass: boolean;
  note?: string;
}

export interface RunRecord {
  caseId: string;
  kind: "photos" | "drawings";
  run: number;
  status: "done" | "failed" | "skipped";
  /** Why skipped/failed. */
  reason?: string;
  costUsd: number;
  latencyMs: number;
  /** Model turns used by the agent (photo cases). */
  turns?: number;
  checks: Check[];
  rejectNotes?: { note: string; matched: boolean; example?: string }[];
  detections?: PhotoRunOutput["detections"];
  rejections?: PhotoRunOutput["rejections"];
}

// ---- scoring ----

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function scorePhotoRun(c: PhotoCase, out: PhotoRunOutput): { checks: Check[]; rejectNotes: NonNullable<RunRecord["rejectNotes"]> } {
  const checks: Check[] = [];
  for (const [code, label] of Object.entries(c.expected)) {
    const a = out.assessments.find((x) => x.code === code);
    const missing = a ? undefined : `not assessed${out.itemStatus[code] ? ` (${out.itemStatus[code]})` : ""}`;
    if (label.stage != null) {
      const actual = a?.stageReached ?? null;
      checks.push({ item: code, metric: "stage", expected: label.stage, actual: actual ?? "—", pass: norm(actual) === norm(label.stage), note: missing });
    }
    if (label.count != null) {
      const actual = a?.qtyDone ?? null;
      // Expecting 0 cast instances and the agent recording nothing is right too.
      const pass = actual == null ? label.count === 0 && !a : Math.abs(actual - label.count) <= label.tolerance;
      checks.push({
        item: code,
        metric: "count",
        expected: label.tolerance ? `${label.count} ± ${label.tolerance}` : String(label.count),
        actual: actual == null ? "—" : String(actual),
        pass,
        note: missing,
      });
    }
    if (label.basis != null) {
      const actual = a?.basis ?? null;
      checks.push({ item: code, metric: "basis", expected: label.basis, actual: actual ?? "—", pass: actual === label.basis, note: missing });
    }
  }
  const rejectNotes = c.should_reject.map((r) => {
    const hit = out.rejections.find((x) => r.keywords.some((k) => norm(x.reason).includes(norm(k))));
    return { note: r.note, matched: !!hit, example: hit ? `#${hit.segmentId} ${hit.concept}: "${hit.reason}"` : undefined };
  });
  return { checks, rejectNotes };
}

export function scoreDrawingRun(c: DrawingCase, out: DrawingRunOutput): Check[] {
  const checks: Check[] = [];
  const total = (re: RegExp, label: string, metric: Check["metric"], expected: number | undefined) => {
    if (expected == null) return;
    const items = out.items.filter((i) => re.test(i.code));
    const open = items.filter((i) => i.needsInput);
    const actual = open.length || !items.length ? null : items.reduce((s, i) => s + i.plannedQty, 0);
    checks.push({
      item: label,
      metric,
      expected: String(expected),
      actual: actual == null ? (items.length ? "needs input" : "—") : String(actual),
      pass: actual === expected,
      note: open.length ? open.map((i) => `${i.code}: ${i.needsInput}`).join("; ") : items.length ? undefined : "no item proposed",
    });
  };
  total(/^COL(-|$)/, "columns", "columns", c.expected.columns);
  total(/^FTG(-|$)/, "footings", "footings", c.expected.footings);
  if (c.expected.slabs) {
    const want = c.expected.slabs;
    const slabs = out.items.filter((i) => new RegExp(`^SLB-${want.floor}(-|$)`, "i").test(i.code));
    checks.push({ item: `SLB-${want.floor}`, metric: "slab_items", expected: String(want.count), actual: String(slabs.length), pass: slabs.length === want.count });
    if (want.thickness) {
      const ok = slabs.length > 0 && slabs.every((s) => s.description.includes(want.thickness!));
      checks.push({
        item: `SLB-${want.floor}`,
        metric: "slab_thickness",
        expected: want.thickness,
        actual: slabs.map((s) => s.description).join(" | ") || "—",
        pass: ok,
      });
    }
  }
  return checks;
}

// ---- consistency across runs ----

export interface Consistency {
  caseId: string;
  runs: number;
  /** Item+metric answers that were identical in every completed run. */
  stable: number;
  total: number;
  /** Answers per item+metric, in run order, for the report. */
  answers: { key: string; values: string[] }[];
}

export function consistency(records: RunRecord[]): Consistency[] {
  const byCase = new Map<string, RunRecord[]>();
  for (const r of records.filter((x) => x.status === "done")) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  return [...byCase.entries()]
    .filter(([, rs]) => rs.length >= 2)
    .map(([caseId, rs]) => {
      const keys = [...new Set(rs.flatMap((r) => r.checks.map((c) => `${c.item} ${c.metric}`)))];
      const answers = keys.map((key) => ({ key, values: rs.map((r) => r.checks.find((c) => `${c.item} ${c.metric}` === key)?.actual ?? "—") }));
      return { caseId, runs: rs.length, stable: answers.filter((a) => new Set(a.values).size === 1).length, total: answers.length, answers };
    });
}

// ---- summary ----

export interface Ratio {
  pass: number;
  total: number;
}
export interface Summary {
  stage: Ratio;
  count: Ratio;
  basis: Ratio;
  drawings: Ratio;
  rejectNotes: Ratio;
  detections: { total: number; rejected: number };
  consistency: Ratio | null;
  runs: { done: number; failed: number; skipped: number };
  costUsd: number;
  avgCostPerRunUsd: number | null;
  avgLatencyMs: number | null;
  avgTurns: number | null;
}

export function summarize(records: RunRecord[]): Summary {
  const done = records.filter((r) => r.status === "done");
  const ratio = (metrics: Check["metric"][]): Ratio => {
    const cs = done.flatMap((r) => r.checks.filter((c) => metrics.includes(c.metric)));
    return { pass: cs.filter((c) => c.pass).length, total: cs.length };
  };
  const cons = consistency(records);
  const photoDone = done.filter((r) => r.kind === "photos");
  return {
    stage: ratio(["stage"]),
    count: ratio(["count"]),
    basis: ratio(["basis"]),
    drawings: ratio(["columns", "footings", "slab_items", "slab_thickness"]),
    rejectNotes: {
      pass: photoDone.flatMap((r) => r.rejectNotes ?? []).filter((n) => n.matched).length,
      total: photoDone.flatMap((r) => r.rejectNotes ?? []).length,
    },
    detections: {
      total: photoDone.reduce((s, r) => s + (r.detections?.total ?? 0), 0),
      rejected: photoDone.reduce((s, r) => s + (r.detections?.rejected ?? 0), 0),
    },
    consistency: cons.length ? { pass: cons.reduce((s, c) => s + c.stable, 0), total: cons.reduce((s, c) => s + c.total, 0) } : null,
    runs: {
      done: done.length,
      failed: records.filter((r) => r.status === "failed").length,
      skipped: records.filter((r) => r.status === "skipped").length,
    },
    costUsd: round4(records.reduce((s, r) => s + r.costUsd, 0)),
    avgCostPerRunUsd: done.length ? round4(done.reduce((s, r) => s + r.costUsd, 0) / done.length) : null,
    avgLatencyMs: done.length ? Math.round(done.reduce((s, r) => s + r.latencyMs, 0) / done.length) : null,
    avgTurns: (() => {
      const t = done.filter((r) => r.turns != null);
      return t.length ? Math.round((t.reduce((s, r) => s + r.turns!, 0) / t.length) * 10) / 10 : null;
    })(),
  };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const pct = (r: Ratio) => (r.total ? `${r.pass}/${r.total} (${Math.round((r.pass / r.total) * 100)}%)` : "—");
const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(0)} s`);
const usd = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);

/** Markdown table to paste into the README. */
export function summaryTable(s: Summary, meta: { runsPerCase: number; cases: number; model: string; date: string; fastPath?: boolean }): string {
  const rows: [string, string][] = [
    ["Stage, exact match", pct(s.stage)],
    ["Count within tolerance", pct(s.count)],
    ["Evidence basis correct", pct(s.basis)],
    ["Drawing import checks", pct(s.drawings)],
    ["False detections caught (labelled)", pct(s.rejectNotes)],
    ["SAM detections rejected by the agent", s.detections.total ? `${s.detections.rejected}/${s.detections.total} (${Math.round((s.detections.rejected / s.detections.total) * 100)}%)` : "—"],
    ["Same answer across runs", s.consistency ? pct(s.consistency) : `— (needs --runs 2+)`],
    ["Cost per run (avg)", usd(s.avgCostPerRunUsd)],
    ["Latency per run (avg)", secs(s.avgLatencyMs)],
    ["Model turns per run (avg)", s.avgTurns == null ? "—" : String(s.avgTurns)],
    ["Total eval cost", usd(s.costUsd)],
  ];
  const head = `Eval ${meta.date} · ${meta.cases} cases × ${meta.runsPerCase} run(s) · ${meta.model}${meta.fastPath != null ? ` · AGENT_FAST_PATH=${meta.fastPath}` : ""}${s.runs.failed || s.runs.skipped ? ` · ${s.runs.failed} failed, ${s.runs.skipped} skipped` : ""}`;
  return [head, "", "| Metric | Result |", "|---|---|", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n");
}

export function reportMarkdown(
  records: RunRecord[],
  cases: EvalCase[],
  meta: { runsPerCase: number; model: string; date: string; maxCostUsd: number; labelsNote: string; outDir: string; fastPath?: boolean },
): string {
  const s = summarize(records);
  const lines: string[] = [`# SiteSight eval — ${meta.date}`, "", summaryTable(s, { ...meta, cases: cases.length }), ""];
  lines.push(`Budget cap: $${meta.maxCostUsd.toFixed(2)} · spent $${s.costUsd.toFixed(2)}${s.runs.skipped ? ` · ${s.runs.skipped} run(s) skipped at the cap` : ""}`, "");
  if (meta.labelsNote) lines.push(`> Labels: ${meta.labelsNote}`, "");
  const cons = consistency(records);

  for (const c of cases) {
    const rs = records.filter((r) => r.caseId === c.id);
    lines.push(`## ${c.id}`, "", c.description, "");
    lines.push("| Run | Status | Cost | Latency | Turns | Checks passed |", "|---|---|---|---|---|---|");
    for (const r of rs) {
      const passed = r.checks.filter((x) => x.pass).length;
      lines.push(`| ${r.run} | ${r.status}${r.reason ? ` (${r.reason})` : ""} | ${usd(r.costUsd)} | ${secs(r.latencyMs)} | ${r.turns ?? "—"} | ${r.status === "done" ? `${passed}/${r.checks.length}` : "—"} |`);
    }
    lines.push("");
    const done = rs.filter((r) => r.status === "done");
    if (done.length) {
      lines.push("| Item | Metric | Expected | " + done.map((r) => `Run ${r.run}`).join(" | ") + " |", "|---|---|---|" + done.map(() => "---|").join(""));
      for (const chk of done[0]!.checks) {
        const cells = done.map((r) => {
          const x = r.checks.find((y) => y.item === chk.item && y.metric === chk.metric);
          return x ? `${x.pass ? "✓" : "✗"} ${x.actual}${x.note ? ` — ${x.note}` : ""}` : "—";
        });
        lines.push(`| ${chk.item} | ${chk.metric} | ${chk.expected} | ${cells.join(" | ")} |`);
      }
      lines.push("");
    }
    if (c.kind === "photos" && done.length) {
      const det = done.reduce((a, r) => ({ total: a.total + (r.detections?.total ?? 0), rejected: a.rejected + (r.detections?.rejected ?? 0) }), { total: 0, rejected: 0 });
      lines.push(`**Detections:** ${det.rejected} of ${det.total} SAM detections rejected by the agent.`);
      const examples = [...new Map(done.flatMap((r) => r.rejections ?? []).map((x) => [x.reason, x])).values()].slice(0, 6);
      for (const e of examples) lines.push(`- #${e.segmentId} ${e.concept} (${e.photo}): "${e.reason}"`);
      if (c.should_reject.length) {
        lines.push("", "**Should reject:**");
        for (const n of c.should_reject) {
          const hits = done.filter((r) => r.rejectNotes?.find((x) => x.note === n.note)?.matched).length;
          lines.push(`- ${n.note}: caught in ${hits}/${done.length} run(s)`);
        }
      }
      lines.push("");
    }
    const k = cons.find((x) => x.caseId === c.id);
    if (k) {
      lines.push(`**Consistency:** ${k.stable}/${k.total} answers identical across ${k.runs} runs.`);
      for (const a of k.answers.filter((x) => new Set(x.values).size > 1)) lines.push(`- ${a.key}: ${a.values.join(" / ")}`);
      lines.push("");
    }
  }
  lines.push(`Logs and per-run files: \`${meta.outDir}\``);
  return lines.join("\n");
}

// ---- budget ----

/** The eval's hard cap: each run gets at most what is left, and runs are skipped once nothing is. */
export class EvalBudget {
  spentUsd = 0;
  constructor(readonly maxUsd: number) {}
  remaining(): number {
    return Math.max(0, this.maxUsd - this.spentUsd);
  }
  /** Cap for the next run: the smaller of its own cap and what is left; null when nothing is left. */
  capFor(perRunCapUsd: number): number | null {
    const left = this.remaining();
    return left > 0.0001 ? Math.min(perRunCapUsd, left) : null;
  }
  add(costUsd: number): void {
    this.spentUsd = round4(this.spentUsd + costUsd);
  }
}

export const EVAL_USAGE = `usage: pnpm eval [--runs 3] [--only <id>[,<id>…]] [--max-cost 10] [--cases samples/eval/cases.json] [--name baseline]
Runs every case through the real agent (in-memory DB) or the drawing import, scores it against the labels, and writes
samples/out/eval/<time>[-<name>]/report.md + report.json. --max-cost is a hard cap on Meta spend for the whole eval.
AGENT_FAST_PATH=true in the environment runs the agent fast path.`;

// ---- comparison (pnpm eval-compare) ----

export interface Report {
  meta: { date: string; runsPerCase: number; model: string; name?: string | null; fastPath?: boolean };
  records: RunRecord[];
  summary: Summary;
}

const rate = (r: Ratio) => (r.total ? r.pass / r.total : null);

/** Accuracy metrics gate the verdict: none may drop. */
const ACCURACY: { key: "stage" | "count" | "basis" | "rejectNotes"; label: string }[] = [
  { key: "stage", label: "Stage, exact match" },
  { key: "count", label: "Count within tolerance" },
  { key: "basis", label: "Evidence basis correct" },
  { key: "rejectNotes", label: "False detections caught (labelled)" },
];

export function compareVerdict(a: Summary, b: Summary): { keep: boolean; drops: string[]; latencyImproved: boolean } {
  const drops = ACCURACY.filter(({ key }) => {
    const ra = rate(a[key]);
    const rb = rate(b[key]);
    return ra != null && (rb == null || rb < ra - 1e-9);
  }).map((m) => m.label);
  if (b.runs.failed > a.runs.failed) drops.push("Failed runs");
  const latencyImproved = a.avgLatencyMs != null && b.avgLatencyMs != null && b.avgLatencyMs < a.avgLatencyMs;
  return { keep: !drops.length && latencyImproved, drops, latencyImproved };
}

export function compareMarkdown(a: Report, b: Report, labels: { a: string; b: string }): string {
  const sa = a.summary;
  const sb = b.summary;
  const delta = (x: number | null, y: number | null, fmt: (n: number) => string) =>
    x == null || y == null ? "" : ` (${y - x >= 0 ? "+" : "−"}${fmt(Math.abs(y - x))}, ${x ? `${y - x >= 0 ? "+" : "−"}${Math.round((Math.abs(y - x) / x) * 100)}%` : "—"})`;
  const rows: [string, string, string][] = [
    ...ACCURACY.map(({ key, label }) => [label, pct(sa[key]), pct(sb[key])] as [string, string, string]),
    [
      "SAM detections rejected by the agent",
      sa.detections.total ? `${sa.detections.rejected}/${sa.detections.total}` : "—",
      sb.detections.total ? `${sb.detections.rejected}/${sb.detections.total}` : "—",
    ],
    ["Same answer across runs", sa.consistency ? pct(sa.consistency) : "—", sb.consistency ? pct(sb.consistency) : "—"],
    ["Runs done / failed / skipped", `${sa.runs.done} / ${sa.runs.failed} / ${sa.runs.skipped}`, `${sb.runs.done} / ${sb.runs.failed} / ${sb.runs.skipped}`],
    ["Model turns per run (avg)", sa.avgTurns == null ? "—" : String(sa.avgTurns), `${sb.avgTurns ?? "—"}${delta(sa.avgTurns, sb.avgTurns, (n) => n.toFixed(1))}`],
    ["Latency per run (avg)", secs(sa.avgLatencyMs), `${secs(sb.avgLatencyMs)}${delta(sa.avgLatencyMs, sb.avgLatencyMs, (n) => `${(n / 1000).toFixed(0)} s`)}`],
    ["Cost per run (avg)", usd4(sa.avgCostPerRunUsd), `${usd4(sb.avgCostPerRunUsd)}${delta(sa.avgCostPerRunUsd, sb.avgCostPerRunUsd, (n) => `$${n.toFixed(3)}`)}`],
    ["Total eval cost", usd(sa.costUsd), usd(sb.costUsd)],
  ];
  const v = compareVerdict(sa, sb);
  const lines = [
    `# Eval comparison: ${labels.a} vs ${labels.b}`,
    "",
    `${labels.a}: ${a.meta.date}, ${a.meta.runsPerCase} run(s) per case, AGENT_FAST_PATH=${a.meta.fastPath ?? false} · ${labels.b}: ${b.meta.date}, ${b.meta.runsPerCase} run(s) per case, AGENT_FAST_PATH=${b.meta.fastPath ?? false}`,
    "",
    `| Metric | ${labels.a} | ${labels.b} |`,
    "|---|---|---|",
    ...rows.map(([m, x, y]) => `| ${m} | ${x} | ${y} |`),
    "",
    "## Per case (averages over completed runs)",
    "",
    `| Case | Checks passed (${labels.a} → ${labels.b}) | Turns | Latency | Cost |`,
    "|---|---|---|---|---|",
  ];
  const caseIds = [...new Set([...a.records, ...b.records].map((r) => r.caseId))];
  const avg = (rs: RunRecord[], f: (r: RunRecord) => number | undefined) => {
    const xs = rs.map(f).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };
  for (const id of caseIds) {
    const ra = a.records.filter((r) => r.caseId === id && r.status === "done");
    const rb = b.records.filter((r) => r.caseId === id && r.status === "done");
    const checks = (rs: RunRecord[]) => `${rs.reduce((s, r) => s + r.checks.filter((c) => c.pass).length, 0)}/${rs.reduce((s, r) => s + r.checks.length, 0)}`;
    const fmt = (x: number | null, f: (n: number) => string) => (x == null ? "—" : f(x));
    lines.push(
      `| ${id} | ${checks(ra)} → ${checks(rb)} | ${fmt(avg(ra, (r) => r.turns), (n) => n.toFixed(1))} → ${fmt(avg(rb, (r) => r.turns), (n) => n.toFixed(1))} | ${fmt(avg(ra, (r) => r.latencyMs), (n) => `${(n / 1000).toFixed(0)} s`)} → ${fmt(avg(rb, (r) => r.latencyMs), (n) => `${(n / 1000).toFixed(0)} s`)} | ${fmt(avg(ra, (r) => r.costUsd), (n) => `$${n.toFixed(3)}`)} → ${fmt(avg(rb, (r) => r.costUsd), (n) => `$${n.toFixed(3)}`)} |`,
    );
  }
  lines.push(
    "",
    "## Verdict",
    "",
    v.keep
      ? `Keep ${labels.b}: no accuracy metric dropped and latency improved.`
      : `Do not switch to ${labels.b}: ${[...(v.drops.length ? [`accuracy dropped on ${v.drops.join(", ")}`] : []), ...(v.latencyImproved ? [] : ["latency did not improve"])].join("; ")}.`,
  );
  return lines.join("\n");
}

const usd4 = (n: number | null) => (n == null ? "—" : `$${n.toFixed(3)}`);
