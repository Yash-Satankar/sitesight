/**
 * Code-recorded demo video against a LOCAL SiteSight (fresh Postgres in Docker, API + worker from this checkout).
 * Real Meta calls; total spend capped (scenes.json spendCapUsd) and printed.
 *
 *   pnpm demo-video                 # record what's missing (cards always), compose every scene, render the final video
 *   pnpm demo-video --scene 9       # re-record + re-compose one scene (cards are free), then re-render the final video
 *   pnpm demo-video --scene 5 --rerecord   # app scenes reuse their recording unless --rerecord (that is a new paid run)
 *   pnpm demo-video --voice kokoro  # AI voice-over (default; Kokoro TTS run locally) · --voice none for silent only
 *   pnpm demo-video --fresh         # new empty database and new recordings of everything
 *   pnpm demo-video --down          # remove the demo database container
 *
 * Output (gitignored): samples/out/video/ — sitesight-demo.mp4 (voice), sitesight-demo-silent.mp4, scene-NN.mp4,
 * captions.srt (from the real voice timings), voiceover-script.md,
 * frames/scene-NN.png (midpoint of each scene, for review), raw/ recordings, state.json, api.log.
 * Every input path lives in scripts/demo-video/scenes.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { endCard, newestHumanReport, problemCard, resultsCard, titleCard } from "./cards.js";
import { renderCaption } from "./graphics.js";
import { composeScene, extractFrame, makeArt, probeDuration, renderFinal, type Cue, type Mark } from "./media.js";
import { loadDetections, loadEvents, polishScene, type SceneDetections, type SceneEvents } from "./polish.js";
import { assertVoiceAvailable, fitLines, makeLine, mixVoice, PAD, splitForCaptions, voiceCues, writeSrt, type Line, type VoiceKind } from "./voice.js";
import {
  readJson,
  recordCard,
  sceneDrawings,
  sceneG2,
  scenePlinth,
  sceneReview,
  sceneVisit1,
  sceneVisit2,
  type Ctx,
  type Recording,
} from "./scenes.js";
import { buildWeb, dockerReady, ensureDatabase, removeDatabase, sqlValue, startApi, type ApiHandle } from "./stack.js";

/** Thrown to skip the final render when some scenes are not recorded yet. */
class SkipFinal extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    scene: { type: "string" },
    voice: { type: "string" },
    rerecord: { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    down: { type: "boolean", default: false },
    "rebuild-web": { type: "boolean", default: false },
  },
});

const config = JSON.parse(readFileSync(join(here, "scenes.json"), "utf8"));
const outDir = join(repoRoot, config.outDir);
const statePath = join(outDir, "state.json");
mkdirSync(join(outDir, "raw"), { recursive: true });
mkdirSync(join(outDir, "frames"), { recursive: true });

if (args.down) {
  removeDatabase();
  console.log("Removed the demo database container.");
  process.exit(0);
}
if (args.fresh) {
  // Keep counting what earlier databases spent: the cap covers all of the tooling.
  try {
    const before = Number(sqlValue("select coalesce(sum(cost_usd),0) from spend_ledger")) || 0;
    const prev = readJson<{ previousUsd: number }>(join(outDir, "spend.json"), { previousUsd: 0 });
    writeFileSync(join(outDir, "spend.json"), JSON.stringify({ previousUsd: prev.previousUsd + before }, null, 2));
  } catch {
    // no database yet
  }
  removeDatabase();
  rmSync(statePath, { force: true });
  rmSync(join(outDir, "storage"), { recursive: true, force: true });
}

type SceneDef = { n: number; id: string; kind: "card" | "desktop" | "phone"; slot: number; voiceover: string; polish?: any };
const scenes: SceneDef[] = config.scenes;
const totalSlots = scenes.reduce((s, x) => s + x.slot, 0);
if (totalSlots > 170) throw new Error(`Scene slots add up to ${totalSlots} s; the video must stay ≤ 2:50.`);

const voiceKind = (args.voice ?? config.voice?.default ?? "kokoro") as VoiceKind;
if (!["meta", "kokoro", "piper", "none"].includes(voiceKind)) throw new Error(`--voice must be meta, kokoro, piper or none (got ${voiceKind})`);
if (voiceKind !== "none") assertVoiceAvailable(voiceKind);

