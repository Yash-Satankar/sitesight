import { Router } from "express";
import { and, asc, eq, gt } from "drizzle-orm";
import type { AgentStep } from "@sitesight/shared";
import { db, schema } from "../db/client.js";
import { intParam } from "../lib/http.js";
import { getVisitOr404 } from "../lib/queries.js";
import { visitSpendUsd } from "../meta/cost.js";

export const traceRouter = Router();

const POLL_MS = 700;

/**
 * SSE stream of agent_steps for a visit. The agent runs in the worker process,
 * so this tails the table instead of listening to an in-memory emitter.
 * Events: "step" (AgentStep), "status" ({ status }) and "cost" ({ costUsd }: visit total). Resumes from Last-Event-ID.
 */
traceRouter.get("/visits/:id/trace", async (req, res) => {
  const visitId = intParam(req.params.id);
  await getVisitOr404(visitId);

  // X-Accel-Buffering: proxies in front of the API (Vercel rewrite, nginx) must not buffer the stream.
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();

  let lastId = Number(req.get("Last-Event-ID") ?? req.query.after ?? 0) || 0;
  let lastStatus = "";
  let lastCost = -1;
  let closed = false;
  req.on("close", () => (closed = true));

  while (!closed) {
    const rows = await db
      .select({ step: schema.agentSteps })
      .from(schema.agentSteps)
      .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.agentSteps.runId))
      .where(and(eq(schema.agentRuns.visitId, visitId), gt(schema.agentSteps.id, lastId)))
      .orderBy(asc(schema.agentSteps.id))
      .limit(200);

    for (const { step } of rows) {
      const evt: AgentStep = {
        id: step.id,
        runId: step.runId,
        idx: step.idx,
        kind: step.kind,
        name: step.name,
        payload: step.payload,
        createdAt: step.createdAt.toISOString(),
      };
      res.write(`id: ${step.id}\nevent: step\ndata: ${JSON.stringify(evt)}\n\n`);
      lastId = step.id;
    }

    const [v] = await db.select({ status: schema.visits.status }).from(schema.visits).where(eq(schema.visits.id, visitId));
    if (v && v.status !== lastStatus) {
      lastStatus = v.status;
      res.write(`event: status\ndata: ${JSON.stringify({ status: v.status })}\n\n`);
    }
    // Running cost of the visit (all its runs), for the trace header.
    const cost = Math.round((await visitSpendUsd(visitId)) * 10000) / 10000;
    if (cost !== lastCost) {
      lastCost = cost;
      res.write(`event: cost\ndata: ${JSON.stringify({ costUsd: cost })}\n\n`);
    }
    if (!rows.length) res.write(": ping\n\n");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
});
