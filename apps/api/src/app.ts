import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import express, { Router } from "express";
import cors from "cors";
import { sql as dsql } from "drizzle-orm";
import { env } from "./config.js";
import { db } from "./db/client.js";
import { errorHandler } from "./lib/http.js";
import { requireAuth } from "./lib/auth.js";
import { isAllowedOrigin } from "./lib/origins.js";
import { authRouter } from "./routes/auth.js";
import { spendRouter } from "./routes/spend.js";
import { projectsRouter } from "./routes/projects.js";
import { zonesRouter } from "./routes/zones.js";
import { boqRouter } from "./routes/boq.js";
import { visitsRouter } from "./routes/visits.js";
import { photosRouter } from "./routes/photos.js";
import { askBacksRouter } from "./routes/ask-backs.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { reportsRouter } from "./routes/reports.js";
import { traceRouter } from "./routes/trace.js";
import { storageRouter } from "./routes/storage.js";
import { overlayRouter } from "./routes/overlay.js";
import { drawingsRouter } from "./routes/drawings.js";
import { usingLocalStorage } from "./services/storage.js";

export interface AppOptions {
  /**
   * Built web app (apps/web/dist). When set, the API moves under /api and this folder is served at / with an
   * index.html fallback for client-side routes (one service, one origin). Without it the API is at / (dev, tests).
   */
  webDir?: string | null;
}

async function healthz(_req: express.Request, res: express.Response) {
  try {
    await db.execute(dsql`select 1`);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
}

/** Every API route, with CORS, the write-origin check, body limits and the demo login. */
function apiRouter(): Router {
  const api = Router();
  api.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true }));
  // CORS only hides responses; also refuse state-changing requests from origins we don't serve (CSRF hardening).
  api.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || isAllowedOrigin(req.get("origin"))) return next();
    res.status(403).json({ error: "Origin not allowed" });
  });
  api.use(express.json({ limit: "1mb" }));
  api.get("/healthz", healthz);
  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  api.use(requireAuth);

  for (const r of [
    authRouter,
    spendRouter,
    projectsRouter,
    zonesRouter,
    boqRouter,
    visitsRouter,
    photosRouter,
    askBacksRouter,
    assessmentsRouter,
    reportsRouter,
    traceRouter,
    overlayRouter,
    drawingsRouter,
  ]) {
    api.use(r);
  }
  if (usingLocalStorage()) api.use(storageRouter); // stands in for R2 presigned URLs
  api.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  return api;
}

/** Hashed build assets never change; everything else (index.html, sw.js, manifest) must be revalidated. */
const IMMUTABLE = /^\/assets\/|^\/workbox-[\w-]+\.js$/;

function webApp(webDir: string): Router {
  const web = Router();
  web.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
    next();
  });
  web.use(
    express.static(webDir, {
      index: false,
      setHeaders: (res, path) => {
        const rel = "/" + path.slice(webDir.length).replace(/\\/g, "/").replace(/^\/+/, "");
        res.setHeader("Cache-Control", IMMUTABLE.test(rel) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  // Client-side routes (/, /projects/3, /visits/7/review …) get the app shell. Missing files stay 404.
  web.get(/.*/, (req, res, next) => {
    if (extname(req.path)) return next();
    res.set("Cache-Control", "no-cache").sendFile(join(webDir, "index.html"));
  });
  return web;
}

/** The API (and in production the web app) as an Express app, shared by dev (index.ts), prod.ts and tests. */
export function createApp(opts: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Railway's proxy sits in front: trust one hop for req.ip and secure cookies.
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);

  // Health check for the platform: no auth, checks the database.
  app.get("/healthz", healthz);

  const webDir = opts.webDir && existsSync(join(opts.webDir, "index.html")) ? opts.webDir : null;
  if (opts.webDir && !webDir) throw new Error(`Web build not found: ${join(opts.webDir, "index.html")} (run pnpm --filter @sitesight/web build)`);

  if (webDir) {
    app.use("/api", apiRouter());
    app.use(webApp(webDir));
    app.use((_req, res) => {
      res.status(404).json({ error: "Not found" });
    });
  } else {
    app.use(apiRouter());
  }
  app.use(errorHandler);
  return app;
}