const state = readJson<any>(statePath, {});
state.recordings ??= {};
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const only = args.scene ? new Set(args.scene.split(",").map((s) => Number(s.trim()))) : null;
for (const n of only ?? []) if (!scenes.some((s) => s.n === n)) throw new Error(`No scene ${n}`);

// Every input must exist before anything is paid for.
const inputs = [config.inputs.drawingsPdf, ...Object.values(config.inputs.photos as Record<string, string>), ...config.inputs.problemPhotos];
const missing = inputs.filter((p: string) => !existsSync(join(repoRoot, p)));
if (missing.length) throw new Error(`Missing input files (edit scripts/demo-video/scenes.json):\n  ${missing.join("\n  ")}`);

/** Scenes to record now: cards when selected (or all), app scenes when selected and (missing or --rerecord). */
const toRecord = scenes.filter((s) => {
  if (only && !only.has(s.n)) return false;
  if (args.fresh || args.rerecord) return true;
  if (s.kind === "card") return true;
  const r = state.recordings[s.n];
  return !r || !existsSync(join(outDir, r.clip));
});
const needsApp = toRecord.some((s) => s.kind !== "card") || toRecord.some((s) => s.id === "results");

const playwright = createRequire(join(repoRoot, "apps", "web", "package.json"))("playwright");
const sharp = createRequire(join(repoRoot, "apps", "api", "package.json"))("sharp");

let apiHandle: ApiHandle | null = null;
let pgReady = false;
const browser = await playwright.chromium.launch();
let mic: any = null;

function spent(): number {
  try {
    return Number(sqlValue("select coalesce(sum(cost_usd),0) from spend_ledger")) || 0;
  } catch {
    return 0;
  }
}
const voiceSeconds = () => Number(state.voiceSeconds ?? 0);
const VOICE_USD_PER_HOUR = 0.18;
const previousSpend = () => readJson<{ previousUsd: number }>(join(outDir, "spend.json"), { previousUsd: 0 }).previousUsd;
const totalSpend = () => previousSpend() + spent() + (voiceSeconds() / 3600) * VOICE_USD_PER_HOUR;

