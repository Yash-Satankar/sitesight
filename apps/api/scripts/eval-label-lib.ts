// Pure helpers for scripts/eval-label.ts: which photos still need labels, how answers become eval labels, and the
// question flow itself (driven through a small IO interface so tests can script the answers). No Meta calls.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { EvalCases, PhotoCase } from "./eval-lib.js";

export type LabelledBy = "human" | "draft";

/** Stock or downloaded images in samples/ that must never be labelled as site photos. */
export function isStockImage(file: string): boolean {
  return /^images?\s*(\(\d+\))?\.(jpe?g|png|webp)$/i.test(basename(file));
}

export function isSitePhotoFile(file: string): boolean {
  return /\.(jpe?g|png|webp|heic)$/i.test(file) && !isStockImage(file);
}

const sha1 = (path: string) => createHash("sha1").update(readFileSync(path)).digest("hex");

/**
 * Real site photos directly in samples/ that no case uses yet (compared by content, so a copy in samples/run1/ that a
 * case already uses counts as labelled). Paths are relative to the repo root, sorted.
 */
export function unlabelledPhotos(repoRoot: string, cases: EvalCases): string[] {
  const dir = join(repoRoot, "samples");
  const used = new Set<string>();
  for (const c of cases.cases) {
    if (c.kind !== "photos") continue;
    for (const p of c.photos) {
      try {
        used.add(sha1(join(repoRoot, p)));
      } catch {
        // a case pointing at a missing file: nothing to compare
      }
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    const full = join(dir, f);
    if (!statSync(full).isFile() || !isSitePhotoFile(f)) continue;
    const h = sha1(full);
    if (used.has(h) || seen.has(h)) continue;
    seen.add(h);
    out.push(relative(repoRoot, full).replace(/\\/g, "/"));
  }
  return out;
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(jpe?g|png|webp|heic)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** False positives the engineer can tick; each becomes a should_reject note with matching keywords. */
export const FALSE_POSITIVES = {
  "1": { label: "scaffolding", note: "scaffolding / bamboo poles and props are not columns", keywords: ["scaffold", "bamboo", "pole", "prop"] },
  "2": { label: "tarp/net", note: "tarps, nets and sheets are not brickwork or columns", keywords: ["tarp", "net", "sheet", "cloth", "cover"] },
  "3": { label: "rebar cage", note: "rebar cages / starter bars are not cast columns", keywords: ["rebar", "cage", "reinforcement", "steel", "starter", "bar", "not cast"] },
  "4": { label: "tree", note: "trees and vegetation are not structure", keywords: ["tree", "vegetation", "trunk", "branch", "plant"] },
  "5": { label: "neighbour building", note: "neighbouring buildings are not part of this site", keywords: ["neighbour", "neighbor", "adjacent", "background", "other building"] },
} as const;

export type BoqItemLite = { code: string; description: string; measureMode: string; stages?: { name: string }[] | null };

/** Which question an item gets. */
export function itemKind(item: BoqItemLite): "stage" | "count" | "plinth" | "walls" | "generic" {
  if (item.stages?.length) return "stage";
  if (item.measureMode === "count") return "count";
  if (/plinth/i.test(item.description)) return "plinth";
  if (/brick|masonry|wall|block/i.test(item.description)) return "walls";
  return "generic";
}

export type ItemAnswer =
  | { kind: "stage"; stage: string }
  | { kind: "count"; visible: number | null }
  | { kind: "visibility"; visible: "y" | "n" | "h" }
  | { kind: "walls"; visible: "y" | "n"; material: "brick" | "concrete block" | "AAC" | "none" }
  | { kind: "skip" };

export interface NewCaseAnswers {
  photo: string;
  boq: string;
  items: Record<string, ItemAnswer>;
  falsePositives: string[]; // keys of FALSE_POSITIVES
  other?: { note: string; keywords: string[] };
  notes: string;
}

/** Count tolerance: exact for small counts, ±1 from 6 up (one column hidden behind another is normal). */
export const countTolerance = (n: number) => (n >= 6 ? 1 : 0);

/**
 * Turn the engineer's answers into a case. Only stage, count and basis are scored by the eval; wall material and
 * "not built / not in view" answers are kept under observations for the record.
 */
export function buildCase(a: NewCaseAnswers, existingIds: Set<string>): PhotoCase & { labelled_by: LabelledBy; observations: Record<string, string> } {
  const expected: PhotoCase["expected"] = {};
  const observations: Record<string, string> = {};
  for (const [code, ans] of Object.entries(a.items)) {
    switch (ans.kind) {
      case "stage":
        expected[code] = { stage: ans.stage, basis: "observed", tolerance: 0 };
        break;
      case "count":
        if (ans.visible == null) observations[code] = "columns not visible";
        else expected[code] = { count: ans.visible, tolerance: countTolerance(ans.visible) };
        break;
      case "visibility":
        if (ans.visible === "y") expected[code] = { basis: "observed", tolerance: 0 };
        else if (ans.visible === "h") expected[code] = { basis: "inferred", tolerance: 0 };
        else observations[code] = "not built or not in view";
        break;
      case "walls":
        if (ans.visible === "y") expected[code] = { basis: "observed", tolerance: 0 };
        else observations[code] = "walls not visible";
        observations[`${code} material`] = ans.material;
        break;
      case "skip":
        break;
    }
  }
  const should_reject: PhotoCase["should_reject"] = a.falsePositives.map((k) => {
    const fp = FALSE_POSITIVES[k as keyof typeof FALSE_POSITIVES];
    return { note: fp.note, keywords: [...fp.keywords] };
  });
  if (a.other) should_reject.push({ note: a.other.note, keywords: a.other.keywords });
  let id = slug(`${basename(a.boq).replace(/^boq-|\.json$/g, "")}-${basename(a.photo)}`);
  for (let n = 2; existingIds.has(id); n++) id = `${slug(`${basename(a.boq).replace(/^boq-|\.json$/g, "")}-${basename(a.photo)}`)}-${n}`;
  return {
    id,
    kind: "photos",
    description: a.notes.trim() || `Labelled by the site engineer (${basename(a.photo)}).`,
    photos: [a.photo],
    boq: a.boq,
    expected,
    should_reject,
    labelled_by: "human",
    observations,
  };
}

/** Cases that count for headline numbers. Anything without labelled_by: "human" is a draft. */
export function isHumanLabelled(c: { labelled_by?: string }): boolean {
  return c.labelled_by === "human";
}

// ---- the question flow (IO injected) ----

export interface LabelIO {
  /** Single key from `choices` (lower-case); Enter returns "" if "" is in choices. */
  key(prompt: string, choices: string[]): Promise<string>;
  /** A line of text; empty input returns `def` when given. */
  line(prompt: string, def?: string): Promise<string>;
  print(text: string): void;
  open(path: string): void;
}

export type RawCases = { labels_note?: string; cases: Record<string, unknown>[] };

/** Review one draft case: confirm, edit field by field, or skip. Returns the (possibly edited) case, or null to skip, or "quit". */
export async function reviewDraft(c: Record<string, unknown>, io: LabelIO): Promise<Record<string, unknown> | null | "quit"> {
  const pc = c as unknown as PhotoCase & { labelled_by?: string };
  io.print(`\n── ${pc.id} (${pc.labelled_by ?? "draft"}) ──`);
  io.print(pc.description);
  io.print(`BOQ: ${pc.boq}`);
  for (const p of pc.photos) io.open(p);
  io.print("Expected:");
  for (const [code, l] of Object.entries(pc.expected)) io.print(`  ${code}: ${fmtLabel(l)}`);
  io.print("Should reject:");
  for (const r of pc.should_reject) io.print(`  - ${r.note}  [${r.keywords.join(", ")}]`);
  const choice = await io.key("[c] confirm  [e] edit  [s] skip  [q] save and quit", ["c", "e", "s", "q"]);
  if (choice === "q") return "quit";
  if (choice === "s") return null;
  if (choice === "c") return { ...c, labelled_by: "human" };

  // Edit field by field: Enter keeps the current value, "-" removes it.
  const expected: Record<string, Record<string, unknown>> = {};
  for (const [code, l] of Object.entries(pc.expected)) {
    const next: Record<string, unknown> = {};
    for (const field of ["stage", "count", "tolerance", "basis"] as const) {
      const cur = (l as Record<string, unknown>)[field];
      if (cur === undefined && field !== "stage" && field !== "basis") continue;
      const v = await io.line(`  ${code}.${field} [${cur ?? "—"}] (Enter keeps, - removes): `, cur === undefined ? "" : String(cur));
      if (v === "-" || v === "") continue;
      if (field === "count" || field === "tolerance") {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) next[field] = Math.round(n);
      } else if (field === "basis") {
        if (v === "observed" || v === "inferred") next[field] = v;
      } else next[field] = v;
    }
    if (next.stage != null || next.count != null || next.basis != null) expected[code] = next;
    else io.print(`  ${code}: no stage, count or basis left, so it is dropped from the case`);
  }
  const keep: PhotoCase["should_reject"] = [];
  for (const r of pc.should_reject) {
    if ((await io.key(`  keep "${r.note}"? [y/n]`, ["y", "n"])) === "y") keep.push(r);
  }
  const added = await askFalsePositives(io);
  const description = await io.line(`  description [${pc.description}]: `, pc.description);
  return { ...c, description, expected, should_reject: [...keep, ...added], labelled_by: "human" };
}

function fmtLabel(l: Record<string, unknown>): string {
  return Object.entries(l)
    .filter(([k, v]) => v != null && !(k === "tolerance" && v === 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

async function askFalsePositives(io: LabelIO): Promise<PhotoCase["should_reject"]> {
  io.print("  False positives in the photo (things SAM may mistake for columns/brickwork):");
  io.print(`    ${Object.entries(FALSE_POSITIVES).map(([k, v]) => `[${k}] ${v.label}`).join("  ")}  [6] other`);
  const raw = await io.line("    keys, e.g. 13 (Enter = none): ", "");
  const keys = [...new Set(raw.replace(/[^1-6]/g, "").split(""))];
  const out: PhotoCase["should_reject"] = keys
    .filter((k) => k !== "6")
    .map((k) => FALSE_POSITIVES[k as keyof typeof FALSE_POSITIVES])
    .map((fp) => ({ note: fp.note, keywords: [...fp.keywords] }));
  if (keys.includes("6")) {
    const note = await io.line("    other: what is it (e.g. 'stacked formwork plates')? ");
    const kw = (await io.line("    keywords a rejection reason would contain, comma-separated: "))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (note.trim() && kw.length) out.push({ note: note.trim(), keywords: kw });
  }
  return out;
}

/** Label one new photo. Returns the new case, null to skip, or "quit". */
export async function labelPhoto(
  photo: string,
  boqs: { key: string; path: string; items: BoqItemLite[] }[],
  existingIds: Set<string>,
  io: LabelIO,
): Promise<Record<string, unknown> | null | "quit"> {
  io.print(`\n── ${photo} ──`);
  io.open(photo);
  const boqChoice = await io.key(`Which BOQ? ${boqs.map((b) => `[${b.key}] ${basename(b.path)}`).join("  ")}  [s] skip  [q] save and quit`, [...boqs.map((b) => b.key), "s", "q"]);
  if (boqChoice === "q") return "quit";
  if (boqChoice === "s") return null;
  const boq = boqs.find((b) => b.key === boqChoice)!;

  const items: Record<string, ItemAnswer> = {};
  for (const item of boq.items) {
    const head = `${item.code} · ${item.description}`;
    switch (itemKind(item)) {
      case "stage": {
        const stages = ["none", ...item.stages!.map((s) => s.name)];
        const k = await io.key(`${head}\n  latest COMPLETED stage: ${stages.map((s, i) => `[${i}] ${s}`).join("  ")}  [s] skip`, [...stages.map((_, i) => String(i)), "s"]);
        items[item.code] = k === "s" ? { kind: "skip" } : { kind: "stage", stage: stages[Number(k)]! };
        break;
      }
      case "count": {
        for (;;) {
          const v = (await io.line(`${head}\n  cast columns visible: a number, n = not visible, s = skip: `)).trim().toLowerCase();
          if (v === "s") items[item.code] = { kind: "skip" };
          else if (v === "n") items[item.code] = { kind: "count", visible: null };
          else if (/^\d+$/.test(v)) items[item.code] = { kind: "count", visible: Number(v) };
          else {
            io.print("  type a number, n or s");
            continue;
          }
          break;
        }
        break;
      }
      case "plinth": {
        const k = await io.key(`${head}\n  plinth beams visible? [y] yes  [n] no / not built  [h] hidden (covered by later work)  [s] skip`, ["y", "n", "h", "s"]);
        items[item.code] = k === "s" ? { kind: "skip" } : { kind: "visibility", visible: k as "y" | "n" | "h" };
        break;
      }
      case "walls": {
        const k = await io.key(`${head}\n  brickwork / walls visible? [y/n]  [s] skip`, ["y", "n", "s"]);
        if (k === "s") {
          items[item.code] = { kind: "skip" };
          break;
        }
        const m = await io.key("  wall material: [b] brick  [c] concrete block  [a] AAC  [n] none", ["b", "c", "a", "n"]);
        const material = ({ b: "brick", c: "concrete block", a: "AAC", n: "none" } as const)[m as "b" | "c" | "a" | "n"];
        items[item.code] = { kind: "walls", visible: k as "y" | "n", material };
        break;
      }
      default: {
        const k = await io.key(`${head}\n  visible? [y] yes  [n] no / not built  [h] hidden (inferred from later work)  [s] skip`, ["y", "n", "h", "s"]);
        items[item.code] = k === "s" ? { kind: "skip" } : { kind: "visibility", visible: k as "y" | "n" | "h" };
      }
    }
  }
  const fps = await askFalsePositives(io);
  const notes = await io.line("Notes / one-line description of the photo (Enter to skip): ", "");
  const built = buildCase({ photo, boq: boq.path, items, falsePositives: [], notes }, existingIds);
  built.should_reject = fps;
  if (!Object.keys(built.expected).length) {
    io.print("  Nothing scorable was labelled (no stage, count or basis), so this photo is skipped.");
    return null;
  }
  return built as unknown as Record<string, unknown>;
}
