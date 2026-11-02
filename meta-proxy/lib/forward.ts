/**
 * Minimal Meta Model API proxy (Vercel, pinned to bom1/Mumbai). Meta returns `model_not_found` for requests coming
 * from Railway's network, so the SiteSight API sends its model calls here instead.
 *
 * - Only POST /v1/responses (Muse Spark and SAM 3.1) and POST /v1/asr/transcribe (Muse Voice) are forwarded.
 * - Every request must carry `X-Meta-Proxy-Secret: <META_PROXY_SECRET>`; anything else is refused.
 * - The real META_API_KEY lives only here and replaces whatever Authorization the caller sent.
 * - Bodies are capped (Vercel's limit is 4.5 MB) and never logged.
 */
import { timingSafeEqual } from "node:crypto";

export const META_UPSTREAM = "https://api.meta.ai/v1";
export const MAX_BODY_BYTES = 4_400_000;
export const ALLOWED_PATHS = ["/responses", "/asr/transcribe"] as const;
export type AllowedPath = (typeof ALLOWED_PATHS)[number];

export interface ProxyEnv {
  META_API_KEY?: string;
  META_PROXY_SECRET?: string;
}

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error: { message: error, type: "proxy_error" } }), { status, headers: { "content-type": "application/json" } });

function secretOk(given: string | null, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function forward(request: Request, path: AllowedPath, env: ProxyEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (!env.META_API_KEY || !env.META_PROXY_SECRET) return json(500, "proxy not configured");
  if (request.method !== "POST") return json(405, "method not allowed");
  if (!ALLOWED_PATHS.includes(path)) return json(404, "not found");
  if (!secretOk(request.headers.get("x-meta-proxy-secret"), env.META_PROXY_SECRET)) return json(401, "unauthorized");

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, "request body too large");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return json(413, "request body too large");

  const upstream = await fetchImpl(`${META_UPSTREAM}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.META_API_KEY}`,
      // Keep the caller's content type (multipart boundary for voice) and Accept.
      "Content-Type": request.headers.get("content-type") ?? "application/json",
      Accept: request.headers.get("accept") ?? "application/json",
    },
    body,
  });
  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  for (const h of ["x-request-id", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "retry-after"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
