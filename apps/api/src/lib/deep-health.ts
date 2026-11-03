/**
 * GET /healthz?deep=1: one tiny Spark call through META_BASE_URL (the Vercel proxy in production), to check the whole
 * Meta path before a demo. Login required. Reports status and latency only: no keys, no URLs, no upstream bodies.
 */
import { env } from "../config.js";
import { metaClient } from "../meta/client.js";
import { estimateCost, type SparkResponse } from "../meta/spark.js";
import { recordSpend } from "../meta/cost.js";
import { overDailyCap } from "./spend.js";

export interface DeepHealth {
  ok: boolean;
  spark: { ok: boolean; latencyMs: number; model: string; via: "proxy" | "direct"; error?: string };
  checkedAt: string;
}

const CACHE_MS = 10_000;
let last: { at: number; result: DeepHealth } | null = null;
let inFlight: Promise<DeepHealth> | null = null;

type Create = (body: Record<string, unknown>, opts: { timeout: number; maxRetries: number }) => Promise<SparkResponse>;

/** Results are reused for 10 s and concurrent checks share one call, so reloading the URL can't run up spend. */
export function deepHealth(create: Create = defaultCreate, now = Date.now): Promise<DeepHealth> {
  if (last && now() - last.at < CACHE_MS) return Promise.resolve(last.result);
  inFlight ??= check(create, now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function resetDeepHealthCache() {
  last = null;
}

function defaultCreate(body: Record<string, unknown>, opts: { timeout: number; maxRetries: number }) {
  return metaClient().responses.create(body as never, opts) as Promise<SparkResponse>;
}

async function check(create: Create, now: () => number): Promise<DeepHealth> {
  const via = env.META_PROXY_SECRET ? "proxy" : "direct";
  const base = { latencyMs: 0, model: env.SPARK_MODEL, via } as const;
  let spark: DeepHealth["spark"];
  if (await overDailyCap()) {
    spark = { ...base, ok: false, error: "daily spend cap reached; check skipped" };
  } else {
    const started = now();
    try {
      const resp = await create({ model: env.SPARK_MODEL, input: "Reply with the single word OK." }, { timeout: 30_000, maxRetries: 0 });
      const latencyMs = Math.round(now() - started);
      await recordSpend({ kind: "health_check", costUsd: estimateCost(resp).costUsd }).catch(() => {});
      spark = resp.status === "completed" ? { ...base, ok: true, latencyMs } : { ...base, ok: false, latencyMs, error: `response status ${resp.status}` };
    } catch (err) {
      spark = { ...base, ok: false, latencyMs: Math.round(now() - started), error: describe(err) };
    }
  }
  const result: DeepHealth = { ok: spark.ok, spark, checkedAt: new Date().toISOString() };
  last = { at: now(), result };
  return result;
}

/** Status code and error code only: upstream messages could echo request details. */
function describe(err: unknown): string {
  const e = err as { status?: number; code?: string; name?: string };
  if (e?.name === "APIConnectionTimeoutError") return "timed out after 30 s";
  if (typeof e?.status === "number") return `HTTP ${e.status}${e.code ? ` (${e.code})` : ""}`;
  if (e?.name === "APIConnectionError") return "could not connect";
  return "request failed";
}
