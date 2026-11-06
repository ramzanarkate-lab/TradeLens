import pino, { type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level: string;
  /** Pretty-print for development; JSON lines otherwise. */
  pretty: boolean;
}

export function createLogger({ level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    redact: ["req.headers.authorization", "*.token", "*.secret"],
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } } }
      : {}),
  });
}
