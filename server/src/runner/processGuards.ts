import type { Logger } from "../logging/logger.js";

/**
 * An unhandled rejection or uncaught exception is logged and the process keeps running
 * (systemd restarts it anyway if it ever does exit). Only the error message and stack are logged.
 */
export function installProcessGuards(logger: Logger, proc: Pick<NodeJS.Process, "on"> = process): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    logger.error({ err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason) }, "unhandled promise rejection (kept running)");
  });
  proc.on("uncaughtException", (err: Error) => {
    logger.error({ err: { message: err.message, stack: err.stack } }, "uncaught exception (kept running)");
  });
}
