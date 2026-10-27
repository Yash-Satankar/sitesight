import { eq, sql as dsql } from "drizzle-orm";
import type { AgentStepKind } from "@sitesight/shared";
import { db, schema } from "../db/client.js";

/**
 * Writes agent_steps rows. The API's SSE endpoint tails this table, so every step
 * shows up in the live trace even though the agent runs in the worker process.
 */
export class Tracer {
  private idx = 0;
  constructor(public readonly runId: number) {}

  async step(kind: AgentStepKind, name: string | null, payload: unknown): Promise<void> {
    const clean = scrub(payload);
    await db.insert(schema.agentSteps).values({ runId: this.runId, idx: this.idx++, kind, name, payload: clean ?? {} });
    await db
      .update(schema.agentRuns)
      .set({ steps: dsql`${schema.agentRuns.steps} + 1` })
      .where(eq(schema.agentRuns.id, this.runId));
    console.log(`[run ${this.runId}] ${kind}${name ? ` ${name}` : ""}`);
  }
}

/** Drop base64 images and cap long strings so trace rows stay small. */
function scrub(v: unknown): unknown {
  if (typeof v === "string") {
    if (v.startsWith("data:")) return "[image]";
    return v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
  }
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, scrub(val)]));
  }
  return v;
}
