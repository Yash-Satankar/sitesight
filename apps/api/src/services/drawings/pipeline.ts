/**
 * Drawing pages → classification → extraction (structural sheets only). Spark calls go through `meter` (cost cap).
 * No database: the import job and the boq-from-drawings dry run both use this.
 */
import { PageClassification, SheetExtraction, STRUCTURAL_SHEETS, type SheetType } from "@sitesight/shared";
import { createLimiter } from "../../lib/limit.js";
import { imagePart, respondJsonContent, type CostMeter } from "../../meta/spark.js";
import { DrawingCostLimitError } from "./cost.js";
import { CLASSIFY_INSTRUCTIONS, EXTRACT_INSTRUCTIONS } from "./prompts.js";

export async function classifyPage(png: Buffer, meter?: CostMeter): Promise<PageClassification> {
  const { data } = await respondJsonContent(PageClassification, {
    instructions: CLASSIFY_INSTRUCTIONS,
    // A smaller image is enough to tell sheet types apart.
    content: [{ type: "input_text", text: "Classify this drawing sheet." }, imagePart(png, "image/png", "low")],
    meter,
  });
  return data;
}

export async function extractSheet(png: Buffer, pageNo: number, classification: PageClassification, meter?: CostMeter): Promise<SheetExtraction> {
  const { data } = await respondJsonContent(SheetExtraction, {
    instructions: EXTRACT_INSTRUCTIONS,
    content: [
      { type: "input_text", text: `Page ${pageNo}: ${classification.sheet_type} — "${classification.title}". Transcribe it.` },
      imagePart(png, "image/png", "high"),
    ],
    meter,
  });
  return data;
}

export const isStructural = (t: SheetType | null | undefined) => !!t && STRUCTURAL_SHEETS.includes(t);

export interface PageState {
  pageNo: number;
  classification: PageClassification | null;
  extraction: SheetExtraction | null;
  /** Set when a step for this page failed (other pages continue). */
  error: string | null;
}

export interface PipelineHooks {
  /** Bytes of a page (lazy, so a big set is not held in memory twice). */
  png(pageNo: number): Promise<Buffer>;
  onClassified?(pageNo: number, c: PageClassification): Promise<void> | void;
  onExtracted?(pageNo: number, e: SheetExtraction): Promise<void> | void;
  onSkipped?(pageNo: number): Promise<void> | void;
  onFailed?(pageNo: number, error: string): Promise<void> | void;
}

/**
 * Classify every page, then extract the structural ones. Pages already done (from an earlier attempt) are kept.
 * Stops starting calls once the cost cap is hit and returns `{ stoppedByCost: true }` with what was done.
 */
export async function runPipeline(
  pages: PageState[],
  hooks: PipelineHooks,
  meter: CostMeter,
  concurrency = 3,
): Promise<{ pages: PageState[]; stoppedByCost: boolean }> {
  const limit = createLimiter(concurrency);
  let stoppedByCost = false;

  async function step(page: PageState, fn: () => Promise<void>) {
    if (stoppedByCost) return;
    try {
      await fn();
    } catch (err) {
      if (err instanceof DrawingCostLimitError) {
        stoppedByCost = true;
        return;
      }
      page.error = err instanceof Error ? err.message : String(err);
      await hooks.onFailed?.(page.pageNo, page.error);
    }
  }

  await Promise.all(
    pages
      .filter((p) => !p.classification)
      .map((p) =>
        limit(() =>
          step(p, async () => {
            p.classification = await classifyPage(await hooks.png(p.pageNo), meter);
            p.error = null;
            await hooks.onClassified?.(p.pageNo, p.classification);
            if (!isStructural(p.classification.sheet_type)) await hooks.onSkipped?.(p.pageNo);
          }),
        ),
      ),
  );

  await Promise.all(
    pages
      .filter((p) => p.classification && isStructural(p.classification.sheet_type) && !p.extraction)
      .map((p) =>
        limit(() =>
          step(p, async () => {
            p.extraction = await extractSheet(await hooks.png(p.pageNo), p.pageNo, p.classification!, meter);
            p.error = null;
            await hooks.onExtracted?.(p.pageNo, p.extraction);
          }),
        ),
      ),
  );

  return { pages, stoppedByCost };
}
