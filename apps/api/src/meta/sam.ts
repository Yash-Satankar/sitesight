import {
  decodeMaskToRaster,
  formats,
  recordsOfKind,
  type ImageSegmentationResult,
  type SegmentationMaskRecord,
} from "@meta-sam/parser";
import sharp from "sharp";
import { env } from "../config.js";
import { metaClient } from "./client.js";
import type { SparkInputItem } from "./spark.js";
import { rasterToFrameMask } from "./masks.js";
import { withRetry } from "./retry.js";

export interface Segment {
  concept: string;
  instanceIdx: number;
  /** Single-channel PNG mask, same size as the input image. */
  mask: Buffer;
  /** [x, y, w, h] in pixels of the input image. */
  bbox: [number, number, number, number];
  areaPx: number;
  score: number;
}

/**
 * Segment every instance of each concept in the image with SAM 3.1.
 * SAM takes one concept per request (no multi-concept syntax), so this makes one call per concept.
 * Caching by (photo_id, concept), including empty results, lives in agent/tools.ts (segment_queries).
 */
export async function segment(image: Buffer, concepts: string[]): Promise<Segment[]> {
  const { width = 0, height = 0, format } = await sharp(image).metadata();
  const dataUrl = `data:image/${format === "png" ? "png" : "jpeg"};base64,${image.toString("base64")}`;
  const results: Segment[] = [];
  for (const concept of concepts) {
    const outputText = await callSam(dataUrl, concept);
    results.push(...(await parseSamOutput(outputText, concept, width, height)));
  }
  return results;
}

/**
 * One SAM 3.1 request over the Responses API (https://dev.meta.ai/docs/sam/segmenting):
 * model "sam-3.1", one input_text concept + one input_image, non-streaming.
 * Output is special-token text, one record per instance:
 *   <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;x=0;y=0;c=..;data=H,W,~payload|>,1<|box…
 * Box corners are inclusive source pixels; the H×W mask covers just that box.
 * Parsed with Meta's official @meta-sam/parser. Zero matches = empty output_text, a valid result.
 */
async function callSam(dataUrl: string, concept: string): Promise<string> {
  return withRetry(
    async () => {
      const resp = await metaClient().responses.create(
        {
          model: env.SAM_MODEL,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: concept },
                // The SAM docs send image_url only; `detail` is a Spark/vision option, so it's omitted here.
                { type: "input_image", image_url: dataUrl } as unknown as { type: "input_image"; detail: "auto" },
              ],
            },
          ] satisfies SparkInputItem[],
          metadata: { include_confidence: "true" },
        },
        // withRetry owns retries for this call (429/5xx with backoff); 400s are permanent and not retried.
        { maxRetries: 0 },
      );
      const refusal = resp.output
        .flatMap((o) => (o.type === "message" ? o.content : []))
        .find((c) => c.type === "refusal");
      if (refusal) throw new Error(`SAM refused "${concept}": ${refusal.refusal}`);
      return resp.output_text ?? "";
    },
    { label: `sam "${concept}"` },
  );
}

/** Parse SAM special-token text into Segments. Exported for tests and the spike script. */
export async function parseSamOutput(outputText: string, concept: string, width: number, height: number): Promise<Segment[]> {
  if (!outputText.trim()) return [];

  const parser = formats.segmentation.image().createParser();
  parser.push(outputText.endsWith("\n") ? outputText : `${outputText}\n`, { emit: false });
  const { result } = parser.finish({ status: "completed" }) as { result: ImageSegmentationResult };

  const errors = result.diagnostics.filter((d) => d.severity === "error");
  for (const d of result.diagnostics) console.warn(`[sam] ${d.severity} ${d.code}: ${d.message}`);

  const boxes = new Map(recordsOfKind(result.records, "box").map((b) => [b.objectId, b]));
  const masks = latestMaskPerObject(recordsOfKind(result.records, "mask"));
  if (!masks.length && errors.length) {
    throw new Error(`Could not parse SAM output for "${concept}": ${errors.map((e) => e.message).join("; ")}`);
  }

  const segments: Segment[] = [];
  for (const rec of masks) {
    const raster = decodeMaskToRaster(rec.mask);
    const frame = await rasterToFrameMask(raster, rec.mask.width, rec.mask.height, rec.bounds.left, rec.bounds.top, width, height);
    if (frame.areaPx === 0) continue;
    segments.push({
      concept,
      instanceIdx: segments.length,
      mask: frame.png,
      bbox: frame.bbox,
      areaPx: frame.areaPx,
      // Confidence is requested via include_confidence; 0 only if the API still omits it.
      score: rec.confidence ?? boxes.get(rec.objectId)?.confidence ?? 0,
    });
  }
  return segments;
}

/** A single image is one frame, but keep only the newest mask revision per object to be safe. */
function latestMaskPerObject(records: readonly SegmentationMaskRecord[]): SegmentationMaskRecord[] {
  const byObject = new Map<string, SegmentationMaskRecord>();
  for (const r of records) {
    const prev = byObject.get(r.objectId);
    if (!prev || r.revision >= prev.revision) byObject.set(r.objectId, r);
  }
  return [...byObject.values()].sort((a, b) => a.order - b.order);
}
