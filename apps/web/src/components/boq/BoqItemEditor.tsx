import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Unit, type BoqItemInput, type BoqStage } from "@sitesight/shared";

// Only columns (count) and brickwork (area) can be measured from photos; the API rejects other combinations.
export const MEASURED_AS = {
  visual_only: { label: "Visual check only", patch: { measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null } },
  column: { label: "Count columns", patch: { measureMode: "count", segmentTargets: ["column"], panelPlannedQty: null, stages: null } },
  brickwork: { label: "Area of brickwork", patch: { measureMode: "area", segmentTargets: ["brickwork"], stages: null } },
} satisfies Record<string, { label: string; patch: Pick<BoqItemInput, "measureMode" | "segmentTargets"> & Partial<BoqItemInput> }>;

export function measuredAs(it: Pick<BoqItemInput, "measureMode" | "segmentTargets">): keyof typeof MEASURED_AS {
  if (it.measureMode === "count" && it.segmentTargets.includes("column")) return "column";
  if (it.measureMode === "area" && it.segmentTargets.includes("brickwork")) return "brickwork";
  return "visual_only";
}

export const DEFAULT_STAGES: BoqStage[] = [
  { name: "shuttering", weight: 0.25 },
  { name: "reinforcement", weight: 0.35 },
  { name: "concreting", weight: 0.4 },
];

/** Problem with a stage list, or null (same rules as the API: ≥ 2 unique names, weights summing to 100%). */
export function stagesProblem(stages: BoqStage[] | null): string | null {
  if (!stages) return null;
  if (stages.length < 2) return "Add at least 2 stages, or remove them all";
  if (stages.some((s) => !s.name.trim())) return "Every stage needs a name";
  const names = stages.map((s) => s.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Stage names must be different";
  const sum = Math.round(stages.reduce((a, s) => a + s.weight, 0) * 1000) / 10;
  if (Math.abs(sum - 100) > 0.1) return `Weights add up to ${sum}%; they must total 100%`;
  return null;
}

/**
 * Editable fields of one BOQ item: planned qty, unit, how it is measured, qty per bay (area items) and stages
 * (visual-only items). `header` and `footer` let a caller add its own content (sources, warnings).
 */
export function BoqItemEditor({
  item,
  onChange,
  header,
  footer,
  highlightQty = false,
  className = "",
}: {
  item: BoqItemInput;
  onChange: (patch: Partial<BoqItemInput>) => void;
  header?: ReactNode;
  footer?: ReactNode;
  /** Draw attention to the quantity (it needs input). */
  highlightQty?: boolean;
  className?: string;
}) {
  return (
    <li className={`card space-y-3 ${className}`}>
      {header ?? (
        <p className="text-[15px] leading-snug">
          <span className="mr-1.5 font-mono text-xs font-semibold text-slate-600">{item.code}</span>
          {item.description}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block text-xs font-semibold text-slate-600">
          Planned qty
          <input
            className={`input num mt-1 ${highlightQty ? "border-amber-500 bg-amber-50" : ""}`}
            type="number"
            inputMode="decimal"
            min={0}
            value={item.plannedQty}
            onChange={(e) => onChange({ plannedQty: Number(e.target.value) })}
          />
        </label>
        <label className="block text-xs font-semibold text-slate-600">
          Unit
          <select className="input mt-1" value={item.unit} onChange={(e) => onChange({ unit: e.target.value as Unit })}>
            {Unit.options.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <label className="col-span-2 block text-xs font-semibold text-slate-600">
          Measured as
          <select className="input mt-1" value={measuredAs(item)} onChange={(e) => onChange(MEASURED_AS[e.target.value as keyof typeof MEASURED_AS].patch)}>
            {Object.entries(MEASURED_AS).map(([key, opt]) => (
              <option key={key} value={key}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        {item.measureMode === "area" && (
          <label className="col-span-2 block text-xs font-semibold text-slate-600" title="Planned quantity inside one photographed panel, e.g. one brick bay between two columns">
            Qty in one bay (optional)
            <input
              className="input num mt-1"
              type="number"
              inputMode="decimal"
              min={0}
              placeholder="optional"
              value={item.panelPlannedQty ?? ""}
              onChange={(e) => onChange({ panelPlannedQty: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
        )}
      </div>
      {item.measureMode === "visual_only" && <StagesEditor stages={item.stages} onChange={(stages) => onChange({ stages })} />}
      {footer}
    </li>
  );
}

/** Stages of a visual-only item (e.g. shuttering → reinforcement → concreting) with weights in %. */
export function StagesEditor({ stages, onChange }: { stages: BoqStage[] | null; onChange: (s: BoqStage[] | null) => void }) {
  if (!stages) {
    return (
      <button type="button" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent" onClick={() => onChange(DEFAULT_STAGES)}>
        <Plus className="h-4 w-4" aria-hidden /> Track in stages
      </button>
    );
  }
  const problem = stagesProblem(stages);
  const set = (i: number, patch: Partial<BoqStage>) => onChange(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="space-y-2 rounded-xl bg-slate-50 p-3">
      <legend className="sr-only">Stages</legend>
      <div className="flex items-center text-xs font-semibold text-slate-600">
        <span className="flex-1">Stages, in order</span>
        <span className="w-20 text-right">Weight</span>
        <span className="w-11" />
      </div>
      {stages.map((s, i) => (
        <div key={i} className="flex items-center gap-2">
          <input className="input min-h-11 flex-1" value={s.name} aria-label={`Stage ${i + 1} name`} onChange={(e) => set(i, { name: e.target.value })} />
          <div className="relative w-20">
            <input
              className="input num min-h-11 pr-6 text-right"
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              aria-label={`Stage ${i + 1} weight in percent`}
              value={Math.round(s.weight * 1000) / 10}
              onChange={(e) => set(i, { weight: Number(e.target.value) / 100 })}
            />
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-sm text-slate-500">%</span>
          </div>
          <button type="button" className="btn-ghost min-h-11 min-w-11 px-0 text-slate-500" aria-label={`Remove stage ${i + 1}`} onClick={() => onChange(stages.length > 1 ? stages.filter((_, j) => j !== i) : null)}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-3">
        <button type="button" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent" onClick={() => onChange([...stages, { name: "", weight: 0 }])}>
          <Plus className="h-4 w-4" aria-hidden /> Add stage
        </button>
        <button type="button" className="inline-flex min-h-11 items-center text-sm font-medium text-slate-600" onClick={() => onChange(null)}>
          No stages
        </button>
      </div>
      {problem && <p className="text-sm font-medium text-amber-900">{problem}</p>}
    </fieldset>
  );
}
