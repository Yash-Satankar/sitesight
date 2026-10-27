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
