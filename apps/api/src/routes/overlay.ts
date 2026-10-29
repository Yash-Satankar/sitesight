import { Router } from "express";
import { intParam } from "../lib/http.js";
import { idList, renderOverlay } from "../services/photo-overlay.js";

export const overlayRouter = Router();

/**
 * GET /photos/:id/overlay?segments=1,2,3&panel=5&max=900
 * The photo with the given (or all kept) segment masks and measured panels drawn on it. Rejected segments are hidden.
 */
overlayRouter.get("/photos/:id/overlay", async (req, res) => {
  const png = await renderOverlay(intParam(req.params.id), {
    segmentIds: idList(req.query.segments, "segments"),
    panelIds: idList(req.query.panel, "panel"),
    maxEdge: req.query.max ? Number(req.query.max) : undefined,
  });
  res.set("Cache-Control", "private, max-age=300").type("png").send(png);
});
