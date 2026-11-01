import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

// .env lives in the repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const Env = z.object({
  // Meta Model API. Optional at boot so the API can start without keys; meta/ throws on use.
  META_API_KEY: z.string().default(""),
  META_BASE_URL: z.string().default(""),
  SPARK_MODEL: z.string().default("muse-spark-1.3"),
  SAM_MODEL: z.string().default("sam-3.1"),
  VOICE_MODEL: z.string().default("muse-voice-transcribe-1.0"),
  // Prices drive the per-visit cost cap. Validated below; startup fails unless each is > 0.
  SPARK_INPUT_USD_PER_MTOK: z.string().default(""),
  SPARK_OUTPUT_USD_PER_MTOK: z.string().default(""),
  SAM_USD_PER_IMAGE: z.string().default(""),

  // Agent tunables
  MAX_AGENT_STEPS: z.coerce.number().int().positive().default(30), // model turns per run (tool calls do not count)
  MAX_COST_PER_VISIT_USD: z.coerce.number().positive().default(1.5),
  ASK_BACK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  MAX_IMAGE_EDGE_PX: z.coerce.number().int().positive().default(1600),
  VISUAL_ONLY_MAX_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  SAM_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3), // parallel SAM requests per segment() call
  MAX_IMAGES_IN_CONTEXT: z.coerce.number().int().min(1).default(3), // images kept in the agent conversation (oldest dropped)

  // BOQ from drawings
  MAX_COST_PER_DRAWING_IMPORT_USD: z.coerce.number().positive().default(1.0),
  DRAWING_MAX_PAGES: z.coerce.number().int().positive().default(40),
  DRAWING_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3), // parallel Spark calls per import

  // Infra
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8787),
  // Public base URL of this API as browsers reach it (e.g. https://sitesight-api.up.railway.app). Signed /storage
  // URLs are made absolute with it; without it they are relative to the API (local dev through the Vite proxy).
  PUBLIC_API_URL: z
    .string()
    .default("")
    .transform((v) => v.trim().replace(/\/+$/, "")),
  // Public demo: when set, every route except /healthz, /auth/* and signed /storage URLs needs the password cookie.
  DEMO_PASSWORD: z.string().default(""),
  // Spend guard across all visits and drawing imports, per UTC day. New runs/imports are refused once reached.
  DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(5),
  DATABASE_URL: z.string().default(""), // checked in db/client.ts so scripts without a DB can still run
  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET: z.string().default("sitesight"),
  // Store objects as files under this folder instead of R2 (scripts like agent-dry-run, local dev).
  STORAGE_LOCAL_DIR: z.string().default(""),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  // Dev: also accept browser origins on the local network (phone testing). Off when NODE_ENV=production.
  ALLOW_LAN_ORIGINS: z
    .enum(["true", "false"])
    .default(process.env.NODE_ENV === "production" ? "false" : "true")
    .transform((v) => v === "true"),

  // Worker
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Prices must be set and positive, or the cost cap silently never triggers.
const PRICE_KEYS = ["SPARK_INPUT_USD_PER_MTOK", "SPARK_OUTPUT_USD_PER_MTOK", "SAM_USD_PER_IMAGE"] as const;
const prices = {} as Record<(typeof PRICE_KEYS)[number], number>;
for (const key of PRICE_KEYS) {
  const raw = parsed.data[key].trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    console.error(
      `${key}=${raw ? JSON.stringify(raw) : "(missing)"} must be a positive number in USD (copy it from the Meta pricing page). Refusing to start.`,
    );
    process.exit(1);
  }
  prices[key] = value;
}

// Relative STORAGE_LOCAL_DIR is resolved from the repo root, so the API, worker and scripts share one folder.
const storageLocalDir = parsed.data.STORAGE_LOCAL_DIR ? resolve(repoRoot, parsed.data.STORAGE_LOCAL_DIR) : "";

export const env = { ...parsed.data, ...prices, STORAGE_LOCAL_DIR: storageLocalDir };
export type Env = typeof env;

// The Meta model ids must never be a "-contributor" variant (those allow training on request data).
for (const key of ["SPARK_MODEL", "SAM_MODEL", "VOICE_MODEL"] as const) {
  if (env[key].includes("-contributor")) {
    console.error(`${key}=${env[key]} is a -contributor variant. Refusing to start.`);
    process.exit(1);
  }
}
