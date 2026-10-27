import { toFile } from "openai";
import { env } from "../config.js";
import { metaClient } from "./client.js";

/**
 * Transcribe a voice note with Muse Voice Transcribe (stretch priority).
 * Assumes the OpenAI-compatible /audio/transcriptions endpoint; verify against the Meta docs.
 */
export async function transcribe(audio: Buffer, filename = "note.webm"): Promise<string> {
  const result = await metaClient().audio.transcriptions.create({
    model: env.VOICE_MODEL,
    file: await toFile(audio, filename),
  });
  return result.text;
}
