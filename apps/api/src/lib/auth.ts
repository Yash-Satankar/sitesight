/**
 * Demo access gate. With DEMO_PASSWORD set, browsers log in once and get a signed, HttpOnly session cookie.
 * The signing key is derived from SESSION_SECRET and the password, so changing either logs everyone out. No accounts.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config.js";

export const SESSION_COOKIE = "sitesight_session";
export const SESSION_DAYS = 7;

export const authRequired = () => env.DEMO_PASSWORD.length > 0;

function key(): Buffer {
  return createHash("sha256").update(`sitesight-session:${env.SESSION_SECRET}:${env.DEMO_PASSWORD}`).digest();
}
function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "<expires>.<signature>" */
export function makeSession(now = Date.now()): { value: string; maxAgeMs: number } {
  const maxAgeMs = SESSION_DAYS * 24 * 3600 * 1000;
  const exp = String(Math.floor((now + maxAgeMs) / 1000));
  return { value: `${exp}.${sign(exp)}`, maxAgeMs };
}

export function validSession(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < now) return false;
  return safeEqual(sig, sign(exp));
}

/** Compare against DEMO_PASSWORD without leaking its length or content through timing. */
export function passwordMatches(given: unknown): boolean {
  if (typeof given !== "string" || !authRequired()) return false;
  const h = (s: string) => createHash("sha256").update(s).digest("base64");
  return safeEqual(h(given), h(env.DEMO_PASSWORD));
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Paths that never need the cookie: health checks, the login itself, and signed storage URLs (signed separately). */
const PUBLIC = [/^\/healthz$/, /^\/health$/, /^\/auth\//, /^\/storage\//];

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!authRequired() || req.method === "OPTIONS" || PUBLIC.some((re) => re.test(req.path))) return next();
  if (validSession(readCookie(req.get("cookie"), SESSION_COOKIE))) return next();
  res.status(401).json({ error: "Log in to use the demo.", authRequired: true });
};

/** At most `max` failed logins per IP per window; resets on success. In-memory (one process). */
export function createLoginLimiter(max = 10, windowMs = 10 * 60_000) {
  const failures = new Map<string, { n: number; until: number }>();
  return {
    blocked(ip: string, now = Date.now()): boolean {
      const f = failures.get(ip);
      return !!f && f.until > now && f.n >= max;
    },
    fail(ip: string, now = Date.now()) {
      const f = failures.get(ip);
      if (!f || f.until <= now) failures.set(ip, { n: 1, until: now + windowMs });
      else f.n++;
    },
    reset(ip: string) {
      failures.delete(ip);
    },
  };
}
