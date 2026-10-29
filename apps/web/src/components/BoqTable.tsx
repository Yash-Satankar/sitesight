import type { BoqItem } from "@sitesight/shared";
import { ClipboardList } from "lucide-react";
import { Chip, EmptyState, ProgressBar, capitalize, fmtQty, stageForPercent } from "./ui";

const MODE_LABEL: Record<string, string> = { count: "counted", area: "measured", visual_only: "visual" };

/** BOQ items as rows: code + description, progress bar with a big %, stage for staged items, status chip. */
export function BoqTable({ items, progress }: { items: BoqItem[]; progress: Record<string, number> }) {
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
        const stage = stageForPercent(it.stages, pct);
        const done = pct != null && pct >= 99.5;
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
                  {it.stages?.length ? ` · ${it.stages.length} stages` : ""}
                </p>
              </div>
              {pct == null ? (
                <span className="shrink-0 pt-0.5 text-sm font-medium text-slate-500">No data</span>
              ) : (
                <span className="num shrink-0 text-2xl leading-none font-bold">{Math.round(pct)}%</span>
              )}
            </div>
            <ProgressBar pct={pct} tone={done ? "done" : "busy"} className="mt-2" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {done ? <Chip tone="done">Done</Chip> : pct != null && pct > 0 ? <Chip tone="neutral">In progress</Chip> : <Chip tone="neutral">Not started</Chip>}
              {stage && !done && <span className="text-sm text-slate-700">Stage: <strong>{capitalize(stage)}</strong></span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
