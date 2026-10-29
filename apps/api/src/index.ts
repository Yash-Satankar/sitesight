import express from "express";
import cors from "cors";
import { env } from "./config.js";
import { errorHandler } from "./lib/http.js";
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
import { usingLocalStorage } from "./services/storage.js";
import { isAllowedOrigin } from "./lib/origins.js";

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(projectsRouter);
app.use(zonesRouter);
app.use(boqRouter);
app.use(visitsRouter);
app.use(photosRouter);
app.use(askBacksRouter);
app.use(assessmentsRouter);
app.use(reportsRouter);
app.use(traceRouter);
if (usingLocalStorage()) app.use(storageRouter); // stands in for R2 presigned URLs

app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`SiteSight API on http://localhost:${env.PORT}`);
});
