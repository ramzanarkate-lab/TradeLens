import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "./errors.js";

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/** Validates (and replaces) req.body / req.query / req.params with the parsed zod output. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const detail = result.error.issues.map((i) => `${[part, ...i.path].join(".")}: ${i.message}`).join("; ");
        return next(new AppError(400, "VALIDATION_ERROR", detail));
      }
      if (part === "query") {
        // Express 4 allows reassigning req.query; keep the parsed values.
        Object.defineProperty(req, "query", { value: result.data, writable: true, configurable: true });
      } else {
        (req as unknown as Record<string, unknown>)[part] = result.data;
      }
    }
    next();
  };
}
