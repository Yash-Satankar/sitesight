/**
 * segment() runs per-concept SAM requests up to SAM_CONCURRENCY at a time, returns results in concept
 * order, and stops starting new requests after a failure. No runId here, so no budget or database.
 * The SAM response is the real sample output from @meta-sam/parser's README (2 instances, 320×334 frame).
 */
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/meta/client.js", () => ({ metaClient: () => ({ responses: { create } }) }));

import { env } from "../src/config.js";
import { segment } from "../src/meta/sam.js";
import { createLimiter } from "../src/lib/limit.js";

const SAM_OUTPUT =
  '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.9|>' +
  "<|mask;x=0;y=0;c=0.9;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ',1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334;c=0.8|>' +
  '<|mask;x=0;y=0;c=0.8;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n';

const CONCEPTS = ["concrete column", "brick wall", "concrete slab", "steel rebar", "measuring tape"];
const conceptOf = (body: { input: { content: { text?: string }[] }[] }) => body.input[0]!.content[0]!.text!;
const image = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#888" } }).jpeg().toBuffer();

let inFlight = 0;
let maxInFlight = 0;
beforeEach(() => {
  create.mockReset();
  inFlight = 0;
  maxInFlight = 0;
});

/** SAM mock: later concepts answer faster, so completion order is the reverse of concept order. */
function slowSam(failConcept?: string) {
  return async (body: Parameters<typeof conceptOf>[0]) => {
    const concept = conceptOf(body);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (concept === failConcept) throw Object.assign(new Error("bad prompt"), { status: 400 });
      await new Promise((r) => setTimeout(r, 60 - CONCEPTS.indexOf(concept) * 10));
      return { id: "sam", output: [], output_text: SAM_OUTPUT, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    } finally {
      inFlight--;
    }
  };
}

describe("segment() concurrency", () => {
  it(`runs at most SAM_CONCURRENCY (${env.SAM_CONCURRENCY}) requests at once and keeps concept order`, async () => {
    create.mockImplementation(slowSam());

    const segs = await segment(image, CONCEPTS);

    expect(create).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(env.SAM_CONCURRENCY);
    // 2 instances per concept, grouped in input order despite reverse completion order.
    expect(segs.map((s) => `${s.concept}#${s.instanceIdx}`)).toEqual(CONCEPTS.flatMap((c) => [`${c}#0`, `${c}#1`]));
  });

  it("stops starting new requests after one fails, and throws that error", async () => {
    create.mockImplementation(slowSam("brick wall")); // fails immediately with a 400 (not retried)

    await expect(segment(image, CONCEPTS)).rejects.toThrow("bad prompt");

    // The first 3 were already in flight; nothing after the failure was started.
    expect(create.mock.calls.map(([b]) => conceptOf(b))).toEqual(["concrete column", "brick wall", "concrete slab"]);
  });
});

describe("createLimiter", () => {
  it("never exceeds the limit, even when a slot frees up while new tasks arrive", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = (ms: number) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, ms));
        active--;
        return ms;
      });
    const first = Array.from({ length: 5 }, (_, i) => task(5 + i * 3));
    await new Promise((r) => setTimeout(r, 6)); // first task done; queue new ones mid-flight
    const later = Array.from({ length: 5 }, () => task(2));
    await Promise.all([...first, ...later]);
    expect(peak).toBe(2);
  });
});
