import express, { Router } from "express";
import { extname } from "node:path";
import { HttpError } from "../lib/http.js";
import { getObject, putObject, verifyLocalUrl } from "../services/storage.js";

/**
 * Local storage mode only (STORAGE_LOCAL_DIR): stands in for R2's presigned URLs so browsers (incl. a phone on
 * the LAN) can upload and view photos without R2. Every request needs a signature from presignPut/presignGet.
 */
export const storageRouter = Router();

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
};

function keyOf(req: express.Request): string {
  const parts = (req.params as { key?: string[] }).key ?? [];
  const key = parts.join("/");
  if (!key) throw new HttpError(400, "Missing storage key");
  return key;
}

function check(req: express.Request, key: string, method: "GET" | "PUT") {
  const problem = verifyLocalUrl(key, method, req.query.exp as string | undefined, req.query.sig as string | undefined);
  if (problem) throw new HttpError(403, `Storage URL rejected: ${problem}`);
}

storageRouter.put("/storage/*key", express.raw({ type: () => true, limit: "25mb" }), async (req, res) => {
  const key = keyOf(req);
  check(req, key, "PUT");
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) throw new HttpError(400, "Empty upload");
  await putObject(key, body, req.get("content-type") ?? "application/octet-stream");
  res.status(200).end();
});

storageRouter.get("/storage/*key", async (req, res) => {
  const key = keyOf(req);
  check(req, key, "GET");
  const body = await getObject(key).catch(() => {
    throw new HttpError(404, "Not found");
  });
  res.type(TYPES[extname(key).toLowerCase()] ?? "application/octet-stream").send(body);
});
