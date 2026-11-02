/** The Vercel Meta proxy (meta-proxy/lib/forward.ts) and the API sending its shared secret. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.META_PROXY_SECRET = "proxy-secret-for-tests";
});

import { forward, MAX_BODY_BYTES, META_UPSTREAM } from "../../../meta-proxy/lib/forward.js";
import { metaClient } from "../src/meta/client.js";
import { transcribe } from "../src/meta/voice.js";
import { encodeWav16 } from "../../web/src/lib/wav.js";

const ENV = { META_API_KEY: "real-meta-key", META_PROXY_SECRET: "s3cret" };
const req = (init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}) =>
  new Request("https://proxy.example/v1/responses", { method: init.method ?? "POST", headers: init.headers, body: init.body });

afterEach(() => vi.unstubAllGlobals());

describe("meta proxy: forward()", () => {
  it("refuses when not configured, wrong method, missing or wrong secret, and oversized bodies", async () => {
    const upstream = vi.fn();
    expect((await forward(req({ body: "{}" }), "/responses", {}, upstream)).status).toBe(500);
    expect((await forward(req({ method: "GET" }), "/responses", ENV, upstream)).status).toBe(405);
    expect((await forward(req({ body: "{}" }), "/responses", ENV, upstream)).status).toBe(401);
    expect((await forward(req({ body: "{}", headers: { "x-meta-proxy-secret": "nope" } }), "/responses", ENV, upstream)).status).toBe(401);
    const big = new Uint8Array(MAX_BODY_BYTES + 1);
    const res = await forward(req({ body: big, headers: { "x-meta-proxy-secret": "s3cret" } }), "/responses", ENV, upstream);
    expect(res.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards with the proxy's own key, keeps the content type, drops the secret, returns Meta's answer and request id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const upstream = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"error":{"code":"model_not_found"}}', { status: 404, headers: { "content-type": "application/json", "x-request-id": "rid-123", "set-cookie": "x=1" } });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log");
    const res = await forward(
      req({ body: '{"model":"muse-spark-1.3"}', headers: { "x-meta-proxy-secret": "s3cret", authorization: "Bearer caller-key", "content-type": "multipart/form-data; boundary=abc" } }),
      "/asr/transcribe",
      ENV,
      upstream,
    );
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${META_UPSTREAM}/asr/transcribe`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer real-meta-key");
    expect(headers["Content-Type"]).toBe("multipart/form-data; boundary=abc");
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("x-meta-proxy-secret");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"model":"muse-spark-1.3"}');
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe("rid-123");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe('{"error":{"code":"model_not_found"}}');
    expect(log).not.toHaveBeenCalled(); // bodies are never logged
    log.mockRestore();
  });
});

describe("API → proxy", () => {
  it("the Meta client and the voice upload send X-Meta-Proxy-Secret", async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      seen.push(h.get("x-meta-proxy-secret"));
      const url = String(input instanceof Request ? input.url : input);
      const body = url.endsWith("/asr/transcribe")
        ? { transcript: "ok" }
        : { id: "r", object: "response", status: "completed", output: [], output_text: "OK", usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await metaClient().responses.create({ model: "muse-spark-1.3", input: "hi" });
    await transcribe(Buffer.from(encodeWav16(new Float32Array(1600), 16000)));
    expect(seen).toEqual(["proxy-secret-for-tests", "proxy-secret-for-tests"]);
  });
});
