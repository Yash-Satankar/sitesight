// Per-scene polish: which parts to keep (key trace events), callouts, the big SAM panels and gentle zooms.
// Trace data (step times, detections, reasons) comes from the local demo database and is cached in state.json.
import { createRequire } from "node:module";
import { join } from "node:path";
import { panelBase, renderCallout, renderSamPanel, rejectLabel, type PanelBox } from "./graphics.js";
import { DESKTOP_SIDE, PHONE_SIDE, mapTime, markOffset, planPieces, type Mark, type Overlay, type Plan, type Zoom } from "./media.js";
import { sqlValue } from "./stack.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SceneEvents {
  segment?: number; // source seconds in the recording
  verify?: number;
  ask?: number;
  assess?: number;
}

export interface SceneDetections {
  photo: { file: string; w: number; h: number };
  segments: { id: number; concept: string; bbox: [number, number, number, number]; verified: boolean | null; reason: string | null; mask: string }[];
}

const rows = (q: string) =>
  sqlValue(q)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split("|"));

/** Key trace moments of a visit, as times in its recording (the recording ended at recordedAt). */
export function loadEvents(visitId: number, recordedAt: string, duration: number): SceneEvents {
  const end = Date.parse(recordedAt);
  const toSrc = (iso: string) => duration - (end - Date.parse(iso.replace(" ", "T").replace(/\+00$/, "Z"))) / 1000;
  const first = (name: string) => {
    const r = rows(`select min(st.created_at) from agent_steps st join agent_runs r on r.id = st.run_id where r.visit_id = ${visitId} and st.kind = 'tool_result' and st.name = '${name}'`)[0]?.[0];
    return r ? toSrc(r) : undefined;
  };
  return { segment: first("segment_photo"), verify: first("verify_segments"), ask: first("request_photo"), assess: first("record_assessment") };
}

export function loadDetections(visitId: number, storageDir: string): SceneDetections | null {
  const p = rows(`select id, storage_key, width, height from photos where visit_id = ${visitId} order by id limit 1`)[0];
  if (!p) return null;
  const segs = rows(`select id, concept, bbox, verified, coalesce(reject_reason, ''), mask_key from segments where photo_id = ${p[0]} order by id`).map((r) => ({
    id: Number(r[0]),
    concept: r[1]!,
    bbox: JSON.parse(r[2]!) as [number, number, number, number],
    verified: r[3] === "t" ? true : r[3] === "f" ? false : null,
    reason: r[4] || null,
    mask: join(storageDir, r[5]!),
  }));
  return { photo: { file: join(storageDir, p[1]!), w: Number(p[2]), h: Number(p[3]) }, segments: segs };
}

/** Portrait photos: crop to the band holding the detections so the panel stays wide. */
function cropFor(d: SceneDetections): { x: number; y: number; w: number; h: number } {
  const { w, h } = d.photo;
  if (h <= w || !d.segments.length) return { x: 0, y: 0, w, h };
  const top = Math.min(...d.segments.map((s) => s.bbox[1]));
  const bottom = Math.max(...d.segments.map((s) => s.bbox[1] + s.bbox[3]));
  const band = Math.min(h, Math.round(w * 0.9));
  const y = Math.max(0, Math.min(h - band, Math.round((top + bottom) / 2 - band / 2)));
  return { x: 0, y, w, h: band };
}

async function panelImages(repoRoot: string, outDir: string, n: number, d: SceneDetections, browser: any): Promise<{ detect: string; verify: string }> {
  const sharp = createRequire(join(repoRoot, "apps", "api", "package.json"))("sharp");
  const crop = cropFor(d);
  const shift = (b: [number, number, number, number]): [number, number, number, number] => [b[0] - crop.x, b[1] - crop.y, b[2], b[3]];
  const base = async (masks: string[], tint: [number, number, number], name: string) => {
    const full = join(outDir, `gfx/${name}.full.png`);
    await panelBase(repoRoot, d.photo.file, d.photo.w, d.photo.h, masks, tint, full);
    const out = join(outDir, `gfx/${name}.png`);
    await sharp(full).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toFile(out);
    return out;
  };
  const opts = { photoW: crop.w, photoH: crop.h, maxW: PHONE_SIDE.w - 40, maxH: 640 };
  const all = d.segments;
  const kept = all.filter((s) => s.verified === true);
  const rejected = all.filter((s) => s.verified === false);
  const targets = [...new Set(all.map((s) => s.concept))].join(" / ");

  const detect = `gfx/scene-${n}-detect.png`;
  await renderSamPanel(
    browser,
    {
      ...opts,
      base: await base(all.map((s) => s.mask), [250, 204, 21], `scene-${n}-detect-base`),
      title: "SAM 3.1",
      subtitle: `${all.length} candidate ${targets}${all.length === 1 ? "" : " detections"}`,
      boxes: all.map((s) => ({ bbox: shift(s.bbox), tone: "candidate" as const })),
    },
    join(outDir, detect),
  );

  // Label the biggest rejection of each kind; the rest get a red box only.
  const labelled = new Set<number>();
  const seen = new Set<string>();
  for (const s of [...rejected].sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])) {
    const l = rejectLabel(s.reason ?? "", s.concept);
    if (seen.has(l) || labelled.size >= 3) continue;
    seen.add(l);
    labelled.add(s.id);
  }
  const boxes: PanelBox[] = rejected.map((s) => ({ bbox: shift(s.bbox), tone: "rejected", label: labelled.has(s.id) ? rejectLabel(s.reason ?? "", s.concept) : undefined }));
  const verify = `gfx/scene-${n}-verify.png`;
  await renderSamPanel(
    browser,
    {
      ...opts,
      base: await base(kept.map((s) => s.mask), [20, 184, 166], `scene-${n}-verify-base`),
      title: "Muse Spark",
      subtitle: `${kept.length} kept · ${rejected.length} rejected`,
      boxes,
    },
    join(outDir, verify),
  );
  return { detect, verify };
}

