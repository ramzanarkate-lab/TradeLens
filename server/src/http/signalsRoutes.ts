import { Router } from "express";
import { z } from "zod";
import { symbolSchema } from "../config/symbols.js";
import { computeStats } from "../signals/stats.js";
import type { SignalStore } from "../signals/store.js";
import type { Role } from "../types/index.js";
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

/** How many of the newest signals each kind of visitor may read. Guests: the last 5. Signed-in users: the full history. */
export const SIGNAL_ACCESS = { guest: 5, user: 1_000_000, pro: 1_000_000, admin: 1_000_000 } as const;

export function signalCapFor(role: Role | undefined): number {
  return SIGNAL_ACCESS[role ?? "guest"];
}

export function createSignalsRouter(store: SignalStore): Router {
  const router = Router();

  router.get("/signals", validate({ query: listQuery }), (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const role = req.user?.role ?? "guest";
    const cap = signalCapFor(req.user?.role);
    // A guest gets the newest 5 matching signals and no paging.
    const limit = Math.min(q.limit, cap);
    const offset = role === "guest" ? 0 : q.offset;
    const { signals, total } = store.query({ symbol: q.symbol, side: q.side, status: q.status, from: q.from, to: q.to, limit, offset });
    res.json({
      signals,
      cap, // tells the app how far this account can see, so it can show the right lock message
      role,
      total,
      limit,
      offset,
      hasMore: role !== "guest" && offset + signals.length < total,
      locked: role === "guest" && total > cap,
    });
  });

  // Registered before /signals/:id so "stats" is not read as an id.
  router.get("/signals/stats", validate({ query: statsQuery }), (req, res) => {
    const q = req.query as unknown as z.infer<typeof statsQuery>;
    const { signals } = store.query({ symbol: q.symbol, from: q.from, to: q.to, limit: Number.MAX_SAFE_INTEGER });
    const stats = computeStats(signals);
    const full = req.user?.role === "pro" || req.user?.role === "admin";
    // Everyone sees the win rate and the counts. Pro and admin see the rest.
    res.json(
      full
        ? { tier: "full", ...stats }
        : { tier: "basic", total: stats.total, open: stats.open, closed: stats.closed, wins: stats.wins, winRate: stats.winRate },
    );
  });

  router.get("/signals/:id", validate({ params: idParams }), (req, res, next) => {
    if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "Sign in to see the full details of a signal."));
    const signal = store.get(req.params.id as string);
    if (!signal) return next(new AppError(404, "SIGNAL_NOT_FOUND", "No signal with that id."));
    res.json(signal);
  });

  return router;
}
