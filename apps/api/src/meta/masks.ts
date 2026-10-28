import sharp from "sharp";

// SAM 3.1 masks arrive cropped to their box (see meta/sam.ts). We store full-frame masks:
// a single-channel PNG (0 = background, 255 = object) the same size as the input image,
// so overlays and area maths work in one coordinate space.

export type BBox = [number, number, number, number]; // x, y, w, h

export interface FrameMask {
  png: Buffer;
  bbox: BBox; // tight bbox of the mask pixels
  areaPx: number;
}

/** Intersection-over-union of two full-frame masks. Boxes that don't overlap short-circuit to 0. */
export async function maskIoU(
  a: { mask: Buffer; bbox: BBox },
  b: { mask: Buffer; bbox: BBox },
  cache = new Map<Buffer, Uint8Array>(),
): Promise<number> {
  if (!bboxesOverlap(a.bbox, b.bbox)) return 0;
  const [pa, pb] = await Promise.all([rawPixels(a.mask, cache), rawPixels(b.mask, cache)]);
  if (pa.length !== pb.length) throw new Error("maskIoU: masks are different sizes");
  let inter = 0;
  let union = 0;
  for (let i = 0; i < pa.length; i++) {
    const x = pa[i]! > 0;
    const y = pb[i]! > 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : 0;
}

/**
 * Collapse duplicate instances: when two masks overlap with IoU > threshold, keep the higher-scoring one.
 * Used to merge results from several prompt variants for the same target. Returns survivors by score, highest first.
 */
export async function mergeOverlapping<T extends { mask: Buffer; bbox: BBox; score: number }>(
  items: T[],
  threshold: number,
): Promise<T[]> {
  const cache = new Map<Buffer, Uint8Array>();
  const kept: T[] = [];
  for (const candidate of [...items].sort((x, y) => y.score - x.score)) {
    let duplicate = false;
    for (const k of kept) {
      if ((await maskIoU(candidate, k, cache)) > threshold) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

function bboxesOverlap([ax, ay, aw, ah]: BBox, [bx, by, bw, bh]: BBox): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** Decode a stored single-channel mask PNG to row-major pixels (0 / 255). */
export function decodeMask(png: Buffer): Promise<Uint8Array> {
  return rawPixels(png, new Map());
}

async function rawPixels(png: Buffer, cache: Map<Buffer, Uint8Array>): Promise<Uint8Array> {
  let px = cache.get(png);
  if (!px) {
    const buf = await sharp(png).extractChannel(0).raw().toBuffer();
    px = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    cache.set(png, px);
  }
  return px;
}

/**
 * Paste a box-local raster (row-major 0/1, rasterWidth × rasterHeight) into a frameWidth × frameHeight
 * canvas at (left, top). Pixels outside the frame are clipped.
 */
export async function rasterToFrameMask(
  raster: Uint8Array,
  rasterWidth: number,
  rasterHeight: number,
  left: number,
  top: number,
  frameWidth: number,
  frameHeight: number,
): Promise<FrameMask> {
  const px = new Uint8Array(frameWidth * frameHeight);
  let minX = frameWidth, minY = frameHeight, maxX = -1, maxY = -1, area = 0;

  for (let ry = 0; ry < rasterHeight; ry++) {
    const y = top + ry;
    if (y < 0 || y >= frameHeight) continue;
    for (let rx = 0; rx < rasterWidth; rx++) {
      if (!raster[ry * rasterWidth + rx]) continue;
      const x = left + rx;
      if (x < 0 || x >= frameWidth) continue;
      px[y * frameWidth + x] = 255;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const bbox: BBox = area ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : [0, 0, 0, 0];
  const png = await sharp(Buffer.from(px), { raw: { width: frameWidth, height: frameHeight, channels: 1 } })
    .toColourspace("b-w")
    .png()
    .toBuffer();
  return { png, bbox, areaPx: area };
}
