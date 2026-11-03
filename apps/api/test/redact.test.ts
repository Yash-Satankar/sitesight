import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { findTitleBlocks, redactTitleBlocks, viewKeyOf } from "../src/services/drawings/redact.js";

/** A white sheet with a double frame, optional title-block divider, some "drawing" and some "text" ink. */
async function sheet(w: number, h: number, opts: { strip?: number; band?: number; offset?: { x: number; y: number; w: number; h: number } } = {}) {
  const f = opts.offset ?? { x: 40, y: 40, w: w - 80, h: h - 80 };
  const rect = (x: number, y: number, rw: number, rh: number) => `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="none" stroke="#000" stroke-width="3"/>`;
  const parts = [rect(f.x, f.y, f.w, f.h), rect(f.x + 12, f.y + 12, f.w - 24, f.h - 24)];
  // Drawing content: a dashed grid line (must not count as a divider) and a box.
  parts.push(`<line x1="${f.x + f.w * 0.7}" y1="${f.y + 20}" x2="${f.x + f.w * 0.7}" y2="${f.y + f.h - 20}" stroke="#000" stroke-width="2" stroke-dasharray="30 12"/>`);
  parts.push(rect(f.x + 80, f.y + 80, f.w * 0.3, f.h * 0.3));
  if (opts.strip) parts.push(`<line x1="${opts.strip}" y1="${f.y + 12}" x2="${opts.strip}" y2="${f.y + f.h - 12}" stroke="#000" stroke-width="2"/>`);
  if (opts.band) parts.push(`<line x1="${f.x + 12}" y1="${opts.band}" x2="${f.x + f.w - 12}" y2="${opts.band}" stroke="#000" stroke-width="2"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}<text x="${w - 200}" y="${h - 60}" font-size="40" fill="#e00">MR. CLIENT</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("title-block redaction", () => {
  it("finds a right-hand title strip on a landscape sheet, ignoring dashed grid lines", async () => {
    const { regions, detected } = await findTitleBlocks(await sheet(2000, 1414, { strip: 1660 }));
    expect(detected).toBe(true);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.left).toBeGreaterThan(1640);
    expect(regions[0]!.left).toBeLessThanOrEqual(1660);
    expect(regions[0]).toMatchObject({ top: 0, width: 2000 - regions[0]!.left, height: 1414 });
  });

  it("finds a bottom title band on a portrait sheet", async () => {
    const { regions, detected } = await findTitleBlocks(await sheet(1414, 2000, { band: 1400 }));
    expect(detected).toBe(true);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.top).toBeGreaterThan(1380);
    expect(regions[0]!.top).toBeLessThanOrEqual(1400);
    expect(regions[0]).toMatchObject({ left: 0, width: 1414 });
  });

  it("measures lines against the sheet frame when the sheet doesn't fill the page", async () => {
    // Frame covers only y 300..1650 of a 2000 px page; the divider is 1,326 px long (66 % of the page height).
    const png = await sheet(1414, 2000, { offset: { x: 30, y: 300, w: 1150, h: 1350 }, strip: 900 });
    const { regions, detected } = await findTitleBlocks(png);
    expect(detected).toBe(true);
    expect(regions[0]!.left).toBeGreaterThan(880);
    expect(regions[0]!.left).toBeLessThanOrEqual(900);
  });

  it("blurs both likely areas when no divider is found", async () => {
    const { regions, detected } = await findTitleBlocks(await sheet(2000, 1414));
    expect(detected).toBe(false);
    expect(regions).toEqual([
      { left: 1500, top: 0, width: 500, height: 1414 },
      { left: 0, top: 962, width: 2000, height: 452 },
    ]);
  });

  it("changes the title block and leaves the drawing untouched", async () => {
    const png = await sheet(2000, 1414, { strip: 1660 });
    const out = await redactTitleBlocks(png);
    const crop = async (b: Buffer, left: number) => sharp(b).extract({ left, top: 1300, width: 200, height: 80 }).raw().toBuffer();
    expect((await crop(out.png, 1790)).equals(await crop(png, 1790))).toBe(false); // the "MR. CLIENT" text
    const drawing = async (b: Buffer) => sharp(b).extract({ left: 100, top: 100, width: 700, height: 500 }).raw().toBuffer();
    expect((await drawing(out.png)).equals(await drawing(png))).toBe(true);
    const meta = await sharp(out.png).metadata();
    expect([meta.width, meta.height]).toEqual([2000, 1414]);
  });

  it("keeps the display copy next to the original", () => {
    expect(viewKeyOf("projects/3/drawings/2/abc.png")).toBe("projects/3/drawings/2/abc.view.png");
  });
});
