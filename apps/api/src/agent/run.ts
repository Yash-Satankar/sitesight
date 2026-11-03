import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import { functionCallOutput, functionCalls, outputAsInput, respond, type SparkInputItem } from "../meta/spark.js";
import { assertWithinBudget, CostLimitError } from "../meta/cost.js";
import { NUDGE, systemPrompt, WRAP_UP } from "./prompts.js";
import { runTool, toolDefsFor, type ToolContext } from "./tools.js";
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
  const fastPath = env.AGENT_FAST_PATH;
  const ctx: ToolContext = { runId, visitId, projectId: visit.projectId, fastPath };
  await db.update(schema.visits).set({ status: "processing" }).where(eq(schema.visits.id, visitId));

  try {
    // Fast path: segment every photo for the BOQ's targets in code before the first turn.
    const pre = fastPath ? await preSegment(ctx, tracer) : null;
    const input: SparkInputItem[] = [{ role: "user", content: (await buildContext(visitId)) + (pre ? `\n\n${pre.text}` : "") }];
    const maxTurns = env.MAX_AGENT_STEPS;
    let finished = false;
    let nudged = false;
    let wrapUpSent = false;
    // Index in `input` of the one image message kept per photo (older views are replaced by text).
    const imageMessages = new Map<number, number>();
    for (const img of pre?.images ?? []) {
      imageMessages.set(img.photoId, input.length);
      input.push(imageMessage(img.photoId, img.dataUrl));
    }
    const tools = toolDefsFor(fastPath);

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
      const resp = await respond({ instructions: systemPrompt({ fastPath }), input, tools, runId });
      const calls = functionCalls(resp);
      await tracer.step("model", null, {
        text: resp.output_text,
        tool_calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
        usage: resp.usage,
        // Logged per turn to watch context growth (and the effect of image compaction).
        context: { turn, max_turns: maxTurns, input_items: input.length, images: imageMessages.size },
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
      let batchFailures = 0;
      for (const call of calls) {
        await tracer.step("tool_call", call.name, safeJson(call.arguments));
        // finish may share a turn with record_assessments, but not when items of that batch failed: they need fixing.
        const outcome =
          call.name === "finish" && batchFailures > 0
            ? { output: { error: `${batchFailures} item(s) in this turn's record_assessments failed. Fix them in another record_assessments call, then finish.` } }
            : await runTool(call.name, call.arguments, ctx);
        if (call.name === "record_assessments") batchFailures += Number((outcome.output as { failed?: number }).failed ?? 0);
        await tracer.step("tool_result", call.name, outcome.output);
        for (const ev of outcome.events ?? []) await tracer.step(ev.kind, ev.name, ev.payload);
        // Every call_id must get an output before the next turn, even after `finish`.
        input.push(functionCallOutput(call, outcome.output));
        if (outcome.images) pendingImages.push(...outcome.images);
        if (outcome.compactPhoto) compactions.push(outcome.compactPhoto);
        if (outcome.done) finished = true;
      }

      // Images go in user messages after the tool results (works on any Responses-compatible server).
      // Image budget: one image per photo (a new view replaces older ones, incl. panel previews) and at
      // most MAX_IMAGES_IN_CONTEXT overall (oldest dropped). Each removed image leaves a short text note.
      const trimmed: string[] = [];
      if (!finished) {
        for (const img of pendingImages) {
          const previous = imageMessages.get(img.photoId);
          if (previous != null) {
            input[previous] = { role: "user", content: `[photo ${img.photoId}: earlier image removed — a newer view follows]` };
            trimmed.push(`replaced older image of photo ${img.photoId}`);
          }
          imageMessages.set(img.photoId, input.length);
          input.push(imageMessage(img.photoId, img.dataUrl));
        }
        while (imageMessages.size > env.MAX_IMAGES_IN_CONTEXT) {
          const [photoId, index] = [...imageMessages.entries()].reduce((a, b) => (b[1] < a[1] ? b : a));
          input[index] = { role: "user", content: `[photo ${photoId}: image dropped to save context — call view_photo again if you need it]` };
          imageMessages.delete(photoId);
          trimmed.push(`dropped photo ${photoId} (max ${env.MAX_IMAGES_IN_CONTEXT} images)`);
        }
      }
      if (trimmed.length) await tracer.step("notice", "images_trimmed", { message: trimmed.join("; "), images_in_context: imageMessages.size });

      // A fully verified photo's image is no longer needed: keep only a text summary of the decisions.
      // view_photo sends the image again if the model asks for it.
      for (const c of compactions) {
        const index = imageMessages.get(c.photoId);
        if (index == null) continue;
        input[index] = { role: "user", content: c.placeholder };
        imageMessages.delete(c.photoId);
        await tracer.step("notice", "context_compacted", { message: c.placeholder, images_removed: 1 });
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

function imageMessage(photoId: number, dataUrl: string): SparkInputItem {
  return {
    role: "user",
    content: [
      { type: "input_text" as const, text: `Photo ${photoId}:` },
      { type: "input_image" as const, image_url: dataUrl, detail: "auto" as const },
    ],
  };
}

/**
 * Fast path, before the first model turn: segment_photo for every photo x every segment target the BOQ uses
 * (cached, budget-gated, SAM_CONCURRENCY parallel requests per photo), then the masked overlays of the first
 * MAX_IMAGES_IN_CONTEXT photos that have instances. Runs through the same tools, so the trace shows each step.
 * A SAM failure is not fatal: the model can still call segment_photo. Budget overruns abort the run as usual.
 */
async function preSegment(ctx: ToolContext, tracer: Tracer): Promise<{ text: string; images: { photoId: number; dataUrl: string }[] }> {
  const items = await db.select({ targets: schema.boqItems.segmentTargets }).from(schema.boqItems).where(eq(schema.boqItems.projectId, ctx.projectId));
  const targets = [...new Set(items.flatMap((i) => i.targets ?? []))].sort();
  const photos = await db.select({ id: schema.photos.id }).from(schema.photos).where(eq(schema.photos.visitId, ctx.visitId)).orderBy(schema.photos.id);
  if (!targets.length || !photos.length) {
    return { text: "Pre-segmentation: none needed (no BOQ item has segment targets). Use view_photo for visual items.", images: [] };
  }

  const perPhoto: { photo_id: number; targets?: unknown; error?: string; overlay?: string }[] = [];
  const withInstances: number[] = [];
  for (const p of photos) {
    const args = { photo_id: p.id, targets };
    await tracer.step("tool_call", "segment_photo", { ...args, by: "code (fast path)" });
    const out = await runTool("segment_photo", JSON.stringify(args), ctx); // CostLimitError propagates
    await tracer.step("tool_result", "segment_photo", out.output);
    const o = out.output as {
      error?: string;
      targets?: { target: string; instance_count: number; instances: { segment_id: number; score: number; area_px: number }[] }[];
    };
    if (o.error) {
      perPhoto.push({ photo_id: p.id, error: o.error });
      continue;
    }
    const summary = (o.targets ?? []).map((t) => ({
      target: t.target,
      instance_count: t.instance_count,
      instances: t.instances.map((i) => ({ segment_id: i.segment_id, score: i.score, area_px: i.area_px })),
    }));
    perPhoto.push({ photo_id: p.id, targets: summary });
    if (summary.some((t) => t.instance_count > 0)) withInstances.push(p.id);
  }

  const images: { photoId: number; dataUrl: string }[] = [];
  for (const photoId of withInstances.slice(0, env.MAX_IMAGES_IN_CONTEXT)) {
    const args = { photo_id: photoId, with_masks: true };
    await tracer.step("tool_call", "view_photo", { ...args, by: "code (fast path)" });
    const out = await runTool("view_photo", JSON.stringify(args), ctx);
    await tracer.step("tool_result", "view_photo", out.output);
    if (out.images?.length) images.push(...out.images);
  }
  const attached = new Set(images.map((i) => i.photoId));
  for (const e of perPhoto) {
    if (e.error) continue;
    e.overlay = attached.has(e.photo_id)
      ? "attached below (masks labelled #<segment_id> <target> <score>)"
      : withInstances.includes(e.photo_id)
        ? "not attached (image limit): call view_photo(with_masks=true) before verifying"
        : "no instances found";
  }
  await tracer.step("notice", "pre_segmented", {
    message: `Segmented ${photos.length} photo(s) for ${targets.join(", ")} before the first turn; ${images.length} overlay(s) attached.`,
    photos: photos.length,
    targets,
    overlays: images.length,
  });
  return {
    text: `Pre-segmentation (done by code before this turn, fast path) for targets ${targets.join(", ")}:\n${JSON.stringify(perPhoto, null, 2)}`,
    images,
  };
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
  // Latest engineer-accepted assessment per item from earlier visits, so changes can be stated without extra tool calls.
  const accepted = await db
    .select({ a: schema.assessments, visitDate: schema.visits.visitDate, visitId: schema.visits.id })
    .from(schema.assessments)
    .innerJoin(schema.visits, eq(schema.visits.id, schema.assessments.visitId))
    .where(
      and(
        eq(schema.visits.projectId, projectId),
        ne(schema.assessments.visitId, visitId),
        inArray(schema.assessments.status, ["accepted", "edited"]),
      ),
    )
    .orderBy(desc(schema.visits.visitDate), desc(schema.visits.id));
  const latestByItem = new Map<number, (typeof accepted)[number]>();
  for (const row of accepted) if (!latestByItem.has(row.a.boqItemId)) latestByItem.set(row.a.boqItemId, row);
  // Photo requests still open from earlier visits: not to be asked again; a photo here may answer them.
  const earlierOpen = await db
    .select({ ab: schema.askBacks, visitDate: schema.visits.visitDate })
    .from(schema.askBacks)
    .innerJoin(schema.visits, eq(schema.visits.id, schema.askBacks.visitId))
    .where(and(eq(schema.visits.projectId, projectId), ne(schema.askBacks.visitId, visitId), eq(schema.askBacks.status, "open")))
    .orderBy(schema.askBacks.id);

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
    open_ask_backs_from_earlier_visits: earlierOpen.map(({ ab, visitDate }) => ({
      ask_back_id: ab.id,
      visit_date: visitDate,
      boq_item_id: ab.boqItemId,
      zone_id: ab.zoneId,
      instruction: ab.instruction,
      reason: ab.reason,
    })),
    previous_visit_assessments: [...latestByItem.values()].map(({ a, visitDate }) => ({
      boq_item_id: a.boqItemId,
      visit_date: visitDate,
      percent_complete: a.percentComplete,
      stage_reached: a.stageReached,
      qty_done: a.qtyDone,
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
