import ExcelJS from "exceljs";
import { BoqParseResult, type BoqItemInput } from "@sitesight/shared";
import { respondJson } from "../meta/spark.js";
import { BOQ_PARSE_INSTRUCTIONS } from "../agent/prompts.js";

const ROWS_PER_CHUNK = 80;

/** xlsx → raw rows → Muse Spark → validated BoqItemInput[] for the engineer to review. */
export async function parseBoq(xlsx: Buffer): Promise<{ items: BoqItemInput[]; warnings: string[] }> {
  const rows = await readRows(xlsx);
  if (rows.length === 0) return { items: [], warnings: ["No rows found in the workbook."] };

  const items: BoqItemInput[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
    const chunk = rows.slice(i, i + ROWS_PER_CHUNK);
    const text = chunk.map((r) => r.join(" | ")).join("\n");
    const result = await respondJson(BoqParseResult, BOQ_PARSE_INSTRUCTIONS, text);
    items.push(...result.items.map((it) => ({ ...it, zoneId: null })));
    warnings.push(...result.warnings);
  }
  return { items, warnings };
}

/** Rows of the sheet with the most non-empty rows, as trimmed cell strings. */
async function readRows(xlsx: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);

  let best: string[][] = [];
  wb.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell).trim()));
      if (cells.some((c) => c.length > 0)) rows.push(cells);
    });
    if (rows.length > best.length) best = rows;
  });
  return best;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "object") {
    if ("result" in v) return String(v.result ?? "");
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
  }
  return String(v);
}
