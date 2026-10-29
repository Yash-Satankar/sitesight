import type { BoqItem, ProjectDetail } from "@sitesight/shared";
import { ClipboardList } from "lucide-react";
import { Chip, EmptyState, ProgressBar, capitalize, fmtDate, fmtQty, type Tone } from "./ui";

const MODE_LABEL: Record<string, string> = { count: "counted", area: "measured", visual_only: "visual" };
type ItemAssessments = ProjectDetail["itemAssessments"][string];

/** One chip per row: what the engineer most needs to know about the item. */
function rowStatus(pct: number | undefined, a: ItemAssessments | undefined): { tone: Tone; label: string } {
  const { confirmed, latest } = a ?? {};
  if (latest && latest.status === "proposed" && latest.assessmentId !== confirmed?.assessmentId) {
    return { tone: "neutral", label: `New ${Math.round(latest.percentComplete)}% · to review` };
  }
  if (confirmed?.basis === "inferred") return { tone: "attention", label: "Inferred — not billable" };
  if (pct != null && pct >= 99.5) return { tone: "done", label: "Done" };
  if (pct != null && pct > 0) return { tone: "neutral", label: "In progress" };
  return { tone: "neutral", label: "Not started" };
}

/** BOQ items as rows: code + description, big %, progress bar, stored stage for staged items, one status chip. */
export function BoqTable({
  items,
  progress,
  itemAssessments = {},
}: {
  items: BoqItem[];
  progress: Record<string, number>;
  itemAssessments?: ProjectDetail["itemAssessments"];
}) {
  if (!items.length) {
    return (
      <EmptyState icon={ClipboardList} title="No BOQ items yet">
        Upload the bill of quantities to start tracking progress.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((it) => {
        const pct = progress[String(it.id)];
        const a = itemAssessments[String(it.id)];
        const confirmed = a?.confirmed ?? null;
        const done = pct != null && pct >= 99.5;
        const status = rowStatus(pct, a);
        return (
          <li key={it.id} className="py-3 first:pt-1 last:pb-1">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] leading-snug">
                  <span className="mr-1.5 font-mono text-xs font-semibold text-slate-600">{it.code}</span>
                  {it.description}
                </p>
                <p className="num mt-0.5 text-xs text-slate-600">
                  {fmtQty(it.plannedQty)} {it.unit} planned · {MODE_LABEL[it.measureMode] ?? it.measureMode}
                  {confirmed ? ` · as of ${fmtDate(confirmed.visitDate, false)}` : ""}
                </p>
              </div>
              {pct == null ? (
                <span className="shrink-0 pt-0.5 text-sm font-medium text-slate-500">No data</span>
              ) : (
                <span className="num shrink-0 text-2xl leading-none font-bold">{Math.round(pct)}%</span>
              )}
            </div>
            <ProgressBar pct={pct} tone={confirmed?.basis === "inferred" ? "attention" : done ? "done" : "busy"} className="mt-2" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Chip tone={status.tone}>{status.label}</Chip>
              {confirmed?.stageReached && !done && (
                <span className="text-sm text-slate-700">
                  Stage: <strong>{capitalize(confirmed.stageReached)}</strong>
                  {it.stages?.length ? <span className="num text-slate-500"> of {it.stages.length}</span> : null}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
