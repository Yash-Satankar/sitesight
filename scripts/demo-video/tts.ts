// Local text-to-speech for the demo voice-over: Kokoro-82M (Apache-2.0) via kokoro-js, run on this machine.
// The model weights download once from Hugging Face into the local cache.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(join(here, "package.json"));

/** Say things the way we want them said (Kokoro reads text, so spell tricky names out). */
export function speakable(line: string): string {
  return line
    .replace(/\bSiteSight\b/g, "Site Sight")
    .replace(/\bSAM 3\.1\b/g, "Sam three point one")
    .replace(/\bBOQ\b/g, "B O Q")
    .replace(/\bMuse Spark\b/g, "Muse Spark")
    .replace(/ — /g, ", ");
}

let tts: any = null;

export async function kokoroToWav(text: string, voice: string, out: string, speed = 1): Promise<void> {
  if (!tts) {
    const { KokoroTTS } = await import(pathToFileURL(localRequire.resolve("kokoro-js")).href);
    tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
  }
  const audio = await tts.generate(speakable(text), { voice, speed });
  await audio.save(out);
}
