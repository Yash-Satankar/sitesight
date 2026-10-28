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

// =============================================================================================
// Panel-relative measurement: what fraction of a wall panel is covered by the target masks.
// No real-world scale needed. All inputs are full-frame rasters (row-major, non-zero = set) in the
// normalised photo's pixel space. Pixel rules, shared by both modes so they agree exactly:
//   columns: x in [inner edge of left column, inner edge of right column), y in [top_y, bottom_y)
//   polygon: a pixel is inside when its centre (x+0.5, y+0.5) is inside the polygon
// =============================================================================================

export type Point = [number, number];

export type PanelSpec =
  | { kind: "columns"; left: Uint8Array; right: Uint8Array; topY: number; bottomY: number }
  | { kind: "polygon"; points: Point[] };

export interface Panel {
  region: Uint8Array; // 1 inside the panel
  width: number;
  height: number;
  areaPx: number;
  /** The panel extended past the image edge and was cut to it. */
  clipped: boolean;
  /** Corner/edge points for drawing the panel. */
  outline: Point[];
  warnings: string[];
}

export interface PanelMeasurement {
  panelAreaPx: number;
  coveredAreaPx: number;
  fraction: number; // 0..1
  clipped: boolean;
  warnings: string[];
}

/** Invalid panel input, worded for the model. */
export class PanelError extends Error {}

export const PANEL_MIN_IMAGE_FRACTION = 0.02;
export const PANEL_SUSPICIOUS_FRACTION = 0.98;
export const PANEL_MAX_OUTSIDE_FRACTION = 0.25;

export function buildPanel(spec: PanelSpec, width: number, height: number): Panel {
  return spec.kind === "columns" ? columnsPanel(spec, width, height) : polygonPanel(spec.points, width, height);
}

