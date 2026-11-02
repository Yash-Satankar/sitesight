import { env } from "../config.js";

/**
 * Muse Voice Transcribe over Meta's ASR endpoint (not OpenAI's /audio/transcriptions):
 *   POST {META_BASE_URL}/asr/transcribe, multipart: `request` (JSON: model, audioEncoding, mode) + `audio` (the file).
 * The endpoint accepts RIFF/WAVE, mono, 16-bit PCM at 16 or 24 kHz; the web app converts recordings to that before
 * upload. Response: { transcript, audioDurationMs, ... }. Docs: https://dev.meta.ai/docs/api-reference/voice/transcribe
 */
export class VoiceFormatError extends Error {}

/** Problem with a WAV buffer for the ASR endpoint, or null when it is mono 16-bit PCM at 16/24 kHz. */
export function wavProblem(audio: Buffer): string | null {
  if (audio.length < 44 || audio.subarray(0, 4).toString("latin1") !== "RIFF" || audio.subarray(8, 12).toString("latin1") !== "WAVE") {
    return "not a WAV file (expected RIFF/WAVE)";
  }
  const format = audio.readUInt16LE(20);
  const channels = audio.readUInt16LE(22);
  const rate = audio.readUInt32LE(24);
  const bits = audio.readUInt16LE(34);
  if (format !== 1) return `WAV must be PCM (format 1), got format ${format}`;
  if (channels !== 1) return `WAV must be mono, got ${channels} channels`;
  if (bits !== 16) return `WAV must be 16-bit, got ${bits}-bit`;
  if (rate !== 16000 && rate !== 24000) return `WAV must be 16 or 24 kHz, got ${rate} Hz`;
  return null;
}

export async function transcribe(audio: Buffer, filename = "note.wav"): Promise<string> {
  const problem = wavProblem(audio);
  if (problem) throw new VoiceFormatError(`Voice note can't be transcribed: ${problem}`);
  if (!env.META_API_KEY || !env.META_BASE_URL) throw new Error("META_API_KEY and META_BASE_URL must be set");

  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({ model: env.VOICE_MODEL, audioEncoding: "WAV", mode: "PUSH_TO_TALK" })], { type: "application/json" }));
  form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), filename);
  const res = await fetch(`${env.META_BASE_URL.replace(/\/+$/, "")}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.META_API_KEY}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Voice transcription failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { transcript?: unknown };
  if (typeof body.transcript !== "string") throw new Error("Voice transcription returned no transcript");
  return body.transcript.trim();
}
