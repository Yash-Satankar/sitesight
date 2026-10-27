import PDFDocument from "pdfkit";

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
  evidence: Buffer[]; // JPEG crops or overlays
}

export interface ReportData {
  projectName: string;
  locationLabel: string;
  visitDate: string;
  items: ReportItem[];
}

/** Bill-ready progress report. Returns the PDF bytes. */
export function buildReport(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("Site Progress Report", { align: "left" });
    doc.moveDown(0.3).fontSize(11).fillColor("#444");
    doc.text(`Project: ${data.projectName}`);
    if (data.locationLabel) doc.text(`Location: ${data.locationLabel}`);
    doc.text(`Visit date: ${data.visitDate}`);
    doc.text(`Generated: ${new Date().toISOString().slice(0, 10)} by SiteSight`);
    doc.fillColor("#000").moveDown();

    for (const item of data.items) {
      if (doc.y > 680) doc.addPage();
      doc.fontSize(12).font("Helvetica-Bold").text(`${item.code}  ${item.description}`);
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

    doc.fontSize(8).fillColor("#666").text(
      "Estimates are evidence-backed and confirmed by the site engineer; they are not a substitute for formal measurement.",
    );
    doc.end();
  });
}
