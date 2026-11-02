/**
 * Voice notes for Meta's ASR endpoint, which accepts only WAV: mono, 16-bit PCM, 16 or 24 kHz.
 * Phones record WebM/Opus or MP4/AAC, so the recording is decoded, downmixed and resampled in the browser.
 */
export const VOICE_SAMPLE_RATE = 16_000;

/** Mono float samples (−1…1) → a RIFF/WAVE file, 16-bit PCM. Pure: no browser APIs. */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

/** Any recording the browser can decode → 16 kHz mono 16-bit WAV. */
export async function toVoiceWav(recording: Blob): Promise<Blob> {
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(await recording.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE); // 1 channel: downmixes
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return new Blob([encodeWav16(rendered.getChannelData(0), VOICE_SAMPLE_RATE)], { type: "audio/wav" });
  } finally {
    void ctx.close();
  }
}
