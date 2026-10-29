/**
 * PDF → one PNG per page, server-side, with no system installs: pdfjs-dist renders into @napi-rs/canvas
 * (prebuilt binaries for Windows/macOS/Linux). Pages are scaled so the long edge is at most `maxEdge` px.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

export interface RasterPage {
  pageNo: number;
  png: Buffer;
  width: number;
  height: number;
}

export class PdfError extends Error {}

const require = createRequire(import.meta.url);
const pdfjsDir = dirname(require.resolve("pdfjs-dist/package.json"));

export async function pdfPageCount(pdf: Buffer): Promise<number> {
  const doc = await open(pdf);
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

export async function rasterizePdf(pdf: Buffer, opts: { maxEdge?: number; maxPages?: number } = {}): Promise<RasterPage[]> {
  const maxEdge = opts.maxEdge ?? 2000;
  const doc = await open(pdf);
  try {
    if (opts.maxPages != null && doc.numPages > opts.maxPages) {
      throw new PdfError(`The PDF has ${doc.numPages} pages; the limit is ${opts.maxPages}. Split it or upload only the structural sheets.`);
    }
    const out: RasterPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // Never upscale tiny pages beyond 4× (keeps memory sane); big sheets (A1/A0) scale down to maxEdge.
      const scale = Math.min(maxEdge / Math.max(base.width, base.height), 4);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.min(maxEdge, Math.round(viewport.width)));
      const height = Math.max(1, Math.min(maxEdge, Math.round(viewport.height)));
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
      out.push({ pageNo: n, png: await canvas.encode("png"), width, height });
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

async function open(pdf: Buffer) {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new PdfError("Not a PDF file");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    return await pdfjs.getDocument({
      data: new Uint8Array(pdf),
      standardFontDataUrl: join(pdfjsDir, "standard_fonts") + "/",
      cMapUrl: join(pdfjsDir, "cmaps") + "/",
      cMapPacked: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (err) {
    throw new PdfError(`Could not read the PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
}
