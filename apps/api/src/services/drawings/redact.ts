/**
 * Title blocks of client drawings (client name, address, phone) are blurred in every image we serve: the page viewer
 * and thumbnails get a redacted copy; the original page stays private on storage for the model to read.
 *
 * Detection: a title block is fenced off by a long, solid ruled line inside the sheet frame: a vertical line in the
 * right part of the sheet (title strip) or a horizontal line in the lower part (title band). Dashed grid lines and
 * drawing content don't make an unbroken line that long. When neither is found, both likely areas are blurred.
 */
import sharp from "sharp";

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DARK = 140; // grey level below which a pixel counts as ink
const MIN_RUN = 0.8; // an unbroken run this share of the frame's height/width makes a ruled line
const FALLBACK = { right: 0.25, bottom: 0.32 };

/** The display copy's key next to the original page: projects/3/drawings/2/abc.png → projects/3/drawings/2/abc.view.png */
export function viewKeyOf(storageKey: string): string {
  return storageKey.replace(/(\.png)?$/i, ".view.png");
}

function longestRun(get: (i: number) => boolean, from: number, to: number): number {
  let best = 0;
  let run = 0;
  for (let i = from; i < to; i++) {
    run = get(i) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Title-block areas of a rendered page, in pixels. */
export async function findTitleBlocks(png: Buffer): Promise<{ regions: Region[]; detected: boolean }> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ink = (x: number, y: number) => data[y * W + x]! < DARK;
  // A ruled line may be 1-3 px wide and slightly off-axis after rasterising: accept ink in the pixel or a neighbour.
  const inkV = (x: number, y: number) => ink(x, y) || (x > 0 && ink(x - 1, y)) || (x + 1 < W && ink(x + 1, y));
  const inkH = (x: number, y: number) => ink(x, y) || (y > 0 && ink(x, y - 1)) || (y + 1 < H && ink(x, y + 1));

  // The sheet frame: outermost long ruled lines. Sheets don't always fill the page (scanned / placed off-centre).
  const colLine = (x: number, need: number) => longestRun((y) => inkV(x, y), 0, H) >= need;
  const rowLine = (y: number, need: number) => longestRun((x) => inkH(x, y), 0, W) >= need;
  let fx0 = 0;
  let fx1 = W - 1;
  let fy0 = 0;
  let fy1 = H - 1;
  for (let x = 0; x < W / 2; x++) if (colLine(x, H * 0.4)) { fx0 = x; break; }
  for (let x = W - 1; x > W / 2; x--) if (colLine(x, H * 0.4)) { fx1 = x; break; }
  for (let y = 0; y < H / 2; y++) if (rowLine(y, W * 0.4)) { fy0 = y; break; }
  for (let y = H - 1; y > H / 2; y--) if (rowLine(y, W * 0.4)) { fy1 = y; break; }
  const FW = fx1 - fx0;
  const FH = fy1 - fy0;
  const runV = (x: number) => longestRun((y) => inkV(x, y), fy0, fy1 + 1);
  const runH = (y: number) => longestRun((x) => inkH(x, y), fx0, fx1 + 1);

  // Title strip: the leftmost long vertical line in the right part of the frame (the frame's own double border is
  // excluded). Only if there is none, a title band: the topmost long horizontal line in the lower part.
  for (let x = Math.floor(fx0 + FW * 0.6); x < Math.floor(fx1 - FW * 0.04); x++) {
    if (runV(x) >= FH * MIN_RUN) {
      const left = Math.max(0, x - Math.round(W * 0.004));
      return { regions: [{ left, top: 0, width: W - left, height: H }], detected: true };
    }
  }
  for (let y = Math.floor(fy0 + FH * 0.55); y < Math.floor(fy1 - FH * 0.04); y++) {
    if (runH(y) >= FW * MIN_RUN) {
      const top = Math.max(0, y - Math.round(H * 0.004));
      return { regions: [{ left: 0, top, width: W, height: H - top }], detected: true };
    }
  }
  const left = Math.round(W * (1 - FALLBACK.right));
  const top = Math.round(H * (1 - FALLBACK.bottom));
  return {
    regions: [
      { left, top: 0, width: W - left, height: H },
      { left: 0, top, width: W, height: H - top },
    ],
    detected: false,
  };
}

/** Pixelate then blur each region so no text survives (a plain blur of large red text can stay readable). */
export async function redactTitleBlocks(png: Buffer): Promise<{ png: Buffer; regions: Region[]; detected: boolean }> {
  const { regions, detected } = await findTitleBlocks(png);
  const overlays = await Promise.all(
    regions.map(async (r) => {
      const small = await sharp(png)
        .extract(r)
        .resize({ width: Math.max(1, Math.round(r.width / 24)), height: Math.max(1, Math.round(r.height / 24)), fit: "fill" })
        .toBuffer();
      const input = await sharp(small).resize({ width: r.width, height: r.height, fit: "fill", kernel: "nearest" }).blur(6).png().toBuffer();
      return { input, left: r.left, top: r.top };
    }),
  );
  return { png: await sharp(png).composite(overlays).png().toBuffer(), regions, detected };
}
