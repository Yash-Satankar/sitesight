/**
 * Panel-relative measurement on synthetic masks (pure code, no DB or model).
 * Image 100×80. Columns at x 10..19 and 70..79, so a column panel spans x [20, 70) — 50 px wide.
 */
import { describe, expect, it } from "vitest";
import { buildPanel, measurePanel, PanelError, type Point } from "../src/services/measure.js";

const W = 100;
const H = 80;

/** Filled rectangle as a full-frame raster. */
function rect(x: number, y: number, w: number, h: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && xx < W && yy >= 0 && yy < H) m[yy * W + xx] = 255;
  return m;
}
const union = (...ms: Uint8Array[]) => ms.reduce((acc, m) => acc.map((v, i) => (v || m[i] ? 255 : 0)), new Uint8Array(W * H));

const LEFT = rect(10, 0, 10, H);
const RIGHT = rect(70, 0, 10, H);
const columns = (topY = 10, bottomY = 70, left = LEFT, right = RIGHT) => buildPanel({ kind: "columns", left, right, topY, bottomY }, W, H);
const SQUARE: Point[] = [[20, 10], [70, 10], [70, 70], [20, 70]];

describe("panel measurement", () => {
  it("full panel → fraction 1.0 (and a 'drawn too small' warning)", () => {
    const panel = columns();
    expect(panel.areaPx).toBe(50 * 60);
    const m = measurePanel([rect(20, 10, 50, 60)], panel);
    expect(m).toMatchObject({ panelAreaPx: 3000, coveredAreaPx: 3000, fraction: 1, clipped: false });
    expect(m.warnings.join(" ")).toMatch(/fills 100% of the panel; the panel is probably drawn too small/);
    expect(m.warnings.join(" ")).not.toMatch(/outside the panel/);
  });

  it("half-filled panel → ~0.5, no warnings", () => {
    const m = measurePanel([rect(20, 40, 50, 30)], columns());
    expect(m.fraction).toBeCloseTo(0.5, 3);
    expect(m.warnings).toEqual([]);
  });

  it("uses the union of several target masks (overlap counted once)", () => {
    const m = measurePanel([rect(20, 10, 30, 60), rect(40, 10, 30, 60)], columns()); // overlap at x 40..49
    expect(m.coveredAreaPx).toBe(3000);
  });

  it("target outside the panel → 0 with a warning", () => {
    const m = measurePanel([rect(0, 72, W, 8)], columns()); // below bottom_y
    expect(m.fraction).toBe(0);
    expect(m.coveredAreaPx).toBe(0);
    expect(m.warnings.join(" ")).toMatch(/None of the target mask is inside the panel/);
  });

  it("warns when much of the target lies outside the panel", () => {
    const m = measurePanel([rect(20, 40, 80, 30)], columns()); // 1500 inside, 900 outside (37.5%)
    expect(m.fraction).toBeCloseTo(0.5, 3);
    expect(m.warnings.join(" ")).toMatch(/38% of the target mask lies outside the panel/);
  });

  it("polygon mode matches column mode for an axis-aligned rectangle", () => {
    const byColumns = columns();
    const byPolygon = buildPanel({ kind: "polygon", points: SQUARE }, W, H);
    expect(byPolygon.areaPx).toBe(byColumns.areaPx);
    expect(Buffer.from(byPolygon.region).equals(Buffer.from(byColumns.region))).toBe(true);

    for (const target of [rect(20, 40, 50, 30), rect(0, 0, 45, H), union(rect(25, 15, 10, 10), rect(60, 60, 30, 20))]) {
      expect(measurePanel([target], byPolygon)).toEqual(measurePanel([target], byColumns));
    }
  });

  it("counts a pixel when its centre is inside the polygon", () => {
    // Edges at x = 20.75 and 70.25: centres 21.5 … 69.5 are inside → 49 columns (corner sampling would give 21 … 70 = 50).
    const panel = buildPanel({ kind: "polygon", points: [[20.75, 10], [70.25, 10], [70.25, 70], [20.75, 70]] }, W, H);
    expect(panel.areaPx).toBe(49 * 60);
  });

  it("reorders crossed polygon corners into the same quadrilateral, with a warning", () => {
    const crossed: Point[] = [[20, 10], [70, 70], [70, 10], [20, 70]];
    const panel = buildPanel({ kind: "polygon", points: crossed }, W, H);
    expect(panel.areaPx).toBe(3000);
    expect(panel.warnings.join(" ")).toMatch(/reordered/);
  });

  it("follows each row's inner column edge for slanted columns", () => {
    // Left column leans right: its inner edge is at x = 20 + floor(y / 10).
    const slanted = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 10; x < 20 + Math.floor(y / 10); x++) slanted[y * W + x] = 255;
    const panel = columns(10, 70, slanted);
    let expected = 0;
    for (let y = 10; y < 70; y++) expected += 70 - (20 + Math.floor(y / 10));
    expect(panel.areaPx).toBe(expected);
  });

  it("flags a tiny panel, clipping at the image edge and swapped columns", () => {
    const tiny = measurePanel([rect(20, 10, 10, 2)], buildPanel({ kind: "polygon", points: [[20, 10], [30, 10], [30, 12], [20, 12]] }, W, H));
    expect(tiny.warnings.join(" ")).toMatch(/Panel covers only 0% of the image/);

    const clipped = columns(-20, 70);
    expect(clipped.clipped).toBe(true);
    expect(clipped.areaPx).toBe(50 * 70);

    const swapped = columns(10, 70, RIGHT, LEFT);
    expect(swapped.areaPx).toBe(3000);
    expect(swapped.warnings.join(" ")).toMatch(/swapped/);
  });

  it("rejects impossible panels with a readable error", () => {
    expect(() => columns(70, 10)).toThrow(PanelError);
    expect(() => columns(70, 10)).toThrow(/bottom_y .* must be greater than top_y/);
    expect(() => buildPanel({ kind: "polygon", points: [[0, 0], [10, 10], [20, 20], [30, 30]] }, W, H)).toThrow(/no area/);
    expect(() => columns(10, 70, rect(10, 0, 70, H), RIGHT)).toThrow(/no space between the inner edges/);
  });
});
