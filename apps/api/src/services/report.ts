import PDFDocument from "pdfkit";
import { INFERRED_STATUS, type EvidenceBasis } from "@sitesight/shared";

export interface ReportItem {
  code: string;
  description: string;
  unit: string;
  plannedQty: number;
  percentComplete: number;
  qtyDone: number | null;
  confidence: number;
  rationale: string;
  status: string;
  engineerNote: string | null;
  /** inferred items are listed separately and left out of the bill summary. */
  basis: EvidenceBasis;
  evidence: Buffer[]; // JPEG crops or overlays
}

export interface ReportData {
  projectName: string;
  locationLabel: string;
  visitDate: string;
  items: ReportItem[];
  /** BOQ items with no assessment yet but an open photo request ("awaiting photo (ask-back #N)"). */
  pending?: { code: string; description: string; status: string; instruction: string }[];
  /** For tests: write uncompressed content streams. */
  compress?: boolean;
}

/** Billable lines: observed items with a quantity. Inferred quantities are never billed until observed. */
export function billLines(items: ReportItem[]): { code: string; description: string; qty: number; unit: string; percent: number }[] {
  return items
    .filter((i) => i.basis === "observed" && i.qtyDone != null)
    .map((i) => ({ code: i.code, description: i.description, qty: i.qtyDone!, unit: i.unit, percent: i.percentComplete }));
}

/** Bill-ready progress report. Returns the PDF bytes. */
export function buildReport(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, compress: data.compress ?? true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const heading = (text: string) => {
      if (doc.y > 680) doc.addPage();
      doc.fontSize(13).font("Helvetica-Bold").fillColor("#000").text(text);
      doc.font("Helvetica").fontSize(10).moveDown(0.3);
    };

    doc.fontSize(20).text("Site Progress Report", { align: "left" });
    doc.moveDown(0.3).fontSize(11).fillColor("#444");
    doc.text(`Project: ${data.projectName}`);
    if (data.locationLabel) doc.text(`Location: ${data.locationLabel}`);
    doc.text(`Visit date: ${data.visitDate}`);
    doc.text(`Generated: ${new Date().toISOString().slice(0, 10)} by SiteSight`);
    doc.fillColor("#000").moveDown();

    const observed = data.items.filter((i) => i.basis === "observed");
    const inferred = data.items.filter((i) => i.basis === "inferred");

    // ---- bill summary: observed quantities only ----
    heading("Bill summary (observed work only)");
    const lines = billLines(data.items);
    if (!lines.length) doc.text("No billable quantities in this report.");
    for (const l of lines) doc.text(`${l.code}  ${l.description}: ${l.qty} ${l.unit} (${l.percent.toFixed(0)}%)`);
    doc.fillColor("#444").text(
      inferred.length
        ? `${lines.length} billable item(s). ${inferred.length} inferred item(s) excluded until observed (listed below).`
        : `${lines.length} billable item(s).`,
    );
    doc.fillColor("#000").moveDown();

    // ---- observed items in detail ----
    for (const item of observed) itemBlock(doc, item);

    // ---- inferred: shown, never billed ----
    if (inferred.length) {
      heading(`Inferred work (${INFERRED_STATUS})`);
      for (const item of inferred) itemBlock(doc, { ...item, status: INFERRED_STATUS });
    }

    if (data.pending?.length) {
      heading("Awaiting photos");
      for (const p of data.pending) {
        doc.font("Helvetica-Bold").text(`${p.code}  ${p.description}`, { continued: false });
        doc.font("Helvetica").fillColor("#444").text(`${p.status}. Requested: ${p.instruction}`);
        doc.fillColor("#000").moveDown(0.5);
      }
      doc.moveDown();
    }

    doc.fontSize(8).fillColor("#666").text(
      "Estimates are evidence-backed and confirmed by the site engineer; they are not a substitute for formal measurement.",
    );
    doc.end();
  });
}

function itemBlock(doc: PDFKit.PDFDocument, item: ReportItem) {
  if (doc.y > 680) doc.addPage();
  doc.fontSize(12).font("Helvetica-Bold").fillColor("#000").text(`${item.code}  ${item.description}`);
  doc.font("Helvetica").fontSize(10);
  const qty = item.qtyDone != null ? `${item.qtyDone} / ${item.plannedQty} ${item.unit}` : `planned ${item.plannedQty} ${item.unit}`;
  doc.text(
    `Progress: ${item.percentComplete.toFixed(0)}%   Qty: ${qty}   Confidence: ${(item.confidence * 100).toFixed(0)}%   Status: ${item.status}`,
  );
  doc.fillColor("#444").text(item.rationale);
  if (item.engineerNote) doc.text(`Engineer note: ${item.engineerNote}`);
  doc.fillColor("#000");
  if (item.evidence.length) {
    const y = doc.y + 6;
    item.evidence.slice(0, 3).forEach((img, i) => {
      doc.image(img, 48 + i * 170, y, { fit: [160, 120] });
    });
    doc.y = y + 128;
  }
  doc.moveDown();
}
