// The only file that constructs the OpenAI SDK. Nothing outside meta/ may import "openai".
import OpenAI from "openai";
import { env } from "../config.js";

let instance: OpenAI | null = null;

export function metaClient(): OpenAI {
  if (!env.META_API_KEY || !env.META_BASE_URL) {
    throw new Error("META_API_KEY and META_BASE_URL must be set (copy the base URL from the Meta dashboard).");
  }
  instance ??= new OpenAI({
    apiKey: env.META_API_KEY,
    baseURL: env.META_BASE_URL,
    // The SDK retries 408/409/429/5xx with exponential backoff.
    maxRetries: 4,
    timeout: 120_000,
  });
  return instance;
}
