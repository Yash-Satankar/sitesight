/**
 * Deployment: demo password gate, CSRF/CORS, error responses, the daily spend guard, absolute signed storage URLs,
 * production config checks, and the one-process production entry (API + worker) shutting down cleanly.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Before src/config.ts loads.
  process.env.DEMO_PASSWORD = "site-demo-pass";
  process.env.DAILY_SPEND_CAP_USD = "0.05";
  process.env.WEB_ORIGIN = "https://sitesight.vercel.app";
  process.env.PUBLIC_API_URL = "https://api.sitesight.test/";
});

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  return { db: drizzle(new PGlite(), { schema }), schema, sql: { end: async () => {} } };
});

import express from "express";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { env } from "../src/config.js";
import { db as mockedDb, schema } from "../src/db/client.js";
import { createApp } from "../src/app.js";
import { errorHandler, HttpError } from "../src/lib/http.js";
import { createLoginLimiter, makeSession, passwordMatches, readCookie, SESSION_COOKIE, validSession } from "../src/lib/auth.js";
import { dailySpend, startOfUtcDay } from "../src/lib/spend.js";
import { productionProblems, startProd } from "../src/prod.js";
import { skipAskBack } from "../src/services/ask-backs.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;
const ORIGIN = "https://sitesight.vercel.app";
let base = "";
let close = () => {};
let cookie = "";
const ids: Record<"project" | "zone" | "visit" | "askVisit" | "askBack", number> = { project: 0, zone: 0, visit: 0, askVisit: 0, askBack: 0 };

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.raw !== undefined) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin) headers.Origin = opts.origin;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, headers: res.headers };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
  const [p] = await db.insert(schema.projects).values({ name: "P" }).returning();
  const [z] = await db.insert(schema.zones).values({ projectId: p!.id, name: "GF" }).returning();
  const [v] = await db.insert(schema.visits).values({ projectId: p!.id }).returning();
  await db.insert(schema.photos).values({ visitId: v!.id, zoneId: z!.id, storageKey: "k.jpg", width: 10, height: 10 });
  const [v2] = await db.insert(schema.visits).values({ projectId: p!.id, status: "needs_input" }).returning();
  const [ab] = await db.insert(schema.askBacks).values({ visitId: v2!.id, zoneId: z!.id, instruction: "i", reason: "r" }).returning();
  Object.assign(ids, { project: p!.id, zone: z!.id, visit: v!.id, askVisit: v2!.id, askBack: ab!.id });

  const server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe("demo password gate", () => {
  it("signs sessions that expire and can't be forged", () => {
    const now = Date.now();
    const { value, maxAgeMs } = makeSession(now);
    expect(maxAgeMs).toBe(7 * 24 * 3600 * 1000);
    expect(validSession(value, now)).toBe(true);
    expect(validSession(value, now + maxAgeMs + 1000)).toBe(false);
    const [exp, sig] = value.split(".");
    expect(validSession(`${Number(exp) + 3600}.${sig}`, now)).toBe(false); // extended expiry, old signature
    expect(validSession("garbage", now)).toBe(false);
    expect(passwordMatches("site-demo-pass")).toBe(true);
    expect(passwordMatches("site-demo-pas")).toBe(false);
    expect(passwordMatches(undefined)).toBe(false);
    expect(readCookie("a=1; sitesight_session=abc.def; b=2", SESSION_COOKIE)).toBe("abc.def");
  });

  it("keeps /healthz public and everything else behind the login", async () => {
    expect(await call("GET", "/healthz")).toMatchObject({ status: 200, body: { ok: true } });
    expect(await call("GET", "/projects")).toMatchObject({ status: 401, body: { authRequired: true } });
    expect((await call("GET", "/auth/me")).body).toEqual({ authRequired: true, authenticated: false });
  });

  it("logs in with the password and sets an HttpOnly, SameSite=Lax cookie", async () => {
    expect((await call("POST", "/auth/login", { body: { password: "nope" }, origin: ORIGIN })).status).toBe(401);
    const ok = await call("POST", "/auth/login", { body: { password: "site-demo-pass" }, origin: ORIGIN });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^sitesight_session=\d+\.[\w-]+;/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Max-Age=604800/);
    cookie = setCookie.split(";")[0]!;
    expect((await call("GET", "/projects", { cookie })).status).toBe(200);
    expect((await call("GET", "/auth/me", { cookie })).body).toEqual({ authRequired: true, authenticated: true });
    expect((await call("GET", "/projects", { cookie: `${cookie}x` })).status).toBe(401);
  });

  it("rate-limits failed logins per IP", () => {
    const l = createLoginLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) l.fail("1.2.3.4", 0);
    expect(l.blocked("1.2.3.4", 1)).toBe(true);
    expect(l.blocked("5.6.7.8", 1)).toBe(false);
    expect(l.blocked("1.2.3.4", 60_001)).toBe(false); // window over
  });
});

describe("origins and errors", () => {
  it("allows the web origin with credentials and refuses writes from other origins", async () => {
    const ok = await call("GET", "/projects", { cookie, origin: ORIGIN });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await call("POST", "/projects", { cookie, origin: "https://evil.example", body: { name: "x" } });
    expect(evil).toMatchObject({ status: 403, body: { error: "Origin not allowed" } });
    expect((await call("GET", "/projects", { cookie, origin: "https://evil.example" })).headers.get("access-control-allow-origin")).toBeNull();
    expect((await call("POST", "/projects", { cookie, origin: ORIGIN, body: { name: "From the web" } })).status).toBe(201);
  });

  it("answers bad bodies and unknown routes with short JSON errors, no stack traces", async () => {
    expect(await call("POST", "/projects", { cookie, raw: "{not json" })).toMatchObject({ status: 400, body: { error: "Invalid JSON body" } });
    expect(await call("POST", "/projects", { cookie, raw: JSON.stringify({ name: "x".repeat(1_100_000) }) })).toMatchObject({
      status: 413,
      body: { error: "Request body too large" },
    });
    expect(await call("GET", "/nope", { cookie })).toMatchObject({ status: 404, body: { error: "Not found" } });
  });

  it("hides internal error messages in production", async () => {
    const app = express()
      .get("/boom", () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432 at Pool.connect (/app/node_modules/pg/lib/pool.js:45)");
      })
      .get("/http", () => {
        throw new HttpError(409, "Visit is already running");
      })
      .use(errorHandler);
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const boom = await (await fetch(`${url}/boom`)).json();
      expect(boom).toEqual({ error: "Something went wrong on the server." });
      expect(JSON.stringify(boom)).not.toMatch(/ECONNREFUSED|node_modules/);
      expect(await (await fetch(`${url}/http`)).json()).toMatchObject({ error: "Visit is already running" });
    } finally {
      process.env.NODE_ENV = prev;
      spy.mockRestore();
      server.close();
    }
  });
});

describe("daily spend guard", () => {
  it("sums today's agent runs and drawing imports (UTC day) and refuses new work once the cap is reached", async () => {
    const yesterday = new Date(startOfUtcDay().getTime() - 3600 * 1000);
    await db.insert(schema.agentRuns).values({ visitId: ids.visit, costUsd: 9, startedAt: yesterday }); // not today
    await db.insert(schema.agentRuns).values({ visitId: ids.visit, costUsd: 0.02, status: "finished" });
    expect((await call("GET", "/spend/today", { cookie })).body).toMatchObject({ spentUsd: 0.02, capUsd: 0.05, remainingUsd: 0.03 });

    await db.insert(schema.drawingImports).values({ projectId: ids.project, fileName: "a.pdf", costUsd: 0.03, status: "done" });
    const spend = await dailySpend();
    expect(spend).toMatchObject({ spentUsd: 0.05, remainingUsd: 0 });
    expect(spend.resetsAt).toBe(new Date(startOfUtcDay().getTime() + 86_400_000).toISOString());

    const run = await call("POST", `/visits/${ids.visit}/run`, { cookie, origin: ORIGIN });
    expect(run.status).toBe(429);
    expect(run.body.error).toMatch(/^Today's demo budget \(\$0\.05\) is used up, so new agent runs and drawing imports are paused until midnight UTC/);
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.kind, "agent_run"));
    expect(jobs).toHaveLength(0);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(Buffer.from("%PDF-1.4\n"))], { type: "application/pdf" }), "d.pdf");
    const upload = await fetch(`${base}/projects/${ids.project}/drawings`, { method: "POST", body: form, headers: { Cookie: cookie } });
    expect(upload.status).toBe(429);

    const xlsx = new FormData();
    xlsx.append("file", new Blob([new Uint8Array([1, 2, 3])]), "boq.xlsx");
    expect((await fetch(`${base}/projects/${ids.project}/boq`, { method: "POST", body: xlsx, headers: { Cookie: cookie } })).status).toBe(429);
  });

  it("does not resume a visit after its last photo request when the cap is reached; it stays reviewable", async () => {
    const out = await skipAskBack(ids.askBack);
    expect(out).toMatchObject({ status: "skipped", resumed: false });
    const [v] = await db.select().from(schema.visits).where(eq(schema.visits.id, ids.askVisit));
    expect(v!.status).toBe("assessed");
  });
});

describe("storage URLs and production config", () => {
  it("makes signed storage URLs absolute with PUBLIC_API_URL", async () => {
    vi.resetModules();
    process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "sitesight-storage-"));
    const storage = await import("../src/services/storage.js");
    const url = await storage.presignGet("photos/1/a.jpg");
    expect(url).toMatch(/^https:\/\/api\.sitesight\.test\/storage\/photos\/1\/a\.jpg\?exp=\d+&sig=[\w-]+$/);
    delete process.env.STORAGE_LOCAL_DIR;
    vi.resetModules();
  });

  it("refuses to start production with a broken configuration", () => {
    const good = {
      ...env,
      NODE_ENV: "production" as const,
      DATABASE_URL: "postgres://u:p@db.railway.internal:5432/railway",
      STORAGE_LOCAL_DIR: "/data/storage",
      PUBLIC_API_URL: "https://sitesight-api.up.railway.app",
      WEB_ORIGIN: "https://sitesight.vercel.app",
      ALLOW_LAN_ORIGINS: false,
      META_API_KEY: "k",
      META_BASE_URL: "https://meta.example/v1",
    };
    expect(productionProblems(good)).toEqual([]);
    expect(productionProblems({ ...good, DATABASE_URL: "pglite:memory", PUBLIC_API_URL: "", WEB_ORIGIN: "http://localhost:5173", ALLOW_LAN_ORIGINS: true })).toEqual([
      "DATABASE_URL must point at Postgres",
      "PUBLIC_API_URL is required with local storage (signed URLs must be absolute)",
      "WEB_ORIGIN must be the deployed origin (e.g. https://sitesight-production.up.railway.app)",
      "ALLOW_LAN_ORIGINS must be false in production",
    ]);
    expect(productionProblems({ ...good, PUBLIC_API_URL: "http://api.example" })).toEqual(["PUBLIC_API_URL must be an https:// URL"]);
    expect(productionProblems({ ...good, WEB_ORIGIN: "https://sitesight.up.railway.app/" })).toEqual(["WEB_ORIGIN must be https://<host> with no path or trailing slash"]);
  });

  it("one service: PUBLIC_API_URL must be the web origin + /api", () => {
    const single = {
      ...env,
      NODE_ENV: "production" as const,
      DATABASE_URL: "postgres://u:p@postgres.railway.internal:5432/railway",
      STORAGE_LOCAL_DIR: "/data/storage",
      WEB_ORIGIN: "https://sitesight-production.up.railway.app",
      PUBLIC_API_URL: "https://sitesight-production.up.railway.app/api",
      ALLOW_LAN_ORIGINS: false,
      META_API_KEY: "k",
      META_BASE_URL: "https://meta.example/v1",
    };
    expect(productionProblems(single, { servesWeb: true })).toEqual([]);
    expect(productionProblems({ ...single, PUBLIC_API_URL: "https://sitesight-production.up.railway.app" }, { servesWeb: true })).toEqual([
      "PUBLIC_API_URL must be https://sitesight-production.up.railway.app/api when the API serves the web app (the API lives under /api)",
    ]);
  });
});

describe("one service: the API serves the built web app", () => {
  let web = "";
  let stop = () => {};
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sitesight-web-"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>SiteSight</title><div id=root></div>");
    writeFileSync(join(dir, "assets", "index-Ab12Cd34.js"), "console.log(1)");
    writeFileSync(join(dir, "sw.js"), "self.x=1");
    const server = createApp({ webDir: dir }).listen(0);
    web = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => server.close();
  });
  afterAll(() => stop());

  it("serves the app shell for client routes, with long caching only for hashed assets", async () => {
    for (const path of ["/", "/projects/1", "/visits/7/review"]) {
      const res = await fetch(`${web}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>SiteSight</title>");
    }
    const asset = await fetch(`${web}/assets/index-Ab12Cd34.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(`${web}/sw.js`)).headers.get("cache-control")).toBe("no-cache");
    expect((await fetch(`${web}/assets/missing-123.js`)).status).toBe(404);
  });

  it("puts the API under /api only (no clash with client routes), with the login gate", async () => {
    expect(await (await fetch(`${web}/healthz`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${web}/api/healthz`)).json()).toEqual({ ok: true });
    const anon = await fetch(`${web}/api/projects`);
    expect(anon.status).toBe(401);
    const me = await (await fetch(`${web}/api/auth/me`)).json();
    expect(me).toEqual({ authRequired: true, authenticated: false });
    const projects = await fetch(`${web}/api/projects`, { headers: { Cookie: cookie } });
    expect(projects.status).toBe(200);
    expect(Array.isArray(await projects.json())).toBe(true);
    expect((await fetch(`${web}/api/nope`, { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it("refuses to start without the web build", () => {
    expect(() => createApp({ webDir: join(tmpdir(), "no-such-web-build") })).toThrow(/Web build not found/);
  });
});

describe("production entry: API + worker in one process", () => {
  it("serves, then shuts down cleanly even with a trace stream open", async () => {
    const app = await startProd({ port: 0, migrate: false });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });

    // An SSE trace stream never ends on its own; shutdown must not hang on it.
    const ctrl = new AbortController();
    const stream = await fetch(`${url}/visits/${ids.visit}/trace`, { headers: { Cookie: cookie }, signal: ctrl.signal });
    expect(stream.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    const reader = stream.body!.getReader();
    await reader.read();

    const started = Date.now();
    await app.shutdown();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    await app.shutdown(); // idempotent
    ctrl.abort();
  });
});
