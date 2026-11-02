// Pure helpers for scripts/seed-prod.ts and scripts/prod-photos.ts (no src/ imports, no network).
import { basename } from "node:path";
import type { BoqItemInput, BoqProposal, BoqStage } from "@sitesight/shared";

/** Only real site photos may go to production: WhatsApp exports from October 2026, JPEG. Never stock images. */
export function isRealSitePhoto(path: string): boolean {
  return /^WhatsApp Image 2026-10-\d{2} at [\d.]+ [AP]M( \(\d+\))?\.jpe?g$/i.test(basename(path));
}

export function assertRealSitePhoto(path: string): void {
  if (!isRealSitePhoto(path)) throw new Error(`Refusing to upload "${basename(path)}": only the real site photos (WhatsApp Image 2026-10-*.jpeg) are allowed`);
}

const SLAB_STAGES: BoqStage[] = [
  { name: "shuttering", weight: 0.25 },
  { name: "reinforcement", weight: 0.35 },
  { name: "concreting", weight: 0.4 },
];

export interface PreparedBoq {
  items: BoqItemInput[];
  /** What was changed from the drawing proposal, for the log. */
  fixes: string[];
}

/**
 * The Demo Residence drawing proposal → the BOQ to save, with the fixes the import needs:
 * - slabs: exactly one "G.F roof slab, 5" RCC" item (merges split slab items, adds the 5" thickness if missing);
 * - "needs input" quantities: filled from the reviewed BOQ (boq-demo-residence.json) by element (columns, footings), noted in
 *   drawingSource as entered by the engineer.
 */
export function prepareDemoResidenceBoq(proposal: BoqProposal, reviewed: Omit<BoqItemInput, "zoneId">[], zoneId: number): PreparedBoq {
  const fixes: string[] = [];
  const out: BoqItemInput[] = [];
  const slabs = proposal.items.filter((i) => /^SLB/i.test(i.code));
  const reviewedQty = (prefix: RegExp) => reviewed.find((r) => prefix.test(r.code));

  for (const it of proposal.items) {
    if (/^SLB/i.test(it.code)) continue; // merged below
    let plannedQty = it.plannedQty;
    let drawingSource = it.drawingSource;
    if (it.needsInput) {
      const ref = /^COL/i.test(it.code) ? reviewedQty(/^COL/i) : /^FTG/i.test(it.code) ? reviewedQty(/^FTG/i) : undefined;
      if (ref) {
        plannedQty = ref.plannedQty;
        drawingSource = `${plannedQty} ${it.unit} entered by the engineer (drawings: ${it.needsInput})`.slice(0, 500);
        fixes.push(`${it.code}: needs input (${it.needsInput}) → ${plannedQty} ${it.unit} from the reviewed BOQ`);
      } else {
        fixes.push(`${it.code}: still needs input (${it.needsInput}); saved with quantity ${plannedQty}`);
      }
    }
    out.push(toInput(it, zoneId, plannedQty, drawingSource));
  }

  if (slabs.length) {
    const first = slabs[0]!;
    const inside = slabs.map((s) => /\(([^)]*)\)/.exec(s.description)?.[1]).find(Boolean);
    const description = `G.F roof slab, 5" RCC${inside ? ` (${inside})` : ""}`;
    const single = slabs.length === 1 ? first : null;
    const unit = single?.unit === "m3" ? "m3" : "lot";
    const plannedQty = unit === "m3" ? single!.plannedQty : 1;
    if (slabs.length > 1) fixes.push(`slabs: merged ${slabs.map((s) => s.code).join(", ")} into one SLB-GF item`);
    if (!slabs.some((s) => s.description.includes('5"'))) fixes.push('SLB-GF: added the 5" thickness from the slab schedule');
    if (single && single.description !== description) fixes.push(`SLB-GF: description "${single.description}" → "${description}"`);
    out.push({
      ...toInput(first, zoneId, plannedQty, first.drawingSource),
      code: "SLB-GF",
      description,
      unit,
      stages: SLAB_STAGES,
      measureMode: "visual_only",
      segmentTargets: [],
      drawingSource: `${plannedQty} ${unit} per ${[...new Set(slabs.flatMap((s) => s.sources.map((x) => `${x.sheet} p.${x.page}`)))].join("; ")}`.slice(0, 500),
    });
  }
  return { items: out, fixes };
}

function toInput(it: BoqProposal["items"][number], zoneId: number, plannedQty: number, drawingSource: string | null): BoqItemInput {
  return {
    zoneId,
    code: it.code,
    description: it.description,
    unit: it.unit,
    plannedQty,
    measureMode: it.measureMode,
    segmentTargets: it.segmentTargets,
    panelPlannedQty: it.panelPlannedQty,
    stages: it.stages,
    sequenceNo: it.sequenceNo,
    drawingSource,
  };
}

/** A paid step may start only if its worst case (the server-side cap for that step) still fits the seed budget. */
export function fitsBudget(spentUsd: number, stepCapUsd: number, maxUsd: number): boolean {
  return spentUsd + stepCapUsd <= maxUsd + 1e-9;
}

/** The photos to send to the phone for live recording: target name → source under samples/. */
export const TO_PHONE: Record<string, string> = {
  "demo-residence-v2-slab-cast.jpg": "samples/demo-residence/v2/WhatsApp Image 2026-10-28 at 11.21.45 AM.jpeg",
  "plinth-rebar-cages.jpg": "samples/run2/WhatsApp Image 2026-10-24 at 3.35.51 PM (1).jpeg",
  "g2-frame-scaffolding.jpg": "samples/run1/WhatsApp Image 2026-10-24 at 3.35.50 PM (1).jpeg",
};
