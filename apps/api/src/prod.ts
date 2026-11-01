/**
 * Production entry (Railway): run migrations, then the API and the worker in ONE process, so both use the same
 * storage volume (STORAGE_LOCAL_DIR). SIGTERM/SIGINT: stop accepting requests, let the current job finish, close
 * open streams and the database, exit. A hard timeout stops a stuck shutdown.
 *
 *   pnpm start:prod
 */
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { env } from "./config.js";

const SHUTDOWN_TIMEOUT_MS = 25_000; // Railway sends SIGKILL ~30 s after SIGTERM by default

export async function runMigrations(databaseUrl: string): Promise<void> {
  // Its own short-lived connection: migrations finish before the app's pool opens.
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL("./db/migrations", import.meta.url)) });
  } finally {
    await sql.end();
  }
}

/** Where the built web app is: WEB_DIST_DIR, else apps/web/dist in this repo. */
export function webDistDir(e: typeof env): string {
  return e.WEB_DIST_DIR || fileURLToPath(new URL("../../web/dist", import.meta.url));
}

/**
 * Production sanity checks: refuse to start in a configuration that would break the deployed demo.
 * One service (servesWeb): the web app is at WEB_ORIGIN and the API under WEB_ORIGIN/api, so PUBLIC_API_URL must be
 * "<WEB_ORIGIN>/api" for signed storage URLs to reach the API.
 */
export function productionProblems(e: typeof env, opts: { servesWeb?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (!e.DATABASE_URL || e.DATABASE_URL.startsWith("pglite:")) problems.push("DATABASE_URL must point at Postgres");
  if (!e.STORAGE_LOCAL_DIR && !(e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY)) {
    problems.push("set STORAGE_LOCAL_DIR to the mounted volume (e.g. /data/storage), or R2 credentials");
  }
  if (e.STORAGE_LOCAL_DIR && !e.PUBLIC_API_URL) problems.push("PUBLIC_API_URL is required with local storage (signed URLs must be absolute)");
  if (e.PUBLIC_API_URL && !/^https:\/\//.test(e.PUBLIC_API_URL)) problems.push("PUBLIC_API_URL must be an https:// URL");
  const origins = e.WEB_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
  if (!origins.length || origins.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
    problems.push("WEB_ORIGIN must be the deployed origin (e.g. https://sitesight-production.up.railway.app)");
  } else if (origins.some((o) => !/^https:\/\/[^/]+$/.test(o))) {
    problems.push("WEB_ORIGIN must be https://<host> with no path or trailing slash");
  }
  if (opts.servesWeb && e.PUBLIC_API_URL && origins.length && !origins.some((o) => e.PUBLIC_API_URL === `${o}/api`)) {
    problems.push(`PUBLIC_API_URL must be ${origins[0]}/api when the API serves the web app (the API lives under /api)`);
  }
  if (e.ALLOW_LAN_ORIGINS) problems.push("ALLOW_LAN_ORIGINS must be false in production");
  if (!e.META_API_KEY || !e.META_BASE_URL) problems.push("META_API_KEY and META_BASE_URL must be set");
  return problems;
}

async function main() {
  if (env.NODE_ENV === "production") {
    const problems = productionProblems(env, { servesWeb: true });
    if (problems.length) {
      console.error(`Refusing to start:\n  - ${problems.join("\n  - ")}`);
      process.exit(1);
    }
  }
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const app = await startProd({ port: env.PORT, migrate: true, webDir: webDistDir(env) });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`[prod] ${sig}: shutting down`);
      const timer = setTimeout(() => {
        console.error("[prod] shutdown timed out; exiting");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      void app.shutdown().then(() => {
        console.log("[prod] bye");
        process.exit(0);
      });
    });
  }
}

export interface ProdHandle {
  server: Server;
  /** Stop accepting requests, finish the current job, close streams and the database. Idempotent. */
  shutdown(): Promise<void>;
}

/** Migrations (Postgres only; PGlite migrates itself), then the API and the worker in this process. */
export async function startProd(opts: { port: number; migrate: boolean; webDir?: string | null }): Promise<ProdHandle> {
  if (opts.migrate && !env.DATABASE_URL.startsWith("pglite:")) {
    console.log("[prod] running migrations…");
    await runMigrations(env.DATABASE_URL);
    console.log("[prod] migrations done");
  }
  // Imported after migrating: these open the app's database pool.
  const { createApp } = await import("./app.js");
  const { startWorker } = await import("./worker/loop.js");
  const { sql } = await import("./db/client.js");

  const server: Server = await new Promise((resolve) => {
    const s = createApp({ webDir: opts.webDir }).listen(opts.port, () => {
      console.log(`[prod] API on :${(s.address() as { port: number }).port}`);
      resolve(s);
    });
  });
  const worker = startWorker();

  let stopping: Promise<void> | null = null;
  const shutdown = () =>
    (stopping ??= (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await worker.stop(); // the job in progress finishes first
      server.closeAllConnections(); // SSE trace streams never end on their own
      await closed;
      await sql.end();
    })());
  return { server, shutdown };
}

// Only when run directly (tests import the helpers).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("[prod] failed to start:", err);
    process.exit(1);
  });
}
