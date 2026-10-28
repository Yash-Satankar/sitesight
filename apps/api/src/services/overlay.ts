import sharp from "sharp";

export interface OverlayMask {
  mask: Buffer; // single-channel PNG, any size (resized to the image)
  bbox: [number, number, number, number];
  label: string;
}

const PALETTE: [number, number, number][] = [
  [230, 57, 70],
  [42, 157, 143],
  [244, 162, 97],
  [69, 123, 157],
  [155, 93, 229],
  [233, 196, 106],
];

/** Draw semi-transparent coloured masks and numbered labels onto a (normalised) JPEG. */
export async function drawMasks(image: Buffer, masks: OverlayMask[]): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const layers: sharp.OverlayOptions[] = [];
  for (const [i, m] of masks.entries()) {
    const [r, g, b] = PALETTE[i % PALETTE.length]!;
    const alpha = await sharp(m.mask)
      .resize(width, height, { fit: "fill" })
      .greyscale()
      .linear(0.45, 0) // ~45% opacity where the mask is white
      .raw()
      .toBuffer();
    const tinted = await sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
      .joinChannel(alpha, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
    layers.push({ input: tinted, top: 0, left: 0 });
  }

  const labels = masks
    .map((m, i) => {
      const [r, g, b] = PALETTE[i % PALETTE.length]!;
      const [x, y] = m.bbox;
      const text = escapeXml(m.label);
      const ty = Math.max(18, y);
      return `<rect x="${x}" y="${ty - 18}" width="${text.length * 9 + 10}" height="22" fill="rgb(${r},${g},${b})"/>
<text x="${x + 5}" y="${ty - 2}" font-family="sans-serif" font-size="15" font-weight="bold" fill="#fff">${text}</text>`;
    })
    .join("\n");
  layers.push({
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`),
    top: 0,
    left: 0,
  });

  return sharp(image).composite(layers).jpeg({ quality: 85 }).toBuffer();
}

/** Outline a polygon (e.g. a measurement panel) with a translucent fill and a label at its first point. */
export async function drawPolygon(image: Buffer, points: [number, number][], label: string): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const pts = points.map(([x, y]) => `${x},${y}`).join(" ");
  const [lx, ly] = points[0] ?? [0, 0];
  const text = escapeXml(label);
  const ty = Math.max(18, ly);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<polygon points="${pts}" fill="rgba(255,214,0,0.18)" stroke="#ffd600" stroke-width="4" stroke-linejoin="round"/>
<rect x="${lx}" y="${ty - 18}" width="${text.length * 9 + 10}" height="22" fill="#ffd600"/>
<text x="${lx + 5}" y="${ty - 2}" font-family="sans-serif" font-size="15" font-weight="bold" fill="#000">${text}</text>
</svg>`;
  return sharp(image)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Crop a bbox (with padding) for report evidence thumbnails. */
export async function cropEvidence(image: Buffer, bbox: [number, number, number, number], pad = 0.15): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const [x, y, w, h] = bbox;
  const px = Math.round(w * pad);
  const py = Math.round(h * pad);
  const left = Math.max(0, Math.round(x - px));
  const top = Math.max(0, Math.round(y - py));
  return sharp(image)
    .extract({
      left,
      top,
      width: Math.max(1, Math.min(W - left, Math.round(w + 2 * px))),
      height: Math.max(1, Math.min(H - top, Math.round(h + 2 * py))),
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
