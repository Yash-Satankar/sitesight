import { describe, expect, it } from "vitest";
import {
  conceptSlug,
  DEFAULT_CONCEPTS,
  overlayFilename,
  parseConcepts,
  parseSpikeArgs,
  splitByScore,
  summarise,
  type SpikeRow,
} from "../scripts/spike-lib.js";

describe("parseSpikeArgs", () => {
  it("defaults to the 5 standard concepts, samples/ and min score 0", () => {
    expect(parseSpikeArgs([])).toEqual({ concepts: DEFAULT_CONCEPTS, dir: null, minScore: 0, help: false });
  });

  it("parses --concepts, --dir and --min-score", () => {
    const o = parseSpikeArgs(["--concepts", "brickwork, red brick masonry ,exposed brick wall", "--dir", "samples/x", "--min-score", "0.4"]);
    expect(o).toEqual({ concepts: ["brickwork", "red brick masonry", "exposed brick wall"], dir: "samples/x", minScore: 0.4, help: false });
  });

  it("accepts --flag=value and a leading -- from pnpm", () => {
    expect(parseSpikeArgs(["--", "--concepts=a,b", "--min-score=1"])).toMatchObject({ concepts: ["a", "b"], minScore: 1 });
  });

  it("keeps the bare folder argument working", () => {
    expect(parseSpikeArgs(["samples/x"]).dir).toBe("samples/x");
  });

  it.each([
    [["--min-score", "1.5"], /--min-score must be a number from 0 to 1/],
    [["--min-score", "-0.1"], /--min-score/],
    [["--min-score", "abc"], /--min-score/],
    [["--min-score", ""], /--min-score/],
    [["--concepts", " , ,"], /--concepts is empty/],
    [["--dir", "a", "b"], /either as --dir or as a bare argument/],
    [["a", "b"], /Unexpected arguments: b/],
    [["--concept", "x"], /Unknown option/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseSpikeArgs(argv)).toThrow(message);
  });
});

describe("parseConcepts", () => {
  it("trims, drops empties and exact duplicates, keeps order", () => {
    expect(parseConcepts("b, a,,b ,  c")).toEqual(["b", "a", "c"]);
  });
});

describe("overlay filenames", () => {
  it("include a readable concept slug", () => {
    expect(conceptSlug("red brick masonry")).toMatch(/^red-brick-masonry-[0-9a-f]{6}$/);
    expect(overlayFilename("images (1)", "red brick masonry", 0)).toMatch(/^images \(1\)__red-brick-masonry-[0-9a-f]{6}\.png$/);
  });

  it("differ for variants that slug the same, including case-only differences", () => {
    const names = ["brick wall", "Brick wall", "brick-wall", "brick  wall"].map((c) => overlayFilename("img", c, 0).toLowerCase());
    expect(new Set(names).size).toBe(4);
  });

  it("are stable across runs and tagged with min score when filtering", () => {
    expect(overlayFilename("img", "brickwork", 0)).toBe(overlayFilename("img", "brickwork", 0));
    expect(overlayFilename("img", "brickwork", 0.5)).toMatch(/__min0\.5\.png$/);
  });
});

describe("splitByScore", () => {
  it("keeps instances at or above the threshold", () => {
    const { kept, dropped } = splitByScore([{ score: 0.2 }, { score: 0.5 }, { score: 0.9 }], 0.5);
    expect(kept.map((s) => s.score)).toEqual([0.5, 0.9]);
    expect(dropped.map((s) => s.score)).toEqual([0.2]);
  });
});

describe("summarise", () => {
  const row = (image: string, concept: string, kept: number, scoreSum: number, extra: Partial<SpikeRow> = {}): SpikeRow => ({
    image,
    concept,
    ok: true,
    kept,
    dropped: 0,
    scoreSum,
    ms: 100,
    ...extra,
  });

  it("reports images hit, instances, instance-weighted mean score, drops and errors per concept", () => {
    const rows = [
      row("a.jpg", "brickwork", 3, 2.4, { dropped: 1, ms: 100 }), // mean 0.8
      row("b.jpg", "brickwork", 0, 0, { dropped: 2, ms: 300 }),
      row("c.jpg", "brickwork", 1, 0.4, { ms: 200 }),
      row("a.jpg", "red brick", 0, 0, { ok: false, error: "boom", ms: 5 }),
      row("b.jpg", "red brick", 2, 1.8),
    ];
    const [brick, red, unused] = summarise(rows, ["brickwork", "red brick", "unused"]);
    expect(brick).toEqual({
      concept: "brickwork",
      imagesOk: 3,
      imagesWithHit: 2,
      instances: 4,
      dropped: 3,
      meanScore: (2.4 + 0.4) / 4, // weighted by instance, not averaged per image
      errors: 0,
      meanMs: 200,
    });
    expect(red).toMatchObject({ imagesOk: 1, imagesWithHit: 1, instances: 2, errors: 1, meanMs: 100 });
    expect(red!.meanScore).toBeCloseTo(0.9);
    expect(unused).toMatchObject({ imagesOk: 0, imagesWithHit: 0, instances: 0, meanScore: null, meanMs: null });
  });
});
