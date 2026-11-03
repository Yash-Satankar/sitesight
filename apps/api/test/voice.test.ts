/** Muse Voice Transcribe: Meta's /asr/transcribe request shape, WAV checks, and the browser-side WAV encoder. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribe, VoiceFormatError, wavProblem } from "../src/meta/voice.js";
import { encodeWav16, VOICE_SAMPLE_RATE } from "../../web/src/lib/wav.js";

const tone = (seconds: number, rate = VOICE_SAMPLE_RATE) => {
  const s = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < s.length; i++) s[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return s;
};

afterEach(() => vi.unstubAllGlobals());

describe("encodeWav16 (web) → wavProblem (api)", () => {
  it("produces mono 16-bit PCM WAV at 16 kHz that the ASR endpoint accepts", () => {
    const wav = Buffer.from(encodeWav16(tone(1), VOICE_SAMPLE_RATE));
    expect(wav.length).toBe(44 + 16000 * 2);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wavProblem(wav)).toBeNull();
    // Samples are clipped to the 16-bit range, not wrapped.
    const loud = Buffer.from(encodeWav16(new Float32Array([2, -2]), 16000));
    expect([loud.readInt16LE(44), loud.readInt16LE(46)]).toEqual([32767, -32768]);
  });

  it("rejects formats the endpoint refuses, before any call", () => {
    expect(wavProblem(Buffer.from("not audio at all, definitely more than forty-four bytes long"))).toBe("not a WAV file (expected RIFF/WAVE)");
    expect(wavProblem(Buffer.from(encodeWav16(tone(0.1, 22050), 22050)))).toBe("WAV must be 16 or 24 kHz, got 22050 Hz");
    const stereo = Buffer.from(encodeWav16(tone(0.1), 16000));
    stereo.writeUInt16LE(2, 22);
    expect(wavProblem(stereo)).toBe("WAV must be mono, got 2 channels");
  });
});

describe("transcribe", () => {
  it("posts multipart request JSON + audio to {META_BASE_URL}/asr/transcribe and returns the transcript", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ sessionId: "s", transcript: " slab reinforcement is complete. ", audioDurationMs: 6160, turns: [] }), { status: 200 });
    });
    const text = await transcribe(Buffer.from(encodeWav16(tone(0.5), 16000)), "note.wav");
    expect(text).toBe("slab reinforcement is complete.");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("http://meta.test/v1/asr/transcribe");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const form = init.body as FormData;
    const request = JSON.parse(await (form.get("request") as Blob).text());
    expect(request).toEqual({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK" });
    const audio = form.get("audio") as File;
    expect(audio.type).toBe("audio/wav");
    expect(audio.name).toBe("note.wav");
  });

  it("refuses non-WAV audio without calling Meta, and reports HTTP errors", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(transcribe(Buffer.alloc(100), "note.webm")).rejects.toBeInstanceOf(VoiceFormatError);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Over 4 MB (about 2 minutes at 16 kHz): refused before the call, even when the WAV header is fine.
    const long = Buffer.from(encodeWav16(new Float32Array(2_100_001), 16000));
    await expect(transcribe(long)).rejects.toThrow(/^Voice note too large \(4\.0 MB\)\. The limit is 4 MB/);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", async () => new Response('{"type":"invalid_request"}', { status: 400 }));
    await expect(transcribe(Buffer.from(encodeWav16(tone(0.2), 16000)))).rejects.toThrow('Voice transcription failed: HTTP 400 {"type":"invalid_request"}');
  });
});
