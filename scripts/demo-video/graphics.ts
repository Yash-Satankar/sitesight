// Overlay graphics rendered as transparent PNGs with Playwright (real fonts, no ffmpeg text quirks):
// callouts, caption pills, and the large SAM panels (photo + masks + rejected detections from the trace data).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Browser = any;

const FONT = `'Segoe UI', system-ui, sans-serif`;

async function renderHtml(browser: Browser, html: string, width: number, out: string): Promise<{ width: number; height: number }> {
  const page = await browser.newPage({ viewport: { width, height: 200 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}*{box-sizing:border-box}</style></head><body>${html}</body></html>`);
  await page.waitForLoadState("load");
  const el = page.locator("body > *").first();
  const box = await el.boundingBox();
  await el.screenshot({ path: out, omitBackground: true });
  await page.close();
  return { width: Math.round(box.width), height: Math.round(box.height) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One big callout: bold white text on a dark card with a teal accent. */
export function renderCallout(browser: Browser, text: string, width: number, out: string) {
  return renderHtml(
    browser,
    `<div style="display:inline-block;max-width:${width}px;background:#0f172a;color:#fff;border-radius:28px;padding:30px 38px;border-left:12px solid #14b8a6;box-shadow:0 18px 40px rgba(15,23,42,.28);font:800 48px/1.18 ${FONT};letter-spacing:-.5px">${esc(text)}</div>`,
    width,
    out,
  );
}

/** Caption pill: white text on a dark, semi-opaque rounded pill. */
export function renderCaption(browser: Browser, text: string, out: string) {
  return renderHtml(
    browser,
    `<div style="display:inline-block;max-width:1560px;background:rgba(15,23,42,.82);color:#fff;border-radius:30px;padding:14px 34px 16px;text-align:center;font:600 44px/1.25 ${FONT}">${esc(text)}</div>`,
    1600,
    out,
  );
}

export interface PanelBox {
  bbox: [number, number, number, number]; // photo pixels
  label?: string;
  tone: "candidate" | "rejected";
}

/** Large SAM panel: base image (photo + masks), boxes and labels, a title chip. */
export async function renderSamPanel(
  browser: Browser,
  opts: { base: string; photoW: number; photoH: number; title: string; subtitle: string; boxes: PanelBox[]; maxW: number; maxH: number },
  out: string,
) {
  const scale = Math.min(opts.maxW / opts.photoW, (opts.maxH - 90) / opts.photoH);
  const w = Math.round(opts.photoW * scale);
  const h = Math.round(opts.photoH * scale);
  const src = `data:image/png;base64,${readFileSync(opts.base).toString("base64")}`;
  const parts = opts.boxes
    .map((b) => {
      const [x, y, bw, bh] = b.bbox.map((v) => v * scale);
      const color = b.tone === "rejected" ? "#ef4444" : "#facc15";
      const label = b.label
        ? `<div style="position:absolute;left:${Math.min(x, w - 300)}px;top:${y + bh + 6 > h - 40 ? y - 40 : y + bh + 6}px;background:${color};color:#fff;font:700 22px/1 ${FONT};padding:7px 11px;border-radius:9px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.35)">${esc(b.label)}</div>`
        : "";
      return { box: `<div style="position:absolute;left:${x}px;top:${y}px;width:${bw}px;height:${bh}px;border:4px solid ${color};border-radius:6px;box-shadow:0 0 0 2px rgba(0,0,0,.35)"></div>`, label };
    });
  // All boxes first, then the labels on top of them.
  const boxes = parts.map((p) => p.box).join("") + parts.map((p) => p.label).join("");
  return renderHtml(
    browser,
    `<div style="display:inline-block;background:#fff;border-radius:26px;padding:16px;box-shadow:0 20px 50px rgba(15,23,42,.25)">
      <div style="display:flex;align-items:baseline;gap:14px;padding:4px 6px 12px;font-family:${FONT}">
        <span style="font:800 30px/1 ${FONT};color:#0f172a">${esc(opts.title)}</span>
        <span style="font:600 22px/1 ${FONT};color:#475569">${esc(opts.subtitle)}</span>
      </div>
      <div style="position:relative;width:${w}px;height:${h}px;border-radius:14px;overflow:hidden">
        <img src="${src}" style="display:block;width:${w}px;height:${h}px"/>${boxes}
      </div>
    </div>`,
    opts.maxW + 40,
    out,
  );
}

/**
 * Base image for a panel: the photo at its normalised size (the coordinate space of bbox and masks) with the given
 * masks tinted on top.
 */
export async function panelBase(repoRoot: string, photoFile: string, w: number, h: number, maskFiles: string[], tint: [number, number, number], out: string) {
  const sharp = createRequire(join(repoRoot, "apps", "api", "package.json"))("sharp");
  let img = sharp(photoFile).rotate().resize(w, h, { fit: "fill" });
  const layers: { input: Buffer }[] = [];
  for (const m of maskFiles.filter(existsSync)) {
    const alpha = await sharp(m).resize(w, h, { fit: "fill" }).greyscale().linear(0.45, 0).raw().toBuffer();
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = tint[0];
      rgba[i * 4 + 1] = tint[1];
      rgba[i * 4 + 2] = tint[2];
      rgba[i * 4 + 3] = alpha[i]!;
    }
    layers.push({ input: await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer() });
  }
  if (layers.length) img = sharp(await img.png().toBuffer()).composite(layers);
  await img.png().toFile(out);
}

/** Short label for a rejected detection, from the agent's reason. */
export function rejectLabel(reason: string, concept: string): string {
  const r = reason.toLowerCase();
  if (/rebar|reinforcement|starter|cage/.test(r)) return "✕ rebar cage — not a column";
  if (/tarp|sheet|net/.test(r)) return /scaffold/.test(r) ? "✕ tarp on scaffolding" : "✕ tarp — not brickwork";
  if (/neighbou?r|other building|background/.test(r)) return "✕ neighbouring building";
  if (/parapet|plaster/.test(r)) return "✕ plastered — not brickwork";
  if (/scaffold|bamboo|pole|prop/.test(r)) return "✕ scaffolding — not a column";
  const short = reason.split(/[,;—-]/)[0]!.trim();
  return `✕ ${short.length > 34 ? `${short.slice(0, 32)}…` : short || concept}`;
}
