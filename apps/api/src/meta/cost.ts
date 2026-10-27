import { eq, sql as dsql } from "drizzle-orm";
import { env } from "../config.js";
import { createLimiter } from "../lib/limit.js";
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

export interface BudgetGate {
  /** Call before sending a request. Throws CostLimitError instead of letting it go out. */
  reserve(): Promise<void>;
  /** The request succeeded: bill it. Throws CostLimitError if the visit is now over the cap. */
  settle(): Promise<void>;
  /** The request failed and is not billed: drop the reservation. */
  release(): Promise<void>;
}

/**
 * Budget check for concurrent fixed-price requests (SAM). Requests still in flight count as spent,
 * so a request is only sent if the visit would not already be over the cap once every in-flight
 * request is billed. That sends exactly the requests a sequential loop would, with no overshoot from
 * concurrency. All three steps share one lock, so a reservation never sees a half-billed request.
 */
export function createBudgetGate(runId: number, unitCostUsd: number): BudgetGate {
  const lock = createLimiter(1);
  let inFlight = 0;
  let visitId: number | undefined;

  return {
    reserve: () =>
      lock(async () => {
        visitId ??= await visitIdForRun(runId);
        const projected = (await visitSpendUsd(visitId)) + inFlight * unitCostUsd;
        // Same rule as assertWithinBudget: stop once spend (incl. in-flight) is over the cap.
        if (projected > env.MAX_COST_PER_VISIT_USD) throw new CostLimitError(projected);
        inFlight++;
      }),
    settle: () =>
      lock(async () => {
        inFlight--;
        await addRunCost(runId, { costUsd: unitCostUsd });
      }),
    release: () =>
      lock(async () => {
        inFlight--;
      }),
  };
}

async function visitIdForRun(runId: number): Promise<number> {
  const { db, schema } = await import("../db/client.js");
  const [run] = await db
    .select({ visitId: schema.agentRuns.visitId })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId));
  if (!run) throw new Error(`agent run ${runId} not found`);
  return run.visitId;
}
