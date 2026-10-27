import type { ScaleReference } from "@sitesight/shared";

// Pure code, no model calls. Pixel → metre conversion using a reference object in the same photo.
// Ignores perspective: scale_confidence drops when the reference is far from the target or skewed.

export type BBox = [number, number, number, number]; // x, y, w, h

export interface MeasureSegment {
  id: number;
  bbox: BBox;
  areaPx: number;
  score: number;
}

export interface MeasureResult {
  count: number;
  areaM2: number | null;
  scaleConfidence: number;
  notes: string[];
}

/** Real-world size of each reference. Area refs use face area; the tape uses its length. */
export const REFERENCES: Record<ScaleReference, { kind: "area"; m2: number; aspect: number } | { kind: "length"; m: number }> = {
  a4: { kind: "area", m2: 0.0624, aspect: 297 / 210 },
  brick: { kind: "area", m2: 0.19 * 0.09, aspect: 190 / 90 }, // Indian modular brick face
  tape_1m: { kind: "length", m: 1 },
};

/** Square metres per square pixel derived from the reference segment. */
export function m2PerPx2(reference: ScaleReference, ref: MeasureSegment): number {
  const spec = REFERENCES[reference];
  if (spec.kind === "area") return spec.m2 / ref.areaPx;
  const lengthPx = Math.hypot(ref.bbox[2], ref.bbox[3]); // tape is thin; diagonal ≈ its length
  const mPerPx = spec.m / lengthPx;
  return mPerPx * mPerPx;
}

export function measure(
  targets: MeasureSegment[],
  reference: ScaleReference,
  ref: MeasureSegment | null,
  image: { width: number; height: number },
): MeasureResult {
  const notes: string[] = [];
  if (!ref) {
    notes.push(`No ${reference} reference found in photo; area unavailable.`);
    return { count: targets.length, areaM2: null, scaleConfidence: 0, notes };
  }

  const ratio = m2PerPx2(reference, ref);
  const areaM2 = targets.reduce((sum, t) => sum + t.areaPx * ratio, 0);
  return {
    count: targets.length,
    areaM2: round(areaM2, 3),
    scaleConfidence: round(scaleConfidence(reference, ref, targets, image, notes), 2),
    notes,
  };
}

function scaleConfidence(
  reference: ScaleReference,
  ref: MeasureSegment,
  targets: MeasureSegment[],
  image: { width: number; height: number },
  notes: string[],
): number {
  let c = Math.min(1, ref.score);

  // Distance penalty: reference centre vs. target centroid, normalised by image diagonal.
  const diag = Math.hypot(image.width, image.height);
  const [rx, ry] = centre(ref.bbox);
  const tc = targets.map((t) => centre(t.bbox));
  const tx = tc.reduce((s, p) => s + p[0], 0) / tc.length;
  const ty = tc.reduce((s, p) => s + p[1], 0) / tc.length;
  const dist = Math.hypot(rx - tx, ry - ty) / diag;
  if (dist > 0.25) {
    c *= Math.max(0.3, 1 - (dist - 0.25) * 1.5);
    notes.push("Reference is far from the target; perspective error likely.");
  }

  // Skew penalty for rectangular references: observed aspect vs. true aspect.
  const spec = REFERENCES[reference];
  if (spec.kind === "area") {
    const [, , w, h] = ref.bbox;
    const observed = Math.max(w, h) / Math.max(1, Math.min(w, h));
    const skew = Math.abs(observed - spec.aspect) / spec.aspect;
    if (skew > 0.15) {
      c *= Math.max(0.3, 1 - skew);
      notes.push("Reference looks skewed; photo is probably not square-on.");
    }
  }

  // Reference much smaller than targets → small errors blow up.
  const targetArea = targets.reduce((s, t) => s + t.areaPx, 0);
  if (targetArea / ref.areaPx > 400) {
    c *= 0.7;
    notes.push("Reference is tiny relative to the target area.");
  }
  return c;
}

function centre([x, y, w, h]: BBox): [number, number] {
  return [x + w / 2, y + h / 2];
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
