import type { BoqProposal } from "@sitesight/shared";

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/** Console view of a proposed BOQ: action items first and prominent, then items; notes as a count unless asked for. */
export function formatProposal(p: BoqProposal, opts: { notes?: boolean } = {}): string {
  const actions = p.warnings.filter((w) => w.kind === "action");
  const notes = p.warnings.filter((w) => w.kind === "note");
  const lines: string[] = [];
  if (actions.length) {
    lines.push(`ACTION NEEDED (${actions.length}):`);
    for (const a of actions) lines.push(`  ! ${a.text}`);
    lines.push("");
  }
  lines.push("Proposed BOQ:");
  if (!p.items.length) lines.push("  (no items: no structural sheets could be read)");
  for (const it of p.items) {
    const qty = it.needsInput ? "NEEDS INPUT" : `${it.plannedQty} ${it.unit}`;
    lines.push(`  ${pad(it.code, 8)} ${pad(it.description, 72)} ${pad(qty, 12)} ${it.measureMode}${it.stages ? ` · stages ${it.stages.map((s) => `${s.name} ${s.weight}`).join(" / ")}` : ""}`);
    lines.push(`  ${" ".repeat(8)} ${it.drawingSource ?? ""} · confidence ${Math.round(it.confidence * 100)}%`);
  }
  if (notes.length) {
    lines.push("");
    if (opts.notes) {
      lines.push(`Notes (${notes.length}):`);
      for (const n of notes) lines.push(`  - ${n.text}`);
    } else {
      lines.push(`${notes.length} note(s) from the sheets (general notes, title blocks); show them with --notes.`);
    }
  }
  return lines.join("\n");
}
