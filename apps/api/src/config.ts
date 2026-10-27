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
  SAM_MODEL: z.string().default("sam-3-1"),
  VOICE_MODEL: z.string().default("muse-voice-transcribe-1.0"),
  SPARK_INPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(0),
  SPARK_OUTPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(0),

  // Agent tunables
  MAX_AGENT_STEPS: z.coerce.number().int().positive().default(25),
  MAX_COST_PER_VISIT_USD: z.coerce.number().positive().default(1.5),
  ASK_BACK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  MAX_IMAGE_EDGE_PX: z.coerce.number().int().positive().default(1600),
  VISUAL_ONLY_MAX_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  // Infra
  PORT: z.coerce.number().int().default(8787),
  DATABASE_URL: z.string().default(""), // checked in db/client.ts so scripts without a DB can still run
  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET: z.string().default("sitesight"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),

  // Worker
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

// The Meta model ids must never be a "-contributor" variant (those allow training on request data).
for (const key of ["SPARK_MODEL", "SAM_MODEL", "VOICE_MODEL"] as const) {
  if (env[key].includes("-contributor")) {
    console.error(`${key}=${env[key]} is a -contributor variant. Refusing to start.`);
    process.exit(1);
  }
}
