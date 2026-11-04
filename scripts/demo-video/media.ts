// ffmpeg (ffmpeg-static, installed in scripts/demo-video/node_modules) and sharp: scene composition at 1920×1080,
// 30 fps H.264, the phone frame, "sped up" labels, zooms, overlay graphics, caption pills and the final renders.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(join(here, "package.json"));
export const FFMPEG: string = localRequire("ffmpeg-static");

export const W = 1920;
export const H = 1080;
export const FPS = 30;

/** Phone: ~85 % of the frame height, left of centre; the right side holds panels and callouts. */
export const PHONE = { screenW: 411, screenH: 890, bezel: 14, cx: 540, y: 20 };
export const PHONE_SIDE = { x: 930, w: 900 };
/** Desktop recordings on the left, callout column on the right. */
export const DESKTOP = { w: 1168, h: 730, x: 48, y: 64 };
export const DESKTOP_SIDE = { x: 1262, w: 610 };
/** Recorded page sizes (CSS px). */
export const REC = { phone: { w: 390, h: 844 }, desktop: { w: 1280, h: 800 } };

export function ffmpeg(args: string[], cwd: string): void {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

export function probeDuration(file: string): number {
  let out = "";
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-i", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String((e as { stderr?: string }).stderr ?? "");
  }
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  if (!m) throw new Error(`could not read the duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ---- timing ----

export interface Mark {
  at: number; // seconds from the start of the recording (script clock)
  kind: "normal" | "wait" | "end";
}

export interface Piece {
  from: number;
  to: number;
  speed: number;
}

export interface Plan {
  pieces: Piece[];
  sped: { from: number; to: number; speed: number }[];
  total: number;
}

/** Script-clock offset of a recording: the video starts a moment after the script's clock. */
export function markOffset(marks: Mark[], duration: number): number {
  const end = marks.find((m) => m.kind === "end")?.at;
  return end != null && end > duration ? duration - end : 0;
}

type Win = { from: number; to: number; anchor: "start" | "end" | "event" | "split"; event?: number };

/**
 * Fit a recording into its slot. Normal parts play at 1× (up to 1.5× if they alone overflow). Waits play at 3–4×,
 * keeping a window around each key event (a trace step worth seeing) and dropping the dull stretches between.
 * `trimStart` drops the blank page load; `cuts` (source seconds) drop dead time anywhere.
 */
export function planPieces(
  marks: Mark[],
  duration: number,
  slot: number,
  opts: { trimStart?: number; cuts?: [number, number][]; events?: number[] } = {},
): Plan {
  // Widen the windows kept around events until the scene is filled (no long freeze at the end).
  let plan = planWith(marks, duration, slot, opts, 1);
  for (const m of [1.5, 2.2, 3.2, 4.6, 6.6, 9.5]) {
    if (plan.total >= slot - 0.6) break;
    plan = planWith(marks, duration, slot, opts, m);
  }
  return plan;
}

function planWith(
  marks: Mark[],
  duration: number,
  slot: number,
  opts: { trimStart?: number; cuts?: [number, number][]; events?: number[] },
  m: number,
): Plan {
  const offset = markOffset(marks, duration);
  const sorted = [...marks].map((m) => ({ ...m, at: m.at + offset })).sort((a, b) => a.at - b.at);
  let spans: { from: number; to: number; wait: boolean }[] = [];
  let cur = { at: 0, kind: "normal" as Mark["kind"] };
  for (const m of sorted) {
    const at = Math.min(Math.max(m.at, 0), duration);
    if (at > cur.at + 0.01 && cur.kind !== "end") spans.push({ from: cur.at, to: at, wait: cur.kind === "wait" });
    cur = { at, kind: m.kind };
  }
  if (cur.kind !== "end" && duration > cur.at + 0.01) spans.push({ from: cur.at, to: duration, wait: cur.kind === "wait" });
  // Drop the blank start and explicit dead-time cuts.
  const drops: [number, number][] = [...(opts.trimStart ? [[0, opts.trimStart] as [number, number]] : []), ...(opts.cuts ?? [])];
  for (const [a, b] of drops) {
    spans = spans.flatMap((s) => {
      if (b <= s.from || a >= s.to) return [s];
      const out = [];
      if (a > s.from) out.push({ ...s, to: a });
      if (b < s.to) out.push({ ...s, from: b });
      return out;
    });
  }

  // Windows kept inside each wait: its head and tail, and around each key event.
  const winsFor = (s: { from: number; to: number }): Win[] => {
    const events = (opts.events ?? []).filter((e) => e > s.from && e < s.to);
    if (!events.length) return [{ from: s.from, to: s.to, anchor: "split" }];
    const raw: Win[] = [
      { from: s.from, to: Math.min(s.to, s.from + 4 * m), anchor: "start" },
      ...events.map((e) => ({ from: Math.max(s.from, e - 2 * m), to: Math.min(s.to, e + 7 * m), anchor: "event" as const, event: e })),
      { from: Math.max(s.from, s.to - 4 * m), to: s.to, anchor: "end" },
    ].sort((a, b) => a.from - b.from);
    const merged: Win[] = [];
    for (const w of raw) {
      const last = merged.at(-1);
      if (last && w.from <= last.to + 1.5) {
        last.to = Math.max(last.to, w.to);
        if (w.anchor === "event" && last.anchor !== "event") Object.assign(last, { anchor: "event", event: w.event });
      } else merged.push({ ...w });
    }
    return merged;
  };
  const waitWins = spans.map((s) => (s.wait ? winsFor(s) : []));
  const len = (ws: Win[]) => ws.reduce((a, w) => a + w.to - w.from, 0);
  const normal = spans.filter((s) => !s.wait).reduce((a, s) => a + s.to - s.from, 0);
  const wait = waitWins.reduce((a, ws) => a + len(ws), 0);
  const minWaitShown = wait ? Math.min(wait / 4, Math.max(4, slot * 0.35)) : 0;
  const normalSpeed = normal > slot - minWaitShown ? Math.min(1.5, normal / Math.max(1, slot - minWaitShown)) : 1;
  const budget = Math.max(0.1, slot - normal / normalSpeed);
  let waitSpeed = wait ? Math.min(4, Math.max(3, wait / budget)) : 1;
  if (wait && wait <= budget) waitSpeed = 1;
  const shrink = wait ? Math.min(1, (budget * waitSpeed) / wait) : 1;

  const pieces: Piece[] = [];
  const sped: Plan["sped"] = [];
  let t = 0;
  spans.forEach((s, i) => {
    if (!s.wait) {
      pieces.push({ from: s.from, to: s.to, speed: normalSpeed });
      t += (s.to - s.from) / normalSpeed;
      return;
    }
    const start = t;
    for (const w of waitWins[i]!) {
      const keep = Math.max(0.4, (w.to - w.from) * shrink);
      const segs =
        shrink >= 0.999
          ? [{ from: w.from, to: w.to }]
          : w.anchor === "start"
            ? [{ from: w.from, to: w.from + keep }]
            : w.anchor === "end"
              ? [{ from: w.to - keep, to: w.to }]
              : w.anchor === "event"
                ? [{ from: Math.max(w.from, w.event! - keep * 0.25), to: Math.max(w.from, w.event! - keep * 0.25) + keep }]
                : [{ from: w.from, to: w.from + keep / 2 }, { from: w.to - keep / 2, to: w.to }];
      for (const g of segs) {
        const to = Math.min(g.to, w.to);
        pieces.push({ from: g.from, to, speed: waitSpeed });
        t += (to - g.from) / waitSpeed;
      }
    }
    if (waitSpeed > 1) sped.push({ from: start, to: t, speed: waitSpeed });
  });
  return { pieces, sped, total: t };
}

/** Where a source moment lands in the scene's output (moments inside a cut snap to the next kept frame). */
export function mapTime(plan: Plan, src: number): number {
  let t = 0;
  for (const p of plan.pieces) {
    if (src < p.from) return t;
    if (src <= p.to) return t + (src - p.from) / p.speed;
    t += (p.to - p.from) / p.speed;
  }
  return t;
}

// ---- static art ----

export async function makeArt(outDir: string): Promise<void> {
  const sharp = createRequire(join(here, "..", "..", "apps", "api", "package.json"))("sharp") as typeof import("sharp");
  const bg = join(outDir, "bg.png");
  if (!existsSync(bg)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#f4f6f8"/><stop offset="1" stop-color="#dfe4ea"/></radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(bg);
  }
  const frame = join(outDir, `phone-frame-${PHONE.screenW}.png`);
  if (!existsSync(frame)) {
    const { screenW: sw, screenH: sh, bezel: b } = PHONE;
    const fw = sw + 2 * b;
    const fh = sh + 2 * b;
    const r = 60;
    const ri = r - b;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fw + 40}" height="${fh + 40}">
      <defs><filter id="s" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-opacity="0.25"/></filter></defs>
      <path filter="url(#s)" fill-rule="evenodd" fill="#1f2328" d="
        M${20 + r},20 h${fw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${fh - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${fw - 2 * r} a${r},${r} 0 0 1 -${r},-${r} v-${fh - 2 * r} a${r},${r} 0 0 1 ${r},-${r} z
        M${20 + b + ri},${20 + b} h${sw - 2 * ri} a${ri},${ri} 0 0 1 ${ri},${ri} v${sh - 2 * ri} a${ri},${ri} 0 0 1 -${ri},${ri} h-${sw - 2 * ri} a${ri},${ri} 0 0 1 -${ri},-${ri} v-${sh - 2 * ri} a${ri},${ri} 0 0 1 ${ri},-${ri} z"/>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(frame);
  }
  const font = join(outDir, "label-font.ttf");
  if (!existsSync(font)) {
    for (const f of ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"]) {
      if (existsSync(f)) {
        copyFileSync(f, font);
        break;
      }
    }
  }
}

// ---- one scene ----

export interface Zoom {
  from: number; // scene output seconds
  to: number;
  x: number; // focus point, fraction of the recorded page
  y: number;
  z: number; // zoom factor, e.g. 1.6
}

export interface Overlay {
  file: string; // PNG relative to outDir
  x: number;
  y: number;
  from: number;
  to?: number;
  anim?: "fade" | "zoom";
  /** Box the image is centred in (for the zoom-in animation). */
  boxW?: number;
}

/** Compose a recorded clip into an exact-length 1920×1080 scene file (no audio). */
export function composeScene(opts: {
  outDir: string;
  clip: string;
  out: string;
  kind: "card" | "desktop" | "phone";
  plan: Plan;
  slot: number;
  zoom?: Zoom | null;
  overlays?: Overlay[];
}): void {
  const { pieces, sped, total } = opts.plan;
  const parts = pieces.map((p, i) => `[0:v]trim=start=${p.from.toFixed(3)}:end=${p.to.toFixed(3)},setpts=(PTS-STARTPTS)/${p.speed.toFixed(4)}[p${i}]`);
  const joined = `${pieces.map((_, i) => `[p${i}]`).join("")}concat=n=${pieces.length}:v=1:a=0,fps=${FPS}`;
  const hold = Math.max(0, opts.slot - total) + 0.5;
  // Hold the last frame to the slot length before zooming/overlaying, so later filters see the whole scene.
  const held = `${joined},tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)},trim=duration=${opts.slot},setpts=PTS-STARTPTS`;
  const zoomF = (w: number, h: number, up: number) => {
    const z = opts.zoom;
    if (!z) return "";
    const W2 = Math.round(w * up);
    const H2 = Math.round(h * up);
    const ramp = `max(0,min(1,min((it-${z.from.toFixed(2)})/0.8,(${z.to.toFixed(2)}-it)/0.6)))`;
    const zz = `(1+${(z.z - 1).toFixed(3)}*${ramp})`;
    return `,scale=${W2}:${H2}:flags=lanczos,zoompan=z='${zz}':x='max(0,min(iw-iw/zoom,${z.x}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${z.y}*ih-ih/zoom/2))':d=1:s=${W2}x${H2}:fps=${FPS}`;
  };

  const inputs = ["-i", opts.clip];
  let chain: string;
  let next = 1;
  if (opts.kind === "card") {
    chain = `${parts.join(";")};${held},scale=${W}:${H}:flags=lanczos,setsar=1[v0]`;
  } else if (opts.kind === "desktop") {
    inputs.push("-loop", "1", "-i", "bg.png");
    next = 2;
    chain =
      `${parts.join(";")};${held},crop=${REC.desktop.w}:${REC.desktop.h}:0:0${zoomF(REC.desktop.w, REC.desktop.h, 1.5)},scale=${DESKTOP.w}:${DESKTOP.h}:flags=lanczos,setsar=1[sc];` +
      `[1:v][sc]overlay=${DESKTOP.x}:${DESKTOP.y}:shortest=1[v0]`;
  } else {
    inputs.push("-loop", "1", "-i", "bg.png", "-loop", "1", "-i", `phone-frame-${PHONE.screenW}.png`);
    next = 3;
    const fw = PHONE.screenW + 2 * PHONE.bezel;
    const fx = Math.round(PHONE.cx - fw / 2);
    chain =
      `${parts.join(";")};${held},crop=${REC.phone.w}:${REC.phone.h}:0:0${zoomF(REC.phone.w, REC.phone.h, 2)},scale=${PHONE.screenW}:${PHONE.screenH}:flags=lanczos,setsar=1[sc];` +
      `[1:v][sc]overlay=${fx + PHONE.bezel}:${PHONE.y + PHONE.bezel}:shortest=1[b];[b][2:v]overlay=${fx - 20}:${PHONE.y - 20}:shortest=1[v0]`;
  }

  // Overlay graphics (callouts, SAM panels), each fading (and optionally zooming) in at its moment.
  let last = "v0";
  (opts.overlays ?? []).forEach((o, i) => {
    inputs.push("-loop", "1", "-t", String(opts.slot), "-i", o.file);
    const idx = next++;
    const fadeOut = o.to != null ? `,fade=out:st=${Math.max(0, o.to - 0.35).toFixed(2)}:d=0.35:alpha=1` : "";
    const zoom = o.anim === "zoom" ? `,scale=w='iw*(0.9+0.1*min(1,max(0,(t-${o.from.toFixed(2)})/0.45)))':h=-1:eval=frame` : "";
    chain += `;[${idx}:v]format=rgba,fade=in:st=${o.from.toFixed(2)}:d=0.45:alpha=1${fadeOut}${zoom}[o${i}]`;
    const x = o.anim === "zoom" && o.boxW ? `${o.x}+(${o.boxW}-overlay_w)/2` : String(o.x);
    chain += `;[${last}][o${i}]overlay=x='${x}':y=${o.y}:eval=frame:shortest=1[w${i}]`;
    last = `w${i}`;
  });

  const labelX = opts.kind === "phone" ? Math.round(PHONE.cx + (PHONE.screenW + 2 * PHONE.bezel) / 2 + 24) : DESKTOP.x + DESKTOP.w - 250;
  const labelY = opts.kind === "phone" ? PHONE.y + 30 : DESKTOP.y + 20;
  const labels = sped
    .map(
      (s) =>
        `drawtext=fontfile=label-font.ttf:text='sped up ${Math.round(s.speed * 10) / 10}×':fontsize=30:fontcolor=white:box=1:boxcolor=0x1f2328@0.78:boxborderw=14:x=${labelX}:y=${labelY}:enable='between(t,${s.from.toFixed(2)},${s.to.toFixed(2)})'`,
    )
    .join(",");
  const final = `[${last}]${labels ? `${labels},` : ""}trim=duration=${opts.slot},setpts=PTS-STARTPTS,format=yuv420p[out]`;
  ffmpeg(
    [...inputs, "-filter_complex", `${chain};${final}`, "-map", "[out]", "-an", "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-t", String(opts.slot), opts.out],
    opts.outDir,
  );
}

// ---- captions (script timing, used when there is no voice) ----

export interface Cue {
  start: number;
  end: number;
  text: string;
}

// ---- final ----

/** Concatenate scenes, overlay caption pills (PNG per cue), write the silent video; add the voice if given. */
export function renderFinal(outDir: string, sceneFiles: string[], captions: { file: string; start: number; end: number; w: number; h: number }[], audio: string | null): { silent: string; voiced: string | null } {
  writeFileSync(join(outDir, "concat.txt"), sceneFiles.map((f) => `file '${f}'`).join("\n"));
  ffmpeg(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "joined.mp4"], outDir);
  const inputs = ["-i", "joined.mp4"];
  let chain = "";
  let last = "0:v";
  captions.forEach((c, i) => {
    inputs.push("-i", c.file);
    const x = Math.round((W - c.w) / 2);
    const y = H - 34 - c.h;
    chain += `${chain ? ";" : ""}[${last}][${i + 1}:v]overlay=${x}:${y}:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'[c${i}]`;
    last = `c${i}`;
  });
  const vf = chain ? ["-filter_complex", `${chain};[${last}]format=yuv420p[v]`, "-map", "[v]"] : ["-map", "0:v"];
  ffmpeg([...inputs, ...vf, "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", "-an", "sitesight-demo-silent.mp4"], outDir);
  if (!audio) {
    copyFileSync(join(outDir, "sitesight-demo-silent.mp4"), join(outDir, "sitesight-demo.mp4"));
    return { silent: "sitesight-demo-silent.mp4", voiced: null };
  }
  ffmpeg(["-i", "sitesight-demo-silent.mp4", "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", "sitesight-demo.mp4"], outDir);
  return { silent: "sitesight-demo-silent.mp4", voiced: "sitesight-demo.mp4" };
}

export function extractFrame(outDir: string, video: string, at: number, file: string): void {
  ffmpeg(["-ss", at.toFixed(2), "-i", video, "-frames:v", "1", file], outDir);
}