/** Coverage of the union of `targets` inside `panel`, with sanity warnings. */
export function measurePanel(targets: Uint8Array[], panel: Panel): PanelMeasurement {
  const n = panel.width * panel.height;
  for (const t of targets) if (t.length !== n) throw new PanelError("Target mask size does not match the photo.");

  let covered = 0;
  let targetArea = 0;
  for (let i = 0; i < n; i++) {
    let hit = false;
    for (const t of targets) {
      if (t[i]) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    targetArea++;
    if (panel.region[i]) covered++;
  }

  const fraction = panel.areaPx ? covered / panel.areaPx : 0;
  const warnings = [...panel.warnings];
  if (panel.areaPx < PANEL_MIN_IMAGE_FRACTION * n) {
    warnings.push(
      `Panel covers only ${pct(panel.areaPx / n)} of the image (< ${pct(PANEL_MIN_IMAGE_FRACTION)}); the fraction is unreliable at this size.`,
    );
  }
  if (fraction > PANEL_SUSPICIOUS_FRACTION) {
    warnings.push(`Target fills ${pct(fraction)} of the panel; the panel is probably drawn too small. Check it with view_photo(draw_panel).`);
  }
  if (targetArea === 0) {
    warnings.push("The target masks are empty.");
  } else {
    const outside = (targetArea - covered) / targetArea;
    if (covered === 0) {
      warnings.push("None of the target mask is inside the panel; check the panel bounds and target ids.");
    } else if (outside > PANEL_MAX_OUTSIDE_FRACTION) {
      warnings.push(`${pct(outside)} of the target mask lies outside the panel; check the panel bounds and target ids.`);
    }
  }

  return {
    panelAreaPx: panel.areaPx,
    coveredAreaPx: covered,
    fraction: round(fraction, 4),
    clipped: panel.clipped,
    warnings,
  };
}

function columnsPanel(spec: Extract<PanelSpec, { kind: "columns" }>, width: number, height: number): Panel {
  const n = width * height;
  if (spec.left.length !== n || spec.right.length !== n) throw new PanelError("Column mask size does not match the photo.");
  const top = Math.round(spec.topY);
  const bottom = Math.round(spec.bottomY);
  if (bottom <= top) throw new PanelError(`bottom_y (${spec.bottomY}) must be greater than top_y (${spec.topY}).`);

  const warnings: string[] = [];
  const clipped = top < 0 || bottom > height;
  const y0 = clamp(top, 0, height);
  const y1 = clamp(bottom, 0, height);
  if (y1 <= y0) throw new PanelError("The top_y..bottom_y range is outside the image.");

  let left = spec.left;
  let right = spec.right;
  const lx = meanX(left, width);
  const rx = meanX(right, width);
  if (lx == null || rx == null) throw new PanelError("A column mask is empty.");
  if (lx > rx) {
    [left, right] = [right, left];
    warnings.push("left_column_id is to the right of right_column_id; they were swapped.");
  }

  // Fallback edges for rows a column mask doesn't reach (e.g. the panel extends above a short mask).
  const leftInnerAll = maxXOverall(left, width) + 1;
  const rightInnerAll = minXOverall(right, width);

  const region = new Uint8Array(n);
  let area = 0;
  const leftEdge: Point[] = [];
  const rightEdge: Point[] = [];
  const step = Math.max(1, Math.floor((y1 - y0) / 20));
  for (let y = y0; y < y1; y++) {
    const lMax = rowMaxX(left, width, y);
    const rMin = rowMinX(right, width, y);
    const le = lMax >= 0 ? lMax + 1 : leftInnerAll;
    const re = rMin >= 0 ? rMin : rightInnerAll;
    for (let x = le; x < re; x++) region[y * width + x] = 1;
    if (re > le) area += re - le;
    if ((y - y0) % step === 0 || y === y1 - 1) {
      leftEdge.push([le, y]);
      rightEdge.push([re, y + 1]);
    }
  }
  if (area === 0) throw new PanelError("There is no space between the inner edges of the two columns in that y range.");

  return { region, width, height, areaPx: area, clipped, outline: [...leftEdge, ...rightEdge.reverse()], warnings };
}

function polygonPanel(raw: Point[], width: number, height: number): Panel {
  if (raw.length !== 4) throw new PanelError("polygon must have exactly 4 points.");
  const warnings: string[] = [];
  const clipped = raw.some(([x, y]) => x < 0 || y < 0 || x > width || y > height);

  // Models often list corners in a crossing order; sort around the centroid into a simple quadrilateral.
  const cx = raw.reduce((s, p) => s + p[0], 0) / 4;
  const cy = raw.reduce((s, p) => s + p[1], 0) / 4;
  const points = [...raw].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  if (Math.abs(shoelace(raw)) + 1e-6 < Math.abs(shoelace(points))) {
    warnings.push("polygon corners crossed over; they were reordered into a simple quadrilateral.");
  }
  if (Math.abs(shoelace(points)) < 1) throw new PanelError("polygon has no area.");

  const region = new Uint8Array(width * height);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const xMin = clamp(Math.floor(Math.min(...xs)), 0, width);
  const xMax = clamp(Math.ceil(Math.max(...xs)), 0, width);
  const yMin = clamp(Math.floor(Math.min(...ys)), 0, height);
  const yMax = clamp(Math.ceil(Math.max(...ys)), 0, height);
  let area = 0;
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      if (insidePolygon(x + 0.5, y + 0.5, points)) {
        region[y * width + x] = 1;
        area++;
      }
    }
  }
  if (area === 0) throw new PanelError("The polygon does not cover any pixel of the image.");
  return { region, width, height, areaPx: area, clipped, outline: points, warnings };
}

/** Even-odd ray cast. */
function insidePolygon(px: number, py: number, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function shoelace(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function rowMaxX(m: Uint8Array, w: number, y: number): number {
  for (let x = w - 1; x >= 0; x--) if (m[y * w + x]) return x;
  return -1;
}
function rowMinX(m: Uint8Array, w: number, y: number): number {
  for (let x = 0; x < w; x++) if (m[y * w + x]) return x;
  return -1;
}
function maxXOverall(m: Uint8Array, w: number): number {
  let best = -1;
  for (let i = 0; i < m.length; i++) if (m[i] && i % w > best) best = i % w;
  return best;
}
function minXOverall(m: Uint8Array, w: number): number {
  let best = w;
  for (let i = 0; i < m.length; i++) if (m[i] && i % w < best) best = i % w;
  return best;
}
function meanX(m: Uint8Array, w: number): number | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i]) {
      sum += i % w;
      count++;
    }
  }
  return count ? sum / count : null;
}
function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
function pct(f: number) {
  return `${Math.round(f * 100)}%`;
}
