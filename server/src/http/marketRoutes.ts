import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { symbolSchema, timeframeSchema } from "../config/symbols.js";
import type { MarketService } from "../market/service.js";
import { validate } from "./validate.js";

const candlesQuery = z.object({
  symbol: symbolSchema,
  interval: timeframeSchema.default("1h"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const priceQuery = z.object({ symbol: symbolSchema });

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export function createMarketRouter(market: MarketService): Router {
  const router = Router();

  router.get(
    "/candles",
    validate({ query: candlesQuery }),
    wrap(async (req, res) => {
      const { symbol, interval, limit } = req.query as unknown as z.infer<typeof candlesQuery>;
      res.json(await market.getCandles(symbol, interval, limit));
    }),
  );

  router.get(
    "/price",
    validate({ query: priceQuery }),
    wrap(async (req, res) => {
      const { symbol } = req.query as unknown as z.infer<typeof priceQuery>;
      res.json(await market.getPrice(symbol));
    }),
  );

  router.get(
    "/pivots",
    validate({ query: priceQuery }),
    wrap(async (req, res) => {
      const { symbol } = req.query as unknown as z.infer<typeof priceQuery>;
      res.json(await market.getPivots(symbol));
    }),
  );

  return router;
}
