import { and, eq, inArray } from "drizzle-orm";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import { functionCallOutput, functionCalls, outputAsInput, respond, type SparkInputItem } from "../meta/spark.js";
import { NUDGE, systemPrompt } from "./prompts.js";
import { runTool, toolDefs, type ToolContext } from "./tools.js";
import { Tracer } from "./trace.js";

export type RunOutcome = "assessed" | "needs_input";

/**
 * The agent loop (DESIGN.md §7). Ends with `finish` → assessed, or with ≥1 open ask-back → needs_input.
 * Never relies on forcing a tool: tool_choice is "auto" only on Muse Spark.
 */
export async function runAgent(visitId: number): Promise<RunOutcome> {
  const [visit] = await db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
  if (!visit) throw new Error(`visit ${visitId} not found`);

  const [run] = await db.insert(schema.agentRuns).values({ visitId }).returning();
  const runId = run!.id;
  const tracer = new Tracer(runId);
  const ctx: ToolContext = { runId, visitId, projectId: visit.projectId };
  await db.update(schema.visits).set({ status: "processing" }).where(eq(schema.visits.id, visitId));

  try {
    const input: SparkInputItem[] = [{ role: "user", content: await buildContext(visitId) }];
    let finished = false;
    let nudged = false;

    for (let step = 1; step <= env.MAX_AGENT_STEPS && !finished; step++) {
      const resp = await respond({ instructions: systemPrompt(), input, tools: toolDefs, runId });
      const calls = functionCalls(resp);
      await tracer.step("model", null, {
        text: resp.output_text,
        tool_calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
        usage: resp.usage,
      });
      // Keep reasoning + function_call items in the conversation (same as scripts/spark-smoke.ts check 3).
      input.push(...outputAsInput(resp));

      if (calls.length === 0) {
        if (nudged) throw new Error("Model stopped calling tools after a nudge.");
        nudged = true;
        input.push({ role: "user", content: NUDGE });
        continue;
      }

      const pendingImages: { photoId: number; dataUrl: string }[] = [];
      for (const call of calls) {
        await tracer.step("tool_call", call.name, safeJson(call.arguments));
        const outcome = await runTool(call.name, call.arguments, ctx);
        await tracer.step("tool_result", call.name, outcome.output);
        // Every call_id must get an output before the next turn, even after `finish`.
        input.push(functionCallOutput(call, outcome.output));
        if (outcome.images) pendingImages.push(...outcome.images);
        if (outcome.done) finished = true;
      }

      // Images go in a user message after the tool results (works on any Responses-compatible server).
      if (pendingImages.length && !finished) {
        input.push({
          role: "user",
          content: pendingImages.flatMap((img) => [
            { type: "input_text" as const, text: `Photo ${img.photoId}:` },
            { type: "input_image" as const, image_url: img.dataUrl, detail: "auto" as const },
          ]),
        });
      }
    }

    const openAskBacks = await db
      .select({ id: schema.askBacks.id })
      .from(schema.askBacks)
      .where(and(eq(schema.askBacks.visitId, visitId), eq(schema.askBacks.status, "open")));

    let outcome: RunOutcome;
    if (openAskBacks.length > 0) outcome = "needs_input";
    else if (finished) outcome = "assessed";
    else throw new Error(`Reached MAX_AGENT_STEPS=${env.MAX_AGENT_STEPS} without finish.`);

    await db
      .update(schema.agentRuns)
      .set({ status: outcome === "assessed" ? "finished" : "needs_input", finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    await db.update(schema.visits).set({ status: outcome }).where(eq(schema.visits.id, visitId));
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.agentRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    throw err;
  }
}

/** Everything the model needs up front: zones, BOQ, photos, prior assessments and ask-back answers. */
async function buildContext(visitId: number): Promise<string> {
  const [visit] = await db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
  const projectId = visit!.projectId;
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  const zones = await db.select().from(schema.zones).where(eq(schema.zones.projectId, projectId));
  const items = await db.select().from(schema.boqItems).where(eq(schema.boqItems.projectId, projectId));
  const photos = await db.select().from(schema.photos).where(eq(schema.photos.visitId, visitId));
  const prior = await db.select().from(schema.assessments).where(eq(schema.assessments.visitId, visitId));
  const askBacks = await db
    .select()
    .from(schema.askBacks)
    .where(and(eq(schema.askBacks.visitId, visitId), inArray(schema.askBacks.status, ["fulfilled", "skipped"])));

  const ctx = {
    project: { name: project!.name, location: project!.locationLabel },
    visit: { id: visitId, date: visit!.visitDate },
    zones: zones.map((z) => ({ zone_id: z.id, name: z.name })),
    boq_item_count: items.length,
    photos: photos.map((p) => ({
      photo_id: p.id,
      zone_id: p.zoneId,
      transcript: p.transcript,
      answers_ask_back_id: p.askBackId,
    })),
    previous_assessments_this_visit: prior.map((a) => ({
      boq_item_id: a.boqItemId,
      percent_complete: a.percentComplete,
      confidence: a.confidence,
      rationale: a.rationale,
    })),
    resolved_ask_backs: askBacks.map((a) => ({
      ask_back_id: a.id,
      boq_item_id: a.boqItemId,
      instruction: a.instruction,
      status: a.status,
    })),
  };

  const rerun = prior.length > 0;
  return `${rerun ? "This is a re-run after the engineer answered photo requests. Revisit items tied to those requests; keep other assessments unless new evidence changes them.\n\n" : ""}Visit context:\n${JSON.stringify(ctx, null, 2)}`;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}
