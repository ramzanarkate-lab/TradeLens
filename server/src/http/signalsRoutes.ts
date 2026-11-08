import { Router } from "express";
import { z } from "zod";
import { symbolSchema } from "../config/symbols.js";
import { computeStats } from "../signals/stats.js";
import type { SignalStore } from "../signals/store.js";
import { requireUser } from "../auth/middleware.js";
import { AppError } from "./errors.js";
import { validate } from "./validate.js";

const STATUS = z.enum(["OPEN", "TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT", "BREAKEVEN_EXIT", "TIME_EXIT"]);

/** A date as epoch milliseconds or an ISO date/time string. */
const when = z
  .union([z.coerce.number().int().min(0), z.iso.datetime({ offset: true }).transform((v) => Date.parse(v)), z.iso.date().transform((v) => Date.parse(v))])
  .optional();

const listQuery = z.object({
  symbol: symbolSchema.optional(),
  side: z.enum(["BUY", "SELL"]).optional(),
  status: STATUS.optional(),
  from: when,
  to: when,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const statsQuery = z.object({ symbol: symbolSchema.optional(), from: when, to: when });
const idParams = z.object({ id: z.uuid() });

export function createSignalsRouter(store: SignalStore): Router {
  const router = Router();

  // Live signals are free, but only for signed-in (Google) accounts. Guests get 401.
  router.get("/signals", requireUser, validate({ query: listQuery }), (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const { signals, total } = store.query({ symbol: q.symbol, side: q.side, status: q.status, from: q.from, to: q.to, limit: q.limit, offset: q.offset });
    res.json({ signals, role: req.user!.role, total, limit: q.limit, offset: q.offset, hasMore: q.offset + signals.length < total, locked: false });
  });

  // Registered before /signals/:id so "stats" is not read as an id.
  router.get("/signals/stats", requireUser, validate({ query: statsQuery }), (req, res) => {
    const q = req.query as unknown as z.infer<typeof statsQuery>;
    const { signals } = store.query({ symbol: q.symbol, from: q.from, to: q.to, limit: Number.MAX_SAFE_INTEGER });
    const stats = computeStats(signals);
    res.json({ tier: "full", ...stats });
  });

  router.get("/signals/:id", validate({ params: idParams }), (req, res, next) => {
    if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "Sign in to see the full details of a signal."));
    const signal = store.get(req.params.id as string);
    if (!signal) return next(new AppError(404, "SIGNAL_NOT_FOUND", "No signal with that id."));
    res.json(signal);
  });

  return router;
}
