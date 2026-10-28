/**
 * The agent must stop as soon as a visit goes over MAX_COST_PER_VISIT_USD, whether Spark or SAM pushed it over,
 * and leave a clear `cost_limit` step in the trace.
 *
 * The Meta client is mocked (no network). The database is PGlite: real Postgres in-process with our real
 * migrations, so the cost SQL is exercised exactly as in production. Storage is mocked.
 * Prices and the cap come from vitest.config.ts: Spark call = $0.004, SAM request = $0.0035, cap = $0.01.
 */
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../src/meta/client.js", () => ({
  metaClient: () => ({ responses: { create } }),
}));

vi.mock("../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../src/db/schema.js");
  const db = drizzle(new PGlite(), { schema });
  return { db, schema, sql: { end: async () => {} } };
});

vi.mock("../src/services/storage.js", async () => {
  const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#888" } }).jpeg().toBuffer();
  return {
    getObject: async () => photo,
    putObject: async () => {},
    presignGet: async (key: string) => `https://storage.test/${key}`,
    presignPut: async (key: string) => `https://storage.test/${key}`,
    newKey: (prefix: string) => `${prefix}/${Math.random().toString(36).slice(2)}`,
  };
});

import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { db as mockedDb, schema } from "../src/db/client.js";
import { runAgent } from "../src/agent/run.js";
import { CostLimitError } from "../src/meta/cost.js";
import { env } from "../src/config.js";

const db = mockedDb as unknown as PgliteDatabase<typeof schema>;

// ---- fake Meta responses ----
let callSeq = 0;
function sparkToolCall(name: string, args: Record<string, unknown> = {}) {
  callSeq++;
  return {
    id: `resp_${callSeq}`,
    output: [
      { type: "function_call", id: `fc_${callSeq}`, call_id: `call_${callSeq}`, name, arguments: JSON.stringify(args), status: "completed" },
    ],
    output_text: "",
    usage: { input_tokens: 200, output_tokens: 200, total_tokens: 400 },
  };
}
const samNoMatches = () => ({ id: "sam", output: [], output_text: "", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });

const callsTo = (model: string) => create.mock.calls.filter(([body]) => body.model === model).length;

// ---- fixtures ----
async function seedVisit() {
  const [project] = await db.insert(schema.projects).values({ name: "Test project" }).returning();
  const [zone] = await db.insert(schema.zones).values({ projectId: project!.id, name: "Floor 1" }).returning();
  await db.insert(schema.boqItems).values({
    projectId: project!.id,
    code: "1.1",
    description: "RCC columns",
    unit: "nos",
    plannedQty: 10,
    measureMode: "count",
    segmentTargets: ["column"],
  });
  const [visit] = await db.insert(schema.visits).values({ projectId: project!.id, status: "queued" }).returning();
  const [photo] = await db
    .insert(schema.photos)
    .values({ visitId: visit!.id, zoneId: zone!.id, storageKey: "visits/1/photos/a.jpg", width: 640, height: 480 })
    .returning();
  return { visitId: visit!.id, photoId: photo!.id };
}

async function latestRun(visitId: number) {
  const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.visitId, visitId)).orderBy(asc(schema.agentRuns.id));
  const run = runs[runs.length - 1]!;
  const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, run.id)).orderBy(asc(schema.agentSteps.idx));
  return { run, steps };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../src/db/migrations", import.meta.url)) });
});

beforeEach(() => {
  create.mockReset();
  callSeq = 0;
});

