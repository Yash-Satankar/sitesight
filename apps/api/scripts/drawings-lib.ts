import type { BoqProposal } from "@sitesight/shared";

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/** Console view of a proposed BOQ: items, needs-input, discrepancies, warnings. */
export function formatProposal(p: BoqProposal): string {
  const lines: string[] = ["Proposed BOQ:"];
  if (!p.items.length) lines.push("  (no items: no structural sheets could be read)");
  for (const it of p.items) {
    const qty = it.needsInput ? "NEEDS INPUT" : `${it.plannedQty} ${it.unit}`;
    lines.push(`  ${pad(it.code, 8)} ${pad(it.description, 64)} ${pad(qty, 12)} ${it.measureMode}${it.stages ? ` · stages ${it.stages.map((s) => `${s.name} ${s.weight}`).join(" / ")}` : ""}`);
    lines.push(`  ${" ".repeat(8)} ${it.drawingSource ?? ""} · confidence ${Math.round(it.confidence * 100)}%`);
  }
  if (p.discrepancies.length) {
    lines.push("", "Drawing discrepancies (not resolved; the engineer decides):");
    for (const d of p.discrepancies) lines.push(`  ! ${d.message}`);
  }
  if (p.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of p.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}
