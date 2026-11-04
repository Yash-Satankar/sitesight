// Voice-over: one audio file per line, fitted to its scene, mixed to −16 LUFS; captions follow the real audio.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FFMPEG, ffmpeg, probeDuration, type Cue } from "./media.js";
import { kokoroToWav } from "./tts.js";

export type VoiceKind = "meta" | "kokoro" | "piper" | "none";

export interface VoiceConfig {
  kind: VoiceKind;
  kokoroVoice: string;
  kokoroSpeed: number;
}

/** Silence kept before and after each line inside its scene. */
export const PAD = 0.3;
export const MAX_TEMPO = 1.1;

export function assertVoiceAvailable(kind: VoiceKind): void {
  if (kind === "meta") {
    throw new Error(
      "--voice meta: Meta's Model API has no text-to-speech model (the docs: Muse Voice Transcribe is speech-to-text only; /v1/models lists no TTS model). Use --voice kokoro.",
    );
  }
  if (kind === "piper") {
    throw new Error("--voice piper is not set up (Kokoro is installed and preferred). Use --voice kokoro or --voice none.");
  }
}

export interface Line {
  n: number;
  text: string;
  file: string; // relative to outDir (processed: trimmed, tempo, 48 kHz mono)
  seconds: number;
  tempo: number;
}

/** Generate (cached by text + voice + speed) and trim one line; returns the processed file and its duration. */
export async function makeLine(outDir: string, n: number, text: string, cfg: VoiceConfig): Promise<{ raw: string; seconds: number }> {
  mkdirSync(join(outDir, "voice"), { recursive: true });
  const key = createHash("sha1").update(`${cfg.kind}|${cfg.kokoroVoice}|${cfg.kokoroSpeed}|${text}`).digest("hex").slice(0, 10);
  const raw = `voice/line-${String(n).padStart(2, "0")}-${key}.wav`;
  const trimmed = `voice/line-${String(n).padStart(2, "0")}-${key}.trim.wav`;
  if (!existsSync(join(outDir, raw))) await kokoroToWav(text, cfg.kokoroVoice, join(outDir, raw), cfg.kokoroSpeed);
  if (!existsSync(join(outDir, trimmed))) {
    // Trim leading/trailing silence only (pauses inside the line stay natural).
    ffmpeg(
      ["-i", raw, "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse", "-ar", "48000", "-ac", "1", trimmed],
      outDir,
    );
  }
  return { raw: trimmed, seconds: probeDuration(join(outDir, trimmed)) };
}

/**
 * Fit each line into its scene: if it runs long, shorten long internal pauses, then speed up to 1.1×; if it still
 * doesn't fit, the scene gets longer. Returns the final lines and the (possibly extended) slots.
 */
export function fitLines(
  outDir: string,
  made: { n: number; text: string; raw: string; seconds: number }[],
  slots: Map<number, number>,
): { lines: Line[]; slots: Map<number, number>; notes: string[] } {
  const out = new Map(slots);
  const notes: string[] = [];
  const lines: Line[] = [];
  for (const m of made) {
    const room = (out.get(m.n) ?? 0) - 2 * PAD;
    let file = m.raw;
    let seconds = m.seconds;
    let tempo = 1;
    if (seconds > room) {
      // 1) shorten internal pauses longer than 0.35 s
      const tight = m.raw.replace(/\.trim\.wav$/, ".tight.wav");
      ffmpeg(["-i", m.raw, "-af", "silenceremove=stop_periods=-1:stop_threshold=-45dB:stop_duration=0.35:stop_silence=0.25", tight], outDir);
      file = tight;
      seconds = probeDuration(join(outDir, tight));
    }
    if (seconds > room) {
      // 2) up to 1.1× faster
      tempo = Math.min(MAX_TEMPO, seconds / room);
      const fast = file.replace(/\.wav$/, `.x${tempo.toFixed(3)}.wav`);
      ffmpeg(["-i", file, "-af", `atempo=${tempo.toFixed(4)}`, fast], outDir);
      file = fast;
      seconds = probeDuration(join(outDir, fast));
      notes.push(`line ${m.n}: ${tempo.toFixed(2)}× to fit`);
    }
    if (seconds > room) {
      // 3) extend the scene rather than rush
      const need = Math.ceil((seconds + 2 * PAD) * 10) / 10;
      notes.push(`scene ${m.n}: extended from ${out.get(m.n)} s to ${need} s for its line`);
      out.set(m.n, need);
    }
    lines.push({ n: m.n, text: m.text, file, seconds, tempo });
  }
  return { lines, slots: out, notes };
}

