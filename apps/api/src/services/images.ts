import sharp from "sharp";
import { env } from "../config.js";
import { getObject } from "./storage.js";

export interface NormalizedImage {
  buffer: Buffer; // JPEG
  width: number;
  height: number;
}

/**
 * EXIF-rotate and shrink to MAX_IMAGE_EDGE_PX. SAM, overlays and Spark all use this
 * one coordinate space, so masks line up with what the model sees.
 */
export async function normalize(input: Buffer): Promise<NormalizedImage> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: env.MAX_IMAGE_EDGE_PX, height: env.MAX_IMAGE_EDGE_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export async function loadNormalizedPhoto(storageKey: string): Promise<NormalizedImage> {
  return normalize(await getObject(storageKey));
}

export function toDataUrl(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
