import express from "express";
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

/** The API as an Express app (no listening), shared by dev (index.ts), production (prod.ts) and tests. */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Railway (and the Vercel rewrite) sit in front: trust one proxy hop for req.ip and secure cookies.
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);

  // Health check for the platform: no auth, no CORS, checks the database.
  app.get("/healthz", async (_req, res) => {
    try {
      await db.execute(dsql`select 1`);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: "database unavailable" });
    }
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true }));
  // CORS only hides responses; also refuse state-changing requests from origins we don't serve (CSRF hardening).
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || isAllowedOrigin(req.get("origin"))) return next();
    res.status(403).json({ error: "Origin not allowed" });
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(requireAuth);

  app.use(authRouter);
  app.use(spendRouter);
  app.use(projectsRouter);
  app.use(zonesRouter);
  app.use(boqRouter);
  app.use(visitsRouter);
  app.use(photosRouter);
  app.use(askBacksRouter);
  app.use(assessmentsRouter);
  app.use(reportsRouter);
  app.use(traceRouter);
  app.use(overlayRouter);
  app.use(drawingsRouter);
  if (usingLocalStorage()) app.use(storageRouter); // stands in for R2 presigned URLs

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);
  return app;
}