try {
  if (needsApp) {
    if (!dockerReady()) throw new Error("Docker is not running. Start Docker Desktop, then run pnpm demo-video again.");
    console.log("Local stack:");
    const db = await ensureDatabase(config.ports.postgres);
    pgReady = true;
    if (db.fresh) {
      console.log(`  new empty database on 127.0.0.1:${db.port}`);
      state.projects = {};
      state.visits = {};
      saveState();
    }
    const webDist = buildWeb(repoRoot, outDir, args["rebuild-web"]);
    apiHandle = await startApi({ repoRoot, outDir, webDist, pgPort: db.port, preferredPort: config.ports.api, spendCapUsd: config.spendCapUsd, fastPath: config.agentFastPath });
    console.log(`  app on ${apiHandle.base} (AGENT_FAST_PATH=${config.agentFastPath})`);
  }

  const voiceWav = join(repoRoot, config.inputs.voiceWav);
  if (toRecord.some((s) => s.id === "visit1") && !existsSync(voiceWav)) synthesize(config.voiceNoteText, voiceWav, true);

  const ctx: Ctx = {
    base: apiHandle?.base ?? "",
    repoRoot,
    outDir,
    config,
    state,
    saveState,
    browser,
    micBrowser: async () =>
      (mic ??= await playwright.chromium.launch({
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${voiceWav}`],
      })),
    spendGate(estimate, what) {
      const now = totalSpend();
      if (now + estimate > config.spendCapUsd) throw new Error(`Spend cap: $${now.toFixed(2)} spent, ${what} may cost ~$${estimate.toFixed(2)}, cap $${config.spendCapUsd}.`);
    },
  };

  const rasterize = async (pdf: Buffer): Promise<Buffer> => {
    const { rasterizePdf } = await import(pathToImport(join(repoRoot, "apps", "api", "src", "services", "drawings", "rasterize.ts")));
    const pages = await rasterizePdf(pdf, { maxEdge: 1800, maxPages: 40 });
    return pages[0].png;
  };

  for (const s of toRecord) {
    const t = Date.now();
    process.stdout.write(`Scene ${s.n} (${s.id}): recording… `);
    let rec: Recording;
    switch (s.id) {
      case "title":
        rec = await recordCard(ctx, titleCard(), s.slot, "scene-01");
        break;
      case "problem": {
        const thumbs = await Promise.all(
          config.inputs.problemPhotos.map(async (p: string) => `data:image/jpeg;base64,${(await sharp(join(repoRoot, p)).resize(520, 300, { fit: "cover" }).jpeg({ quality: 80 }).toBuffer()).toString("base64")}`),
        );
        rec = await recordCard(ctx, problemCard(thumbs), s.slot, "scene-02");
        break;
      }
      case "drawings":
        rec = await sceneDrawings(ctx);
        break;
      case "visit1":
        rec = await sceneVisit1(ctx);
        state.voiceSeconds = (state.voiceSeconds ?? 0) + 4;
        break;
      case "plinth":
        rec = await scenePlinth(ctx);
        break;
      case "g2":
        rec = await sceneG2(ctx);
        break;
      case "visit2":
        rec = await sceneVisit2(ctx);
        break;
      case "review":
        rec = await sceneReview(ctx, rasterize);
        break;
      case "results":
        rec = await recordCard(ctx, resultsCard(newestHumanReport(join(repoRoot, config.evalDir)), costPerVisit()), s.slot, "scene-09");
        break;
      case "end":
        rec = await recordCard(ctx, endCard(config.links.app, config.links.repo), s.slot, "scene-10");
        break;
      default:
        throw new Error(`unknown scene ${s.id}`);
    }
    state.recordings[s.n] = { ...rec, recordedAt: new Date().toISOString() };
    saveState();
    console.log(`done in ${Math.round((Date.now() - t) / 1000)} s · spend so far $${totalSpend().toFixed(3)}`);
  }

  // ---- voice: one line per scene, fitted (may extend a scene) ----
  const slots = new Map(scenes.map((s) => [s.n, s.slot]));
  let lines: Line[] = [];
  const voiceNotes: string[] = [];
  if (voiceKind !== "none") {
    process.stdout.write(`Voice-over (${voiceKind}, ${config.voice.kokoroVoice})… `);
    const made = [];
    for (const s of scenes) made.push({ n: s.n, text: s.voiceover, ...(await makeLine(outDir, s.n, s.voiceover, { kind: voiceKind, kokoroVoice: config.voice.kokoroVoice, kokoroSpeed: config.voice.kokoroSpeed })) });
    const fit = fitLines(outDir, made, slots);
    lines = fit.lines;
    for (const [n, v] of fit.slots) slots.set(n, v);
    voiceNotes.push(...fit.notes);
    console.log(voiceNotes.length ? voiceNotes.join("; ") : "every line fits its scene");
  }
  const total = [...slots.values()].reduce((a, b) => a + b, 0);
  if (total > 170) throw new Error(`Scenes add up to ${total.toFixed(1)} s with the voice-over; the video must stay ≤ 2:50.`);
  const starts = new Map<number, number>();
  {
    let t = 0;
    for (const s of scenes) {
      starts.set(s.n, t);
      t += slots.get(s.n)!;
    }
  }

  // ---- compose ----
  await makeArt(outDir);
  mkdirSync(join(outDir, "gfx"), { recursive: true });
  const sceneFiles: string[] = [];
  const notRecorded: number[] = [];
  const report: { n: number; id: string; slot: number; content: number; sped: string; extra: string }[] = [];
  const callouts = new Map<number, number>();
  for (const s of scenes) {
    const rec = state.recordings[s.n] as (Recording & { recordedAt?: string; events?: SceneEvents; detections?: SceneDetections | null }) | undefined;
    const file = `scene-${String(s.n).padStart(2, "0")}.mp4`;
    if (!rec || !existsSync(join(outDir, rec.clip))) {
      notRecorded.push(s.n);
      continue;
    }
    const slot = slots.get(s.n)!;
    const duration = probeDuration(join(outDir, rec.clip));
    // Trace data for the agent scenes, cached so re-renders don't need the database.
    const visitKey = ({ plinth: "plinth", g2: "g2", visit2: "v2" } as Record<string, string>)[s.id];
    if (visitKey && state.visits?.[visitKey] && rec.recordedAt && (!rec.events || toRecord.includes(s))) {
      try {
        rec.events = loadEvents(state.visits[visitKey], rec.recordedAt, duration);
        rec.detections = loadDetections(state.visits[visitKey], join(outDir, "storage"));
        saveState();
      } catch {
        // database not running: use what is cached
      }
    }
    const polish = await polishScene({ repoRoot, outDir, browser, scene: { ...s, slot }, marks: rec.marks as Mark[], duration, events: rec.events ?? {}, detections: rec.detections ?? null });
    if (polish.calloutAt != null) callouts.set(s.n, polish.calloutAt);
    const changed = !only || only.has(s.n) || !existsSync(join(outDir, file)) || toRecord.includes(s) || slot !== s.slot;
    if (changed) composeScene({ outDir, clip: rec.clip, out: file, kind: s.kind, plan: polish.plan, slot, zoom: polish.zoom, overlays: polish.overlays });
    state.recordings[s.n].composed = { sped: polish.plan.sped, contentSeconds: polish.plan.total };
    saveState();
    report.push({
      n: s.n,
      id: s.id,
      slot,
      content: polish.plan.total,
      sped: polish.plan.sped.map((x) => `${Math.round(x.speed * 10) / 10}×`).join(", ") || "—",
      extra: [polish.overlays.length ? `${polish.overlays.length} overlay(s)` : "", polish.zoom ? "zoom" : ""].filter(Boolean).join(", "),
    });
    sceneFiles.push(file);
  }

  if (notRecorded.length) {
    console.log(`\nNot recorded yet: scene(s) ${notRecorded.join(", ")}. Composed the others; the final video needs every scene (pnpm demo-video).`);
    process.exitCode = 0;
    throw new SkipFinal();
  }

  // ---- captions (from the real voice timings) + voice-over script ----
  const cues: Cue[] =
    lines.length > 0
      ? voiceCues(lines, starts)
      : scenes.flatMap((s) => {
          const parts = splitForCaptions(s.voiceover);
          const a = starts.get(s.n)! + PAD;
          const b = starts.get(s.n)! + slots.get(s.n)! - PAD;
          const totalChars = parts.reduce((x, p) => x + p.length, 0);
          let t = a;
          return parts.map((p) => {
            const d = (b - a) * (p.length / totalChars);
            const c = { start: t, end: t + d, text: p };
            t += d;
            return c;
          });
        });
  writeSrt(outDir, cues);
  const capFiles: { file: string; start: number; end: number; w: number; h: number }[] = [];
  for (const [i, c] of cues.entries()) {
    const f = `gfx/caption-${String(i + 1).padStart(2, "0")}.png`;
    const size = await renderCaption(browser, c.text, join(outDir, f));
    capFiles.push({ file: f, start: c.start, end: c.end, w: size.width, h: size.height });
  }
  const md: string[] = [
    "# SiteSight demo — voice-over script",
    "",
    `Total ${fmt(total)}. ${lines.length ? `Voice: ${voiceKind} (${config.voice.kokoroVoice}); the times below are the spoken line in the final video.` : "Read each line inside its window."} To use your own voice, record each line to fit its window and mix it over sitesight-demo-silent.mp4.`,
    "",
    "| # | Scene | Scene window | Line spoken | Line |",
    "|---|---|---|---|---|",
  ];
  for (const s of scenes) {
    const a = starts.get(s.n)!;
    const l = lines.find((x) => x.n === s.n);
    const spoken = l ? `${fmt(a + PAD)}–${fmt(a + PAD + l.seconds)}${l.tempo > 1 ? ` (${l.tempo.toFixed(2)}×)` : ""}` : "—";
    md.push(`| ${s.n} | ${s.id} | ${fmt(a)}–${fmt(a + slots.get(s.n)!)} | ${spoken} | ${s.voiceover} |`);
  }
  writeFileSync(join(outDir, "voiceover-script.md"), `${md.join("\n")}\n`);

  // ---- final ----
  const audio = lines.length ? mixVoice(outDir, lines, starts, total) : null;
  process.stdout.write("Rendering… ");
  const out = renderFinal(outDir, sceneFiles, capFiles, audio);
  const duration = probeDuration(join(outDir, out.voiced ?? out.silent));
  console.log(fmt(duration));

  // Review frames: each scene's midpoint, plus its callout moment and two more.
  rmSync(join(outDir, "frames"), { recursive: true, force: true });
  mkdirSync(join(outDir, "frames"), { recursive: true });
  for (const s of scenes) {
    const a = starts.get(s.n)!;
    const len = slots.get(s.n)!;
    const c = callouts.get(s.n);
    const times: [string, number][] = [["mid", len / 2], ...(c != null ? ([["callout", Math.min(len - 0.2, c + 1)]] as [string, number][]) : []), ["a", len * 0.25], ["b", len * 0.85]];
    for (const [tag, t] of times) extractFrame(outDir, out.silent, a + t, `frames/scene-${String(s.n).padStart(2, "0")}-${tag}.png`);
  }

  console.log("\nScenes (slot · recorded content after cuts/speed-up · speed-up · extras):");
  for (const r of report) console.log(`  ${String(r.n).padStart(2)} ${r.id.padEnd(9)} ${r.slot.toFixed(1).padStart(5)} s · ${r.content.toFixed(1)} s · ${r.sped}${r.extra ? ` · ${r.extra}` : ""}${r.content > r.slot + 0.05 ? "  ⚠ over its slot" : ""}`);
  console.log(`\nFinal: ${join(outDir, out.voiced ?? out.silent)} · ${fmt(duration)} · 1920×1080 · 30 fps · H.264${out.voiced ? " · voice-over (loudnorm, target −16 LUFS)" : ""}`);
  console.log(`Silent: ${join(outDir, out.silent)} · Captions: captions.srt · Script: voiceover-script.md · Frames: frames/`);
  console.log(`Meta spend (local ledgers${voiceSeconds() ? " + voice estimate" : ""}, all takes): $${totalSpend().toFixed(3)} of $${config.spendCapUsd} cap`);
} catch (err) {
  if (!(err instanceof SkipFinal)) throw err;
} finally {
  await mic?.close().catch(() => {});
  await browser.close().catch(() => {});
  await apiHandle?.stop();
}
process.exit(0);

function costPerVisit(): number | null {
  const ids = Object.values(state.visits ?? {}).filter((v) => typeof v === "number") as number[];
  if (!ids.length || !pgReady) return state.costPerVisit ?? null;
  try {
    const rows = sqlValue(`select visit_id, sum(cost_usd) from spend_ledger where kind = 'agent_run' and visit_id in (${ids.join(",")}) group by visit_id`)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => Number(l.split("|")[1]));
    if (!rows.length) return state.costPerVisit ?? null;
    state.costPerVisit = rows.reduce((a, b) => a + b, 0) / rows.length;
    saveState();
    return state.costPerVisit;
  } catch {
    return state.costPerVisit ?? null;
  }
}

/** Windows speech synthesis to WAV (16 kHz mono 16-bit for the voice note; default format for the voice-over). */
function synthesize(text: string, wav: string, voiceNote: boolean): void {
  if (process.platform !== "win32") throw new Error("Speech synthesis uses Windows System.Speech; record the WAV yourself and set inputs.voiceWav.");
  mkdirSync(dirname(wav), { recursive: true });
  const ps1 = join(outDir, "speak.ps1");
  writeFileSync(
    ps1,
    `param([string]$Text, [string]$Out, [int]$VoiceNote)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 0
if ($VoiceNote -eq 1) {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile($Out, $fmt)
} else { $s.SetOutputToWaveFile($Out) }
$s.Speak($Text)
$s.Dispose()
`,
  );
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Text", text, "-Out", wav, "-VoiceNote", voiceNote ? "1" : "0"], { stdio: "inherit" });
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function pathToImport(p: string): string {
  return `file:///${p.replace(/\\/g, "/")}`;
}