export interface ScenePolish {
  plan: Plan;
  zoom: Zoom | null;
  overlays: Overlay[];
  calloutAt: number | null;
}

/** Everything composeScene needs beyond the clip: the cut plan, overlays and zoom. */
export async function polishScene(o: {
  repoRoot: string;
  outDir: string;
  browser: any;
  scene: { n: number; kind: "card" | "desktop" | "phone"; slot: number; polish?: any };
  marks: Mark[];
  duration: number;
  events: SceneEvents;
  detections: SceneDetections | null;
}): Promise<ScenePolish> {
  const p = o.scene.polish ?? {};
  const keyEvents = [o.events.segment, o.events.verify, o.events.ask].filter((e): e is number => e != null);
  // Dead time: explicit source-second cuts (e.g. a page reload's blank frames) and an optional tail cut.
  const cuts: [number, number][] = [...((p.cuts ?? []) as [number, number][]), ...(p.cutTail ? [[o.duration - p.cutTail, o.duration] as [number, number]] : [])];
  const plan = planPieces(o.marks, o.duration, o.scene.slot, { trimStart: p.trimStart, cuts, events: keyEvents });
  const offset = markOffset(o.marks, o.duration);
  const sorted = [...o.marks].sort((a, b) => a.at - b.at);
  const lastWaitEnd = (() => {
    let end: number | null = null;
    sorted.forEach((m, i) => {
      if (m.kind === "wait") {
        const nextMark = sorted.slice(i + 1).find((x) => x.kind !== "wait");
        if (nextMark) end = nextMark.at + offset;
      }
    });
    return end;
  })();
  const clamp = (t: number) => Math.max(0.3, Math.min(o.scene.slot - 1.2, t));
  const at = (spec: unknown): number | null => {
    if (typeof spec === "number") return clamp(spec);
    if (typeof spec !== "string") return null;
    const m = /^(afterWait|event:(\w+))([+-]\d+(?:\.\d+)?)?$/.exec(spec);
    if (!m) return null;
    const base = m[1] === "afterWait" ? (lastWaitEnd != null ? mapTime(plan, lastWaitEnd) : null) : (o.events as any)[m[2]!] != null ? mapTime(plan, (o.events as any)[m[2]!]) : null;
    return base == null ? null : clamp(base + Number(m[3] ?? 0));
  };

  const overlays: Overlay[] = [];
  const phone = o.scene.kind === "phone";
  let calloutAt: number | null = null;
  if (p.callout) {
    calloutAt = at(p.callout.at);
    if (calloutAt != null) {
      const side = phone ? PHONE_SIDE : DESKTOP_SIDE;
      const file = `gfx/scene-${o.scene.n}-callout.png`;
      await renderCallout(o.browser, p.callout.text, side.w, join(o.outDir, file));
      overlays.push({ file, x: side.x, y: phone ? (p.panels ? 70 : 330) : 150, from: calloutAt, anim: "fade" });
    }
  }
  if (p.panels && o.detections?.segments.length) {
    const imgs = await panelImages(o.repoRoot, o.outDir, o.scene.n, o.detections, o.browser);
    let tDetect = o.events.segment != null ? clamp(mapTime(plan, o.events.segment)) : null;
    const tVerify = o.events.verify != null ? clamp(mapTime(plan, o.events.verify)) : null;
    // Give the SAM detections at least 3 s on screen before the verified view replaces them.
    if (tDetect != null && tVerify != null && tVerify - tDetect < 3) tDetect = Math.max(0.3, tVerify - 3);
    const y = 300;
    if (tDetect != null) overlays.push({ file: imgs.detect, x: PHONE_SIDE.x, y, from: tDetect, to: tVerify ?? undefined, anim: "zoom", boxW: PHONE_SIDE.w });
    if (tVerify != null) overlays.push({ file: imgs.verify, x: PHONE_SIDE.x, y, from: tVerify, anim: "zoom", boxW: PHONE_SIDE.w });
  }
  let zoom: Zoom | null = null;
  if (p.zoom) {
    const from = at(p.zoom.at);
    if (from != null) zoom = { from, to: Math.min(o.scene.slot - 0.3, from + p.zoom.dur), x: p.zoom.x, y: p.zoom.y, z: p.zoom.z };
  }
  return { plan, zoom, overlays, calloutAt };
}
