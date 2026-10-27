import type OpenAI from "openai";
import type { z } from "zod";
import { env } from "../config.js";
import { metaClient } from "./client.js";
import { addRunCost } from "./cost.js";

export { CostLimitError } from "./cost.js";

// Re-exported so agent/ can type its messages without importing the SDK itself.
export type SparkInputItem = OpenAI.Responses.ResponseInputItem;
export type SparkTool = OpenAI.Responses.FunctionTool;
export type SparkResponse = OpenAI.Responses.Response;
export type SparkFunctionCall = OpenAI.Responses.ResponseFunctionToolCall;

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

  // Adds tokens + cost to agent_runs and throws CostLimitError if the visit is now over budget.
  if (opts.runId != null) await addRunCost(opts.runId, estimateCost(resp));
  return resp;
}

export function functionCalls(resp: SparkResponse): SparkFunctionCall[] {
  return resp.output.filter((o): o is SparkFunctionCall => o.type === "function_call");
}

/**
 * Items to append to `input` before the next turn: everything the model produced
 * (reasoning, messages, function_call items) so the conversation stays intact.
 */
export function outputAsInput(resp: SparkResponse): SparkInputItem[] {
  return resp.output as SparkInputItem[];
}

/** The tool result item for a function_call. `call_id` must match the call it answers. */
export function functionCallOutput(call: SparkFunctionCall, output: unknown): SparkInputItem {
  return {
    type: "function_call_output",
    call_id: call.call_id,
    output: typeof output === "string" ? output : JSON.stringify(output),
  };
}

export interface UsageCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Tokens and estimated USD cost of one response, using SPARK_*_USD_PER_MTOK. */
export function estimateCost(resp: SparkResponse): UsageCost {
  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const costUsd =
    (inputTokens * env.SPARK_INPUT_USD_PER_MTOK + outputTokens * env.SPARK_OUTPUT_USD_PER_MTOK) / 1_000_000;
  return { inputTokens, outputTokens, costUsd };
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
