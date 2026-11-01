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
  opts: { meter?: CostMeter } = {},
): Promise<z.output<S>> {
  const input: SparkInputItem[] = [{ role: "user", content: userText }];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await opts.meter?.beforeCall();
    const resp = await respond({ instructions, input });
    await opts.meter?.record(estimateCost(resp));
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

/** Called around every Spark call of a metered job (e.g. a drawing import) to enforce its own cost cap. */
export interface CostMeter {
  /** Before a call: throw to stop (e.g. the cap is reached). */
  beforeCall(): void | Promise<void>;
  /** After a call: record its tokens and cost. */
  record(usage: UsageCost): void | Promise<void>;
  /** The call failed and is not billed (optional). */
  cancel?(): void;
}

export class JsonValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Spark returned invalid JSON after one retry: ${issues.slice(0, 5).join("; ")}`);
    this.name = "JsonValidationError";
  }
}

export type SparkContent = Exclude<OpenAI.Responses.ResponseInputMessageContentList, string>;

/** PNG/JPEG bytes as an input_image part ("high" detail so small schedule text stays legible). */
export function imagePart(bytes: Buffer, mime = "image/png", detail: "high" | "auto" | "low" = "high"): SparkContent[number] {
  return { type: "input_image", image_url: `data:${mime};base64,${bytes.toString("base64")}`, detail };
}

/** zod issues as "path: message" lines the model can act on. */
export function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/**
 * Ask Spark for JSON matching `schema` from text and/or images. If the output does not validate, the issues are sent
 * back and the model gets one retry. Every call is billed through `meter`.
 */
export async function respondJsonContent<S extends z.ZodTypeAny>(
  schema: S,
  opts: { instructions: string; content: SparkContent; meter?: CostMeter },
): Promise<{ data: z.output<S>; attempts: number }> {
  const input: SparkInputItem[] = [{ role: "user", content: opts.content }];
  let issues: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    await opts.meter?.beforeCall();
    let resp: SparkResponse;
    try {
      resp = await respond({ instructions: opts.instructions, input });
    } catch (err) {
      opts.meter?.cancel?.();
      throw err;
    }
    await opts.meter?.record(estimateCost(resp));
    const text = resp.output_text ?? "";
    const json = extractJson(text);
    const parsed = schema.safeParse(json);
    if (parsed.success) return { data: parsed.data, attempts: attempt };
    issues = json === undefined ? ["(root): the reply did not contain a JSON object"] : zodIssues(parsed.error);
    input.push(
      { role: "assistant", content: text },
      { role: "user", content: `That JSON does not match the schema:\n${issues.map((i) => `- ${i}`).join("\n")}\nReturn only the corrected JSON object.` },
    );
  }
  throw new JsonValidationError(issues);
}
