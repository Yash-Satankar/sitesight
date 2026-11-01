/**
 * Public-demo spend guard: Meta spend today (UTC) from the spend ledger (agent runs, drawing imports, spreadsheet
 * BOQ parses; one row per call, kept when projects are deleted), against DAILY_SPEND_CAP_USD. Once reached, new
 * agent runs, resumes, drawing imports and BOQ parses are refused until midnight UTC; runs already going finish
 * (each still has its own per-visit / per-import cap).
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
  // The append-only ledger: one row per model call, kept even when a project is deleted.
  const [row] = await db
    .select({ s: dsql<string>`coalesce(sum(${schema.spendLedger.costUsd}), 0)` })
    .from(schema.spendLedger)
    .where(gte(schema.spendLedger.at, since));
  const spentUsd = Math.round(Number(row?.s ?? 0) * 10000) / 10000;
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
