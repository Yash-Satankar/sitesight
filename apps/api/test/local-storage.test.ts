/**
 * Local storage mode (no R2): signed /storage URLs served by the API, and LAN origins for phone testing.
 * STORAGE_LOCAL_DIR is set before the app modules load (dynamic imports below).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "sitesight-storage-"));

const storage = await import("../src/services/storage.js");
const { isAllowedOrigin, isPrivateHost } = await import("../src/lib/origins.js");
const express = (await import("express")).default;
const { storageRouter } = await import("../src/routes/storage.js");
const { errorHandler } = await import("../src/lib/http.js");

describe("signed local storage URLs", () => {
  it("presigned URLs are relative /storage paths with an expiry and signature", async () => {
    expect(storage.usingLocalStorage()).toBe(true);
    const url = await storage.presignPut("visits/1/photos/a b.jpg", "image/jpeg");
    expect(url).toMatch(/^\/storage\/visits\/1\/photos\/a%20b\.jpg\?exp=\d+&sig=[\w-]+$/);
  });

  it("accepts only the same key, method and an unexpired signature", async () => {
    const url = new URL(await storage.presignGet("visits/1/photos/x.jpg", 60), "http://h");
    const [exp, sig] = [url.searchParams.get("exp")!, url.searchParams.get("sig")!];
    expect(storage.verifyLocalUrl("visits/1/photos/x.jpg", "GET", exp, sig)).toBeNull();
    expect(storage.verifyLocalUrl("visits/1/photos/x.jpg", "PUT", exp, sig)).toBe("bad signature");
    expect(storage.verifyLocalUrl("visits/1/photos/y.jpg", "GET", exp, sig)).toBe("bad signature");
    expect(storage.verifyLocalUrl("visits/1/photos/x.jpg", "GET", String(Number(exp) + 1), sig)).toBe("bad signature");
    expect(storage.verifyLocalUrl("visits/1/photos/x.jpg", "GET", exp, undefined)).toBe("missing signature");
    const expired = new URL(await storage.presignGet("visits/1/photos/x.jpg", -10), "http://h");
    expect(storage.verifyLocalUrl("visits/1/photos/x.jpg", "GET", expired.searchParams.get("exp")!, expired.searchParams.get("sig")!)).toBe("link expired");
  });
});

describe("storage routes (upload and download over HTTP)", () => {
  let base = "";
  let close: () => void = () => {};
  beforeAll(async () => {
    const app = express();
    app.use(storageRouter);
    app.use(errorHandler);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("round-trips a photo through presigned PUT and GET", async () => {
    const key = "visits/7/photos/site photo.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const put = await fetch(base + (await storage.presignPut(key, "image/jpeg")), { method: "PUT", body: bytes, headers: { "Content-Type": "image/jpeg" } });
    expect(put.status).toBe(200);
    expect(await storage.getObject(key)).toEqual(bytes);

    const get = await fetch(base + (await storage.presignGet(key)));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toMatch(/^image\/jpeg/);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
  });

  it("refuses voice notes over 4 MB with a clear message (photos may be bigger)", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
    const voice = await fetch(base + (await storage.presignPut("visits/7/voice/long.wav", "audio/wav")), { method: "PUT", body: big, headers: { "Content-Type": "audio/wav" } });
    expect(voice.status).toBe(413);
    expect((await voice.json()).error).toBe("Voice note too large (4.0 MB). The limit is 4 MB: record a note under 60 seconds.");
    await expect(storage.getObject("visits/7/voice/long.wav")).rejects.toThrow();
    const okVoice = await fetch(base + (await storage.presignPut("visits/7/voice/short.wav", "audio/wav")), { method: "PUT", body: big.subarray(0, 4 * 1024 * 1024), headers: { "Content-Type": "audio/wav" } });
    expect(okVoice.status).toBe(200);
    const photo = await fetch(base + (await storage.presignPut("visits/7/photos/big.jpg", "image/jpeg")), { method: "PUT", body: big, headers: { "Content-Type": "image/jpeg" } });
    expect(photo.status).toBe(200);
  });

  it("refuses unsigned, wrongly signed and cross-method requests", async () => {
    const key = "visits/7/photos/b.jpg";
    const putUrl = await storage.presignPut(key, "image/jpeg");
    expect((await fetch(`${base}/storage/${key}`, { method: "PUT", body: "x" })).status).toBe(403);
    expect((await fetch(base + putUrl.replace(/sig=[^&]+/, "sig=forged"), { method: "PUT", body: "x" })).status).toBe(403);
    expect((await fetch(base + putUrl)).status).toBe(403); // a PUT signature does not allow GET
    const other = await storage.presignPut("visits/7/photos/c.jpg", "image/jpeg");
    expect((await fetch(base + other.replace("c.jpg", "d.jpg"), { method: "PUT", body: "x" })).status).toBe(403);
  });
});

describe("browser origins", () => {
  it("allows the configured web origin, LAN addresses in dev, and requests without an Origin", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    for (const o of ["https://192.168.1.23:5173", "http://10.0.0.5:5173", "https://172.20.1.2:5173", "http://my-laptop.local:5173"]) {
      expect(isAllowedOrigin(o)).toBe(true);
    }
  });

  it("refuses public origins and non-http schemes", () => {
    for (const o of ["https://evil.example.com", "http://8.8.8.8:5173", "https://172.32.0.1", "file://192.168.1.2", "not a url"]) {
      expect(isAllowedOrigin(o)).toBe(false);
    }
    expect(isPrivateHost("192.169.0.1")).toBe(false);
  });
});
