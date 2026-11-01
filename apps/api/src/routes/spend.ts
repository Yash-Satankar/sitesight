import { Router } from "express";
import { dailySpend } from "../lib/spend.js";

export const spendRouter = Router();

/** Today's Meta spend (UTC day) across all visits and drawing imports, against DAILY_SPEND_CAP_USD. */
spendRouter.get("/spend/today", async (_req, res) => {
  res.json(await dailySpend());
});
