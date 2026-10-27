/**
 * Smoke test for the Muse Spark path through our own meta/ layer (no separate SDK instance).
 *
 *   pnpm spark-smoke                 # image check uses the first .jpg/.png in samples/
 *   pnpm spark-smoke path/to/photo.jpg
 *
 * Checks: 1) text  2) base64 image input  3) function tool round trip (same item handling as agent/run.ts).
 * Needs META_API_KEY + META_BASE_URL in .env. No database required.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/config.js";
import {
  estimateCost,
  functionCallOutput,
  functionCalls,
  outputAsInput,
  respond,
  type SparkInputItem,
  type SparkResponse,
  type SparkTool,
  type UsageCost,
} from "../src/meta/spark.js";
import { normalize, toDataUrl } from "../src/services/images.js";

const INSTRUCTIONS = "You are a concise assistant used for an API smoke test.";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type CheckResult = { ok: boolean; detail: string; usage: UsageCost };

function sumUsage(resps: SparkResponse[]): UsageCost {
  return resps.map(estimateCost).reduce(
    (a, b) => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

// ---- 1. Text ----
async function checkText(): Promise<CheckResult> {
  const resp = await respond({ instructions: INSTRUCTIONS, input: [{ role: "user", content: "Reply with exactly: ok" }] });
  const text = resp.output_text ?? "";
  return { ok: /\bok\b/i.test(text), detail: `output_text=${JSON.stringify(text)}`, usage: sumUsage([resp]) };
}

// ---- 2. Image ----
async function findImage(): Promise<string> {
  const arg = process.argv[2];
  if (arg) return resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  const dir = join(repoRoot, "samples");
  const file = (await readdir(dir)).sort().find((f) => /\.(jpe?g|png)$/i.test(f));
  if (!file) throw new Error(`No .jpg/.png found in ${dir}. Add one or pass a path: pnpm spark-smoke <photo>`);
  return join(dir, file);
}

async function checkImage(): Promise<CheckResult> {
  const path = await findImage();
  const img = await normalize(await readFile(path)); // EXIF-rotate + resize to ≤ MAX_IMAGE_EDGE_PX, JPEG
  const resp = await respond({
    instructions: INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this construction site photo in one sentence." },
          { type: "input_image", image_url: toDataUrl(img.buffer), detail: "auto" },
        ],
      },
    ],
  });
  const text = (resp.output_text ?? "").trim();
  return {
    ok: text.length > 0,
    detail: `image=${path} (${img.width}x${img.height}, ${(img.buffer.length / 1024).toFixed(0)} KB)\n  output_text=${JSON.stringify(text)}`,
    usage: sumUsage([resp]),
  };
}

// ---- 3. Tool round trip ----
const weatherTool: SparkTool = {
  type: "function",
  name: "get_site_weather",
  description: "Get the current weather at a construction site by city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
    additionalProperties: false,
  },
  strict: false,
};

async function checkToolRoundTrip(): Promise<CheckResult> {
  const input: SparkInputItem[] = [{ role: "user", content: "What's the weather at the site in Bhopal? Use the tool." }];
  const tools = [weatherTool];

  // Turn 1: expect a function_call. tool_choice stays "auto" (the only value Meta supports).
  const first = await respond({ instructions: INSTRUCTIONS, input, tools });
  const calls = functionCalls(first);
  const call = calls.find((c) => c.name === "get_site_weather");
  if (!call) {
    return {
      ok: false,
      detail: `no get_site_weather function_call. output types=${JSON.stringify(first.output.map((o) => o.type))} text=${JSON.stringify(first.output_text)}`,
      usage: sumUsage([first]),
    };
  }

  // Same steps as agent/run.ts: append the model's output items, then one function_call_output per call.
  input.push(...outputAsInput(first));
  const lines = [`function_call call_id=${call.call_id} arguments=${call.arguments}`];
  for (const c of calls) {
    const result = c.name === "get_site_weather" ? { temp_c: 31, condition: "sunny" } : { error: `unknown tool ${c.name}` };
    input.push(functionCallOutput(c, result));
  }

  // Turn 2: the model should answer using the tool result.
  const second = await respond({ instructions: INSTRUCTIONS, input, tools });
  const text = second.output_text ?? "";
  lines.push(`final output_text=${JSON.stringify(text)}`);
  const extraCalls = functionCalls(second);
  if (extraCalls.length) lines.push(`(model made ${extraCalls.length} more call(s) instead of answering)`);
  return { ok: /31|sunny/i.test(text), detail: lines.join("\n  "), usage: sumUsage([first, second]) };
}

// ---- runner ----
function rawError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: string; status?: number; message?: string; error?: unknown; stack?: string };
    const parts = [`${e.name ?? "Error"}${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message ?? String(err)}`];
    if (e.error !== undefined) parts.push(`body: ${JSON.stringify(e.error, null, 2)}`);
    return parts.join("\n  ");
  }
  return String(err);
}

function fmtUsage(u: UsageCost): string {
  return `tokens in=${u.inputTokens} out=${u.outputTokens}, est. cost $${u.costUsd.toFixed(6)}`;
}

const checks: [string, () => Promise<CheckResult>][] = [
  ["1. text", checkText],
  ["2. image", checkImage],
  ["3. tool round trip", checkToolRoundTrip],
];

console.log(`Muse Spark smoke test · model=${env.SPARK_MODEL} · baseURL=${env.META_BASE_URL || "(unset)"}`);
if (!env.SPARK_INPUT_USD_PER_MTOK && !env.SPARK_OUTPUT_USD_PER_MTOK) {
  console.log("(SPARK_*_USD_PER_MTOK not set, so cost shows $0)");
}

let failed = 0;
const total: UsageCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
for (const [name, run] of checks) {
  const started = Date.now();
  try {
    const r = await run();
    if (!r.ok) failed++;
    total.inputTokens += r.usage.inputTokens;
    total.outputTokens += r.usage.outputTokens;
    total.costUsd += r.usage.costUsd;
    console.log(`\n${r.ok ? "PASS" : "FAIL"}  ${name}  (${Date.now() - started} ms, ${fmtUsage(r.usage)})\n  ${r.detail}`);
  } catch (err) {
    failed++;
    console.log(`\nFAIL  ${name}  (${Date.now() - started} ms)\n  ${rawError(err)}`);
  }
}

console.log(`\n${checks.length - failed}/${checks.length} passed · total ${fmtUsage(total)}`);
process.exit(failed ? 1 : 0);
