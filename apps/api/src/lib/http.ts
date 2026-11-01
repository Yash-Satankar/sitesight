import type { ErrorRequestHandler } from "express";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, "Invalid request", r.error.flatten());
  return r.data;
}

export function intParam(v: string | string[] | undefined, name = "id"): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`);
}

/**
 * JSON errors only, never stack traces. Body-parser errors (bad JSON, too large) keep their 4xx status.
 * In production an unexpected error's message is logged but not returned (it can name internals).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return void res.end();
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status < 500) {
    const message =
      err?.type === "entity.too.large" ? "Request body too large" : err?.type === "entity.parse.failed" ? "Invalid JSON body" : "Bad request";
    res.status(status).json({ error: message });
    return;
  }
  console.error(`[api] ${req.method} ${req.path}:`, err);
  const production = process.env.NODE_ENV === "production";
  res.status(500).json({ error: production || !(err instanceof Error) ? "Something went wrong on the server." : err.message });
};
