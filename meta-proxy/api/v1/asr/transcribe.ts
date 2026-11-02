// POST /v1/asr/transcribe → Meta (Muse Voice Transcribe). See lib/forward.ts.
import { forward } from "../../../lib/forward.js";

export function POST(request: Request): Promise<Response> {
  return forward(request, "/asr/transcribe", process.env);
}
