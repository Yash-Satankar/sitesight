import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config.js";

// The bucket is private. Browsers only ever see short-lived presigned URLs.
// With STORAGE_LOCAL_DIR set (scripts, local dev), objects are files under that folder instead and R2 is never used.
let client: S3Client | null = null;

function localPath(key: string): string | null {
  if (!env.STORAGE_LOCAL_DIR) return null;
  const root = resolve(env.STORAGE_LOCAL_DIR);
  const path = resolve(root, key);
  if (!path.startsWith(root + sep)) throw new Error(`Storage key escapes STORAGE_LOCAL_DIR: ${key}`);
  return path;
}

/**
 * Local mode: the API serves objects at /storage/<key> (routes/storage.ts). URLs are signed with
 * STORAGE_SIGNING_SECRET (stable across restarts) or, without it, a per-process random key, so only URLs this API
 * handed out work, and only until they expire.
 */
const LOCAL_SECRET = env.STORAGE_SIGNING_SECRET ? Buffer.from(env.STORAGE_SIGNING_SECRET, "utf8") : randomBytes(32);

function localSignature(key: string, method: "GET" | "PUT", expires: number): string {
  return createHmac("sha256", LOCAL_SECRET).update([method, key, String(expires)].join("\n")).digest("base64url");
}

function localUrl(key: string, method: "GET" | "PUT", expiresIn: number): string {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const path = key.split("/").map(encodeURIComponent).join("/");
  // Absolute with PUBLIC_API_URL (deployed: browsers fetch straight from the API); relative otherwise (dev proxy).
  return `${env.PUBLIC_API_URL}/storage/${path}?exp=${expires}&sig=${localSignature(key, method, expires)}`;
}

/** Check a /storage URL signature. Returns an error message, or null when valid. */
export function verifyLocalUrl(key: string, method: "GET" | "PUT", exp: string | undefined, sig: string | undefined): string | null {
  const expires = Number(exp);
  if (!sig || !Number.isInteger(expires)) return "missing signature";
  if (expires < Date.now() / 1000) return "link expired";
  const expected = Buffer.from(localSignature(key, method, expires));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "bad signature";
  return null;
}

export function usingLocalStorage(): boolean {
  return Boolean(env.STORAGE_LOCAL_DIR);
}

function s3(): S3Client {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set");
  }
  client ??= new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return client;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
};

export function newKey(prefix: string, contentType: string): string {
  return `${prefix}/${randomUUID()}.${EXT[contentType] ?? "bin"}`;
}

export async function presignPut(key: string, contentType: string, expiresIn = 600): Promise<string> {
  if (localPath(key)) return localUrl(key, "PUT", expiresIn);
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: contentType }), {
    expiresIn,
  });
}

export async function presignGet(key: string, expiresIn = 3600): Promise<string> {
  if (localPath(key)) return localUrl(key, "GET", expiresIn);
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), { expiresIn });
}

export async function getObject(key: string): Promise<Buffer> {
  const local = localPath(key);
  if (local) return readFile(local);
  const res = await s3().send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty object: ${key}`);
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const local = localPath(key);
  if (local) {
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, body);
    return;
  }
  await s3().send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/** Delete an object; a missing object is not an error. */
export async function deleteObject(key: string): Promise<void> {
  const local = localPath(key);
  if (local) {
    await rm(local, { force: true });
    return;
  }
  await s3().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}
