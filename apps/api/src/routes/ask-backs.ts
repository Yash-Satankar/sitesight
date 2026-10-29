import { Router } from "express";
import { FulfilAskBackBody } from "@sitesight/shared";
import { intParam, parse } from "../lib/http.js";
import { fulfilAskBack, skipAskBack } from "../services/ask-backs.js";

export const askBacksRouter = Router();

/** The photo may come from any visit of the project (e.g. today's visit answering last week's request). */
askBacksRouter.post("/ask-backs/:id/fulfil", async (req, res) => {
  const { photoId } = parse(FulfilAskBackBody, req.body);
  res.json(await fulfilAskBack(intParam(req.params.id), photoId));
});

askBacksRouter.post("/ask-backs/:id/skip", async (req, res) => {
  res.json(await skipAskBack(intParam(req.params.id)));
});
