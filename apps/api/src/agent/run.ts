import { and, eq, inArray } from "drizzle-orm";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import { functionCallOutput, functionCalls, outputAsInput, respond, type SparkInputItem } from "../meta/spark.js";
import { assertWithinBudget, CostLimitError } from "../meta/cost.js";
import { NUDGE, systemPrompt, WRAP_UP } from "./prompts.js";
import { runTool, toolDefs, type ToolContext } from "./tools.js";
import { Tracer } from "./trace.js";

/** `partial`: the model-turn budget ran out before `finish`; recorded assessments are kept. */
export type RunOutcome = "assessed" | "needs_input" | "partial";

/** The wrap-up message is sent when this many model turns are left. */
export const WRAP_UP_TURNS = 4;

/**
 * The agent loop (DESIGN.md §7). Ends with `finish` → assessed, with ≥1 open ask-back → needs_input,
 * or out of model turns → partial. MAX_AGENT_STEPS counts model turns only.
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
    const maxTurns = env.MAX_AGENT_STEPS;
    let finished = false;
    let nudged = false;
    let wrapUpSent = false;
    // Where each photo's image messages sit in `input`, so they can be swapped for text once verified.
    const imageMessages = new Map<number, number[]>();

    for (let turn = 1; turn <= maxTurns && !finished; turn++) {
      const turnsLeft = maxTurns - turn + 1;
      if (!wrapUpSent && maxTurns > WRAP_UP_TURNS && turnsLeft === WRAP_UP_TURNS) {
        input.push({ role: "user", content: WRAP_UP });
        wrapUpSent = true;
        await tracer.step("notice", "wrap_up", { message: WRAP_UP, turns_left: turnsLeft });
      }

      // Don't start a paid call if earlier runs of this visit already used the budget.
      // spark.respond and sam.segment also throw CostLimitError right after the call that crosses it.
      await assertWithinBudget(visitId);
      const resp = await respond({ instructions: systemPrompt(), input, tools: toolDefs, runId });
      const calls = functionCalls(resp);
      await tracer.step("model", null, {
        text: resp.output_text,
        tool_calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
        usage: resp.usage,
        // Logged per turn to watch context growth (and the effect of image compaction).
        context: { turn, max_turns: maxTurns, input_items: input.length, images: countImages(imageMessages) },
      });
      // Keep reasoning + function_call items in the conversation (same as scripts/spark-smoke.ts check 3).
      input.push(...outputAsInput(resp));

      if (calls.length === 0) {
        if (nudged) throw new Error("Model stopped calling tools after a nudge.");
        nudged = true;
        input.push({ role: "user", content: NUDGE });
        await tracer.step("notice", "nudge", { message: NUDGE });
        continue;
      }

      const pendingImages: { photoId: number; dataUrl: string }[] = [];
      const compactions: { photoId: number; placeholder: string }[] = [];
      for (const call of calls) {
        await tracer.step("tool_call", call.name, safeJson(call.arguments));
        const outcome = await runTool(call.name, call.arguments, ctx);
        await tracer.step("tool_result", call.name, outcome.output);
        for (const ev of outcome.events ?? []) await tracer.step(ev.kind, ev.name, ev.payload);
        // Every call_id must get an output before the next turn, even after `finish`.
        input.push(functionCallOutput(call, outcome.output));
        if (outcome.images) pendingImages.push(...outcome.images);
        if (outcome.compactPhoto) compactions.push(outcome.compactPhoto);
        if (outcome.done) finished = true;
      }

      // Images go in user messages after the tool results (works on any Responses-compatible server),
      // one message per photo so a photo's images can later be replaced on their own.
      if (!finished) {
        for (const img of pendingImages) {
          imageMessages.set(img.photoId, [...(imageMessages.get(img.photoId) ?? []), input.length]);
          input.push({
            role: "user",
            content: [
              { type: "input_text" as const, text: `Photo ${img.photoId}:` },
              { type: "input_image" as const, image_url: img.dataUrl, detail: "auto" as const },
            ],
          });
        }
      }

      // A fully verified photo's images are no longer needed: keep only a text summary of the decisions.
      // view_photo sends the image again if the model asks for it.
      for (const c of compactions) {
        const indexes = imageMessages.get(c.photoId) ?? [];
        for (const i of indexes) input[i] = { role: "user", content: c.placeholder };
        imageMessages.delete(c.photoId);
        if (indexes.length) await tracer.step("notice", "context_compacted", { message: c.placeholder, images_removed: indexes.length });
      }
    }

    const openAskBacks = await db
      .select({ id: schema.askBacks.id })
      .from(schema.askBacks)
      .where(and(eq(schema.askBacks.visitId, visitId), eq(schema.askBacks.status, "open")));

    let outcome: RunOutcome;
    if (openAskBacks.length > 0) outcome = "needs_input";
    else if (finished) outcome = "assessed";
    else outcome = "partial";

    if (outcome === "partial") {
      const kept = await db.select({ id: schema.assessments.id }).from(schema.assessments).where(eq(schema.assessments.visitId, visitId));
      await tracer.step("notice", "step_budget", {
        message: `Used all ${maxTurns} model turns without finish; kept ${kept.length} recorded assessment(s).`,
        assessments_kept: kept.length,
      });
    }

    const runStatus = { assessed: "finished", needs_input: "needs_input", partial: "partial" } as const;
    await db
      .update(schema.agentRuns)
      .set({ status: runStatus[outcome], finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    // A partial run still produced reviewable assessments, so the visit moves on to review.
    await db
      .update(schema.visits)
      .set({ status: outcome === "partial" ? "assessed" : outcome })
      .where(eq(schema.visits.id, visitId));
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Make the abort visible in the live trace. Never let a trace failure hide the original error.
    await tracer
      .step(
        "error",
        err instanceof CostLimitError ? "cost_limit" : "run_failed",
        err instanceof CostLimitError
          ? { message, spent_usd: err.spentUsd, limit_usd: err.limitUsd }
          : { message },
      )
      .catch((traceErr) => console.error(`[run ${runId}] could not write error trace step`, traceErr));
    await db
      .update(schema.agentRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    throw err;
  }
}

function countImages(imageMessages: Map<number, number[]>): number {
  let n = 0;
  for (const indexes of imageMessages.values()) n += indexes.length;
  return n;
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
