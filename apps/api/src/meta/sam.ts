import { env } from "../config.js";
import { metaClient } from "./client.js";

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
 *
 * TODO(day 1): the SAM 3.1 request/response shape on the Meta Model API is unverified.
 * Confirm it from the docs with scripts/sam-spike.ts, then fill in `callSam`.
 * Keep this function's signature stable no matter what the wire format turns out to be.
 * Caching by (photo_id, concept) happens in agent/tools.ts, not here.
 */
export async function segment(image: Buffer, concepts: string[]): Promise<Segment[]> {
  const results: Segment[] = [];
  for (const concept of concepts) {
    results.push(...(await callSam(image, concept)));
  }
  return results;
}

async function callSam(image: Buffer, concept: string): Promise<Segment[]> {
  const client = metaClient();
  void client;
  void image;
  void env.SAM_MODEL;
  throw new Error(
    `sam.segment("${concept}") is not wired yet: confirm the SAM 3.1 API shape and implement callSam in meta/sam.ts`,
  );
}
