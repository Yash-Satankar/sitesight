/**
 * Public-demo spend guard: Meta spend today (UTC) across every agent run and drawing import, against
 * DAILY_SPEND_CAP_USD. Once reached, new agent runs, resumes and drawing imports are refused until midnight UTC.
 * A run is counted on the day it started; runs already going finish (each still has its own per-visit cap).
 */
import { gte, sql as dsql } from "drizzle-orm";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import { HttpError } from "./http.js";

export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface DailySpend {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  /** ISO time the counter resets (next midnight UTC). */
  resetsAt: string;
}

export async function dailySpend(now = new Date()): Promise<DailySpend> {
  const since = startOfUtcDay(now);
  const [runs] = await db
    .select({ s: dsql<string>`coalesce(sum(${schema.agentRuns.costUsd}), 0)` })
    .from(schema.agentRuns)
    .where(gte(schema.agentRuns.startedAt, since));
  const [imports] = await db
    .select({ s: dsql<string>`coalesce(sum(${schema.drawingImports.costUsd}), 0)` })
    .from(schema.drawingImports)
    .where(gte(schema.drawingImports.createdAt, since));
  const spentUsd = Math.round((Number(runs?.s ?? 0) + Number(imports?.s ?? 0)) * 10000) / 10000;
  return {
    spentUsd,
    capUsd: env.DAILY_SPEND_CAP_USD,
    remainingUsd: Math.max(0, Math.round((env.DAILY_SPEND_CAP_USD - spentUsd) * 10000) / 10000),
    resetsAt: new Date(since.getTime() + 24 * 3600 * 1000).toISOString(),
  };
}

export class DailyCapError extends HttpError {
  constructor(spend: DailySpend) {
    super(
      429,
      `Today's demo budget ($${spend.capUsd.toFixed(2)}) is used up, so new agent runs and drawing imports are paused until midnight UTC. Everything already recorded is still here to review.`,
      { dailySpend: spend },
    );
  }
}

export async function overDailyCap(now = new Date()): Promise<DailySpend | null> {
  const spend = await dailySpend(now);
  return spend.spentUsd >= spend.capUsd ? spend : null;
}

/** Throw a friendly 429 if today's spend has reached the cap. */
export async function assertDailyBudget(now = new Date()): Promise<void> {
  const over = await overDailyCap(now);
  if (over) throw new DailyCapError(over);
}