/** One mono track the length of the video: each line at its scene start + PAD, normalised to −16 LUFS. */
export function mixVoice(outDir: string, lines: Line[], starts: Map<number, number>, total: number): string {
  const inputs: string[] = [];
  const parts: string[] = [];
  lines.forEach((l, i) => {
    const at = Math.round(((starts.get(l.n) ?? 0) + PAD) * 1000);
    inputs.push("-i", l.file);
    parts.push(`[${i}:a]aresample=48000,adelay=${at}|${at}[a${i}]`);
  });
  const mix = `${parts.join(";")};${lines.map((_, i) => `[a${i}]`).join("")}amix=inputs=${lines.length}:normalize=0,apad=whole_dur=${total}[out]`;
  ffmpeg([...inputs, "-filter_complex", mix, "-map", "[out]", "-ar", "48000", "-ac", "1", "-t", total.toFixed(2), "voiceover.premix.wav"], outDir);
  // Two-pass loudnorm (a single pass undershoots on a track that is mostly silence): measure, then apply.
  let measured: Record<string, string> = {};
  const probe = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", "voiceover.premix.wav", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { cwd: outDir, encoding: "utf8" });
  const json = /\{[\s\S]*\}/.exec(probe.stderr ?? "")?.[0];
  if (json) measured = JSON.parse(json);
  const second = measured.input_i
    ? `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
    : "loudnorm=I=-16:TP=-1.5:LRA=11";
  ffmpeg(["-i", "voiceover.premix.wav", "-af", `${second},aresample=48000`, "-ar", "48000", "-ac", "1", "voiceover.wav"], outDir);
  return "voiceover.wav";
}

/** Captions from the real audio: each line's cues span exactly its spoken time, split by sentence and length. */
export function voiceCues(lines: Line[], starts: Map<number, number>): Cue[] {
  const cues: Cue[] = [];
  for (const l of lines) {
    const s = (starts.get(l.n) ?? 0) + PAD;
    const e = s + l.seconds;
    const parts = splitForCaptions(l.text);
    const total = parts.reduce((a, p) => a + p.length, 0);
    let t = s;
    for (const p of parts) {
      const d = (e - s) * (p.length / total);
      cues.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }
  return cues;
}

/** Sentences, and long sentences split at their dash; each cue ≤ ~60 characters where possible. */
export function splitForCaptions(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    if (sentence.length <= 64) {
      out.push(sentence);
      continue;
    }
    const halves = sentence.split(/\s+—\s+/);
    if (halves.length === 2) {
      out.push(`${halves[0]} —`, halves[1]!); // keep the dash on its line
      continue;
    }
    // split at the comma or space closest to the middle
    const mid = sentence.length / 2;
    let cut = sentence.lastIndexOf(", ", mid + 10);
    if (cut < mid - 20) cut = sentence.indexOf(" ", mid);
    out.push(sentence.slice(0, cut + (sentence[cut] === "," ? 1 : 0)).trim(), sentence.slice(cut + 1).trim());
  }
  return out;
}

export function writeSrt(outDir: string, cues: Cue[]): void {
  const t = (x: number) => {
    const ms = Math.round(x * 1000);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
  };
  writeFileSync(join(outDir, "captions.srt"), cues.map((c, i) => `${i + 1}\n${t(c.start)} --> ${t(c.end)}\n${c.text}\n`).join("\n"));
}
