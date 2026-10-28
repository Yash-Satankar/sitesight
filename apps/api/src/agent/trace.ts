import { eq, sql as dsql } from "drizzle-orm";
import type { AgentStepKind } from "@sitesight/shared";
import { db, schema } from "../db/client.js";

export interface TraceStepEvent {
  runId: number;
  idx: number;
  kind: AgentStepKind;
  name: string | null;
  payload: unknown;
}
export type TraceListener = (step: TraceStepEvent) => void | Promise<void>;

const listeners = new Set<TraceListener>();

/** Watch trace steps in-process (e.g. the dry-run script). Returns an unsubscribe function. */
export function onTraceStep(listener: TraceListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Writes agent_steps rows. The API's SSE endpoint tails this table, so every step
 * shows up in the live trace even though the agent runs in the worker process.
 */
export class Tracer {
  private idx = 0;
  constructor(public readonly runId: number) {}

  async step(kind: AgentStepKind, name: string | null, payload: unknown): Promise<void> {
    const clean = scrub(payload);
    const idx = this.idx++;
    await db.insert(schema.agentSteps).values({ runId: this.runId, idx, kind, name, payload: clean ?? {} });
    await db
      .update(schema.agentRuns)
      .set({ steps: dsql`${schema.agentRuns.steps} + 1` })
      .where(eq(schema.agentRuns.id, this.runId));
    if (!listeners.size) {
      console.log(`[run ${this.runId}] ${kind}${name ? ` ${name}` : ""}${kind === "model" ? contextSummary(payload) : ""}`);
      return;
    }
    // Awaited so listener output stays in step order with the agent loop.
    for (const listener of listeners) await listener({ runId: this.runId, idx, kind, name, payload: clean });
  }
}

/** " (turn 3/30, 12345 in tokens, 2 images in context)" for model steps, to watch context growth. */
export function contextSummary(payload: unknown): string {
  const p = (payload ?? {}) as { usage?: { input_tokens?: number }; context?: { turn?: number; max_turns?: number; images?: number } };
  const parts: string[] = [];
  if (p.context?.turn != null) parts.push(`turn ${p.context.turn}/${p.context.max_turns}`);
  if (p.usage?.input_tokens != null) parts.push(`${p.usage.input_tokens} in tokens`);
  if (p.context?.images != null) parts.push(`${p.context.images} image${p.context.images === 1 ? "" : "s"} in context`);
  return parts.length ? ` (${parts.join(", ")})` : "";
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
