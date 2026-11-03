/**
 * Before the demo recording: GET /healthz?deep=1 (login required, one tiny Spark call, no secrets in the answer)
 * and the 4 MB voice-note cap when a photo is registered (covers R2 uploads that skip our storage route).
 */
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "sitesight-storage-"));
  process.env.DEMO_PASSWORD = "site-demo-pass";
  process.env.DAILY_SPEND_CAP_USD = "5";
  process.env.WEB_ORIGIN = "https://sitesight.test";
  process.env.META_API_KEY = "meta-key-must-not-leak";
  process.env.META_PROXY_SECRET = "proxy-secret-must-not-leak";
  process.env.META_BASE_URL = "https://proxy.example/v1";
});

const create = vi.hoisted(() => vi.fn());
vi.mock("../src/meta/client.js", () => ({ metaClient: () => ({ responses: { create } }) }));
vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});

import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { createApp } from "../src/app.js";
import { makeSession, SESSION_COOKIE } from "../src/lib/auth.js";
import { resetDeepHealthCache } from "../src/lib/deep-health.js";
import { getObject, putObject } from "../src/services/storage.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
const ORIGIN = "https://sitesight.test";
const cookie = `${SESSION_COOKIE}=${makeSession().value}`;
let base = "";
let close = () => {};
const ids = { zone: 0, visit: 0 };

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
  const [p] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [z] = await db.insert(schema.zones).values({ projectId: p!.id, name: "GF" }).returning();
  const [v] = await db.insert(schema.visits).values({ projectId: p!.id }).returning();
  Object.assign(ids, { zone: z!.id, visit: v!.id });
  const server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());
beforeEach(() => {
  create.mockReset();
  resetDeepHealthCache();
});

const okResponse = { status: "completed", output_text: "OK", output: [], usage: { input_tokens: 12, output_tokens: 30 } };

describe("GET /healthz?deep=1", () => {
  it("needs the login; the plain /healthz stays public and makes no model call", async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    const res = await fetch(`${base}/healthz?deep=1`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ authRequired: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("makes one tiny Spark call and reports ok and latency, logged as health_check spend, no secrets", async () => {
    create.mockResolvedValue(okResponse);
    const res = await fetch(`${base}/healthz?deep=1`, { headers: { Cookie: cookie } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, db: { ok: true }, spark: { ok: true, model: "muse-spark-1.3", via: "proxy" } });
    expect(typeof body.spark.latencyMs).toBe("number");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({ timeout: 30_000, maxRetries: 0 });
    for (const secret of ["meta-key-must-not-leak", "proxy-secret-must-not-leak", "proxy.example"]) expect(text).not.toContain(secret);
    const rows = (await db.select().from(schema.spendLedger)).filter((r) => r.kind === "health_check");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
  });

  it("reuses a result for 10 s, so reloading can't run up spend", async () => {
    create.mockResolvedValue(okResponse);
    await Promise.all([1, 2, 3].map(() => fetch(`${base}/healthz?deep=1`, { headers: { Cookie: cookie } })));
    await fetch(`${base}/healthz?deep=1`, { headers: { Cookie: cookie } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with only the status and error code when Meta fails", async () => {
    create.mockRejectedValue(Object.assign(new Error("upstream said Bearer meta-key-must-not-leak"), { status: 404, code: "model_not_found" }));
    const res = await fetch(`${base}/healthz?deep=1`, { headers: { Cookie: cookie } });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ ok: false, spark: { ok: false, error: "HTTP 404 (model_not_found)" } });
    expect(text).not.toContain("meta-key-must-not-leak");
  });
});

describe("voice notes over 4 MB", () => {
  it("are refused (and deleted) when the photo is registered", async () => {
    const key = `visits/${ids.visit}/voice/long.wav`;
    await putObject(key, Buffer.alloc(4 * 1024 * 1024 + 1), "audio/wav");
    const res = await fetch(`${base}/visits/${ids.visit}/photos`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ zoneId: ids.zone, storageKey: `visits/${ids.visit}/photos/a.jpg`, voiceNoteKey: key }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("Voice note too large (4.0 MB). The limit is 4 MB: record a note under 60 seconds.");
    await expect(getObject(key)).rejects.toThrow();
  });
});
