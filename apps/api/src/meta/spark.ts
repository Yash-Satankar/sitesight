import type OpenAI from "openai";
import { eq, sql as dsql } from "drizzle-orm";
import type { z } from "zod";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import { metaClient } from "./client.js";

// Re-exported so agent/ can type its messages without importing the SDK itself.
export type SparkInputItem = OpenAI.Responses.ResponseInputItem;
export type SparkTool = OpenAI.Responses.FunctionTool;
export type SparkResponse = OpenAI.Responses.Response;
export type SparkFunctionCall = OpenAI.Responses.ResponseFunctionToolCall;

export class CostLimitError extends Error {
  constructor(public spentUsd: number) {
    super(`Visit cost $${spentUsd.toFixed(4)} exceeded MAX_COST_PER_VISIT_USD=$${env.MAX_COST_PER_VISIT_USD}`);
  }
}

export interface RespondOptions {
  instructions: string;
  input: SparkInputItem[];
  tools?: SparkTool[];
  /** When set, tokens and cost are recorded on this agent run and the per-visit cap is enforced. */
  runId?: number;
}

/**
 * One Muse Spark call over the Responses API.
 * Known constraints: reasoning cannot be disabled, tool_choice is "auto" only, stop sequences are ignored.
 */
export async function respond(opts: RespondOptions): Promise<SparkResponse> {
  const resp = await metaClient().responses.create({
    model: env.SPARK_MODEL,
    instructions: opts.instructions,
    input: opts.input,
    tools: opts.tools,
    tool_choice: opts.tools?.length ? "auto" : undefined,
  });

  if (opts.runId != null) await recordUsage(opts.runId, resp);
  return resp;
}

export function functionCalls(resp: SparkResponse): SparkFunctionCall[] {
  return resp.output.filter((o): o is SparkFunctionCall => o.type === "function_call");
}

/** Ask Spark for JSON matching `schema`. One repair attempt if the output fails validation. */
export async function respondJson<S extends z.ZodTypeAny>(
  schema: S,
  instructions: string,
  userText: string,
): Promise<z.output<S>> {
  const input: SparkInputItem[] = [{ role: "user", content: userText }];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await respond({ instructions, input });
    const text = resp.output_text ?? "";
    const parsed = schema.safeParse(extractJson(text));
    if (parsed.success) return parsed.data;
    lastError = parsed.error.message;
    input.push(
      { role: "assistant", content: text },
      { role: "user", content: `That JSON was invalid: ${lastError}\nReturn only corrected JSON.` },
    );
  }
  throw new Error(`Spark returned invalid JSON after repair: ${lastError}`);
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function recordUsage(runId: number, resp: SparkResponse) {
  const inTok = resp.usage?.input_tokens ?? 0;
  const outTok = resp.usage?.output_tokens ?? 0;
  const cost =
    (inTok * env.SPARK_INPUT_USD_PER_MTOK + outTok * env.SPARK_OUTPUT_USD_PER_MTOK) / 1_000_000;

  const [run] = await db
    .update(schema.agentRuns)
    .set({
      inputTokens: dsql`${schema.agentRuns.inputTokens} + ${inTok}`,
      outputTokens: dsql`${schema.agentRuns.outputTokens} + ${outTok}`,
      costUsd: dsql`${schema.agentRuns.costUsd} + ${cost}`,
    })
    .where(eq(schema.agentRuns.id, runId))
    .returning({ visitId: schema.agentRuns.visitId });
  if (!run) return;

  const [total] = await db
    .select({ spent: dsql<string>`coalesce(sum(${schema.agentRuns.costUsd}), 0)` })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.visitId, run.visitId));
  const spent = Number(total?.spent ?? 0);
  if (spent > env.MAX_COST_PER_VISIT_USD) throw new CostLimitError(spent);
}