describe("per-visit cost cap", () => {
  it("test config matches the cost maths in this file", () => {
    expect(env.MAX_COST_PER_VISIT_USD).toBe(0.01);
    expect(env.SAM_USD_PER_IMAGE).toBe(0.0035);
  });

  it("aborts when a Spark call pushes the visit over the cap, before any further call", async () => {
    const { visitId } = await seedVisit();
    // The model never finishes: it keeps calling a cheap tool. $0.004 per call → over $0.01 on call 3.
    create.mockImplementation(async () => sparkToolCall("list_boq_items"));

    await expect(runAgent(visitId)).rejects.toBeInstanceOf(CostLimitError);

    expect(callsTo(env.SPARK_MODEL)).toBe(3); // no 4th call after crossing the cap
    const { run, steps } = await latestRun(visitId);
    expect(run.status).toBe("failed");
    expect(run.costUsd).toBeCloseTo(0.012, 6);
    expect(run.inputTokens).toBe(600);
    expect(run.error).toMatch(/exceeded MAX_COST_PER_VISIT_USD=\$0\.01/);

    const last = steps[steps.length - 1]!;
    expect(last).toMatchObject({ kind: "error", name: "cost_limit" });
    expect(last.payload).toMatchObject({ limit_usd: 0.01 });
    expect((last.payload as { spent_usd: number }).spent_usd).toBeCloseTo(0.012, 6);
    // The 3rd response was paid for but never acted on: only 2 model steps were traced.
    expect(steps.filter((s) => s.kind === "model")).toHaveLength(2);
  });

  it("aborts when SAM pushes the visit over the cap, instead of returning a tool error to the model", async () => {
    const { visitId, photoId } = await seedVisit();
    // Spark ($0.004) asks for both targets = 3 SAM prompts. SAM: $0.0075, then $0.011 → over the cap on the 2nd request.
    create.mockImplementation(async (body: { model: string }) =>
      body.model === env.SAM_MODEL
        ? samNoMatches()
        : sparkToolCall("segment_photo", { photo_id: photoId, targets: ["column", "brickwork"] }),
    );

    await expect(runAgent(visitId)).rejects.toBeInstanceOf(CostLimitError);

    expect(callsTo(env.SPARK_MODEL)).toBe(1);
    expect(callsTo(env.SAM_MODEL)).toBe(2); // 3rd concept never requested
    const { run, steps } = await latestRun(visitId);
    expect(run.status).toBe("failed");
    expect(run.costUsd).toBeCloseTo(0.011, 6);
    // model → tool_call → error. No tool_result: the overrun was not swallowed and handed back to the model.
    expect(steps.map((s) => `${s.kind}:${s.name ?? ""}`)).toEqual(["model:", "tool_call:segment_photo", "error:cost_limit"]);
  });

  it("concurrent SAM requests never overshoot the cap: remaining concepts are not fired", async () => {
    const { visitId, photoId } = await seedVisit();
    expect(env.SAM_CONCURRENCY).toBe(3);
    // Spark ($0.004) asks for both targets = 3 prompts. Budget left: $0.006 → only 2 SAM requests fit ($0.0075, $0.011).
    // SAM responses are slow, so with 3 free slots a naive limiter would have 3 requests in flight at once.
    let inFlight = 0;
    let maxInFlight = 0;
    create.mockImplementation(async (body: { model: string }) => {
      if (body.model !== env.SAM_MODEL) {
        return sparkToolCall("segment_photo", {
          photo_id: photoId,
          targets: ["column", "brickwork"],
        });
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return samNoMatches();
    });

    await expect(runAgent(visitId)).rejects.toBeInstanceOf(CostLimitError);

    expect(callsTo(env.SAM_MODEL)).toBe(2); // not 3 (all prompts, and the concurrency limit)
    expect(maxInFlight).toBe(2); // the two affordable requests did run in parallel
    const sentConcepts = create.mock.calls
      .filter(([body]) => body.model === env.SAM_MODEL)
      .map(([body]) => body.input[0].content[0].text);
    expect(sentConcepts).toEqual(["concrete column", "exposed brick wall"]);
    const { run, steps } = await latestRun(visitId);
    expect(run.costUsd).toBeCloseTo(0.011, 6); // both in-flight requests billed, nothing more
    expect(steps.map((s) => `${s.kind}:${s.name ?? ""}`)).toEqual(["model:", "tool_call:segment_photo", "error:cost_limit"]);
  });

  it("does not make any call when earlier runs already used the visit's budget", async () => {
    const { visitId } = await seedVisit();
    await db.insert(schema.agentRuns).values({ visitId, status: "needs_input", costUsd: 0.02, finishedAt: new Date() });
    create.mockImplementation(async () => sparkToolCall("list_boq_items"));

    await expect(runAgent(visitId)).rejects.toBeInstanceOf(CostLimitError);

    expect(create).not.toHaveBeenCalled();
    const { run, steps } = await latestRun(visitId);
    expect(run.status).toBe("failed");
    expect(run.costUsd).toBe(0);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "error", name: "cost_limit" });
    expect((steps[0]!.payload as { spent_usd: number }).spent_usd).toBeCloseTo(0.02, 6);
  });

  it("records cost and finishes normally when under the cap", async () => {
    const { visitId } = await seedVisit();
    create.mockImplementation(async () => sparkToolCall("finish", { summary: "Nothing to assess." }));

    await expect(runAgent(visitId)).resolves.toBe("assessed");

    const { run, steps } = await latestRun(visitId);
    expect(run.status).toBe("finished");
    expect(run.costUsd).toBeCloseTo(0.004, 6);
    expect(steps.some((s) => s.kind === "error")).toBe(false);
  });
});
