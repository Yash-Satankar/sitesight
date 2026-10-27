import { eq, sql as dsql } from "drizzle-orm";
import { env } from "../config.js";
// db/client.js is imported lazily so DB-free scripts (spark-smoke, sam-spike) can load meta/.

export class CostLimitError extends Error {
  readonly limitUsd = env.MAX_COST_PER_VISIT_USD;
  constructor(public readonly spentUsd: number) {
    super(`Visit cost $${spentUsd.toFixed(4)} exceeded MAX_COST_PER_VISIT_USD=$${env.MAX_COST_PER_VISIT_USD}`);
    this.name = "CostLimitError";
  }
}

export interface CostEntry {
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
}

/** Add one model call's cost to agent_runs, then enforce the per-visit cap (throws CostLimitError). */
export async function addRunCost(runId: number, entry: CostEntry): Promise<void> {
  const { db, schema } = await import("../db/client.js");
  const [run] = await db
    .update(schema.agentRuns)
    .set({
      inputTokens: dsql`${schema.agentRuns.inputTokens} + ${entry.inputTokens ?? 0}`,
      outputTokens: dsql`${schema.agentRuns.outputTokens} + ${entry.outputTokens ?? 0}`,
      costUsd: dsql`${schema.agentRuns.costUsd} + ${entry.costUsd}`,
    })
    .where(eq(schema.agentRuns.id, runId))
    .returning({ visitId: schema.agentRuns.visitId });
  if (run) await assertWithinBudget(run.visitId);
}

/** Total spend across all agent runs of a visit. */
export async function visitSpendUsd(visitId: number): Promise<number> {
  const { db, schema } = await import("../db/client.js");
  const [row] = await db
    .select({ spent: dsql<string>`coalesce(sum(${schema.agentRuns.costUsd}), 0)` })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.visitId, visitId));
  return Number(row?.spent ?? 0);
}

export async function assertWithinBudget(visitId: number): Promise<void> {
  const spent = await visitSpendUsd(visitId);
  if (spent > env.MAX_COST_PER_VISIT_USD) throw new CostLimitError(spent);
}
