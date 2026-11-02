// POST /v1/responses → Meta (Muse Spark, SAM 3.1). See lib/forward.ts.
import { forward } from "../../lib/forward.js";

export function POST(request: Request): Promise<Response> {
  return forward(request, "/responses", process.env);
}
