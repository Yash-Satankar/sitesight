import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import type { PanelSpecArg } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { maskLabel, resolvePanel } from "../agent/tools.js";
import { loadNormalizedPhoto } from "./images.js";
import { drawMasks, drawPolygon } from "./overlay.js";
import { getObject } from "./storage.js";

export interface OverlayOptions {
  /** Segments to draw; default: the photo's kept (verified) segments. Rejected segments are never drawn. */
  segmentIds?: number[];
  /** Panel measurements of this photo to outline. */
  panelIds?: number[];
  /** Long edge of the returned image in px (clamped 160–1600). */
  maxEdge?: number;
}

/** The evidence photo with masks and measured panels drawn on it, as a PNG (for the review screen and live trace). */
export async function renderOverlay(photoId: number, opts: OverlayOptions = {}): Promise<Buffer> {
  const [photo] = await db.select().from(schema.photos).where(eq(schema.photos.id, photoId));
  if (!photo) throw new HttpError(404, "Photo not found");

  let segs;
  if (opts.segmentIds?.length) {
    segs = await db
      .select()
      .from(schema.segments)
      .where(and(eq(schema.segments.photoId, photo.id), inArray(schema.segments.id, opts.segmentIds)));
    const found = new Set(segs.map((s) => s.id));
    const foreign = opts.segmentIds.filter((id) => !found.has(id));
    if (foreign.length) throw new HttpError(400, `Segments ${foreign.join(", ")} are not on photo ${photo.id}`);
  } else {
    segs = await db
      .select()
      .from(schema.segments)
      .where(and(eq(schema.segments.photoId, photo.id), eq(schema.segments.verified, true)));
  }
  segs = segs.filter((s) => s.verified !== false).sort((a, b) => a.id - b.id); // rejected segments stay hidden

  const panels = opts.panelIds?.length
    ? await db
        .select()
        .from(schema.panelMeasurements)
        .where(and(eq(schema.panelMeasurements.photoId, photo.id), inArray(schema.panelMeasurements.id, opts.panelIds)))
    : [];
  if (opts.panelIds?.length && panels.length !== new Set(opts.panelIds).size) {
    throw new HttpError(400, `Panel measurements ${opts.panelIds.join(", ")} are not all on photo ${photo.id}`);
  }

  const img = await loadNormalizedPhoto(photo.storageKey);
  let buffer = img.buffer;
  if (segs.length) {
    const masks = await Promise.all(segs.map(async (s) => ({ mask: await getObject(s.maskKey), bbox: s.bbox, label: maskLabel(s) })));
    buffer = await drawMasks(buffer, masks);
  }
  for (const pm of panels) {
    try {
      const { panel } = await resolvePanel(photo, pm.panel as PanelSpecArg);
      buffer = await drawPolygon(buffer, panel.outline, `PANEL ${Math.round(pm.fraction * 100)}%`);
    } catch {
      // The panel's columns may have been re-verified since; the masks are still worth showing.
    }
  }

  const edge = Math.min(1600, Math.max(160, Math.round(opts.maxEdge ?? 1024)));
  return sharp(buffer).resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 8 }).toBuffer();
}

/** "1,2,3" → [1, 2, 3]; empty → undefined. */
export function idList(raw: unknown, name: string): number[] | undefined {
  if (raw == null || raw === "") return undefined;
  const ids = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, `${name} must be a comma-separated list of ids`);
  return ids;
}
