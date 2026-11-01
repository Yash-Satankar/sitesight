import { Router } from "express";
import { env } from "../config.js";
import { HttpError } from "../lib/http.js";
import { SESSION_COOKIE, authRequired, createLoginLimiter, makeSession, passwordMatches, readCookie, validSession } from "../lib/auth.js";

export const authRouter = Router();
const limiter = createLoginLimiter();

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.NODE_ENV === "production",
  path: "/",
});

/** Whether the demo needs a password, and whether this browser is logged in. */
authRouter.get("/auth/me", (req, res) => {
  res.json({ authRequired: authRequired(), authenticated: !authRequired() || validSession(readCookie(req.get("cookie"), SESSION_COOKIE)) });
});

authRouter.post("/auth/login", (req, res) => {
  if (!authRequired()) return void res.json({ ok: true });
  const ip = req.ip ?? "unknown";
  if (limiter.blocked(ip)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  if (!passwordMatches(req.body?.password)) {
    limiter.fail(ip);
    throw new HttpError(401, "Wrong password.");
  }
  limiter.reset(ip);
  const { value, maxAgeMs } = makeSession();
  res.cookie(SESSION_COOKIE, value, { ...cookieOptions(), maxAge: maxAgeMs });
  res.json({ ok: true });
});

authRouter.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true });
});
