import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { isSymbol } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";

export const STATIC_TOPICS = ["signals", "settings", "status"] as const;
/** Candle topics are per symbol: "candles:BTCUSDT". */
export const CANDLE_TOPIC_PREFIX = "candles:";
export const candleTopic = (symbol: string) => `${CANDLE_TOPIC_PREFIX}${symbol}`;
export type Topic = string;

export function isValidTopic(topic: string): boolean {
  if ((STATIC_TOPICS as readonly string[]).includes(topic)) return true;
  return topic.startsWith(CANDLE_TOPIC_PREFIX) && isSymbol(topic.slice(CANDLE_TOPIC_PREFIX.length));
}

const clientMessageSchema = z.object({
  type: z.enum(["subscribe", "unsubscribe"]),
  topic: z.string().refine(isValidTopic),
});

interface ClientState {
  id: string;
  topics: Set<Topic>;
  alive: boolean;
}

export interface HubOptions {
  logger: Logger;
  path?: string;
  heartbeatMs?: number;
}

/** WebSocket hub: topic subscriptions, broadcast, heartbeat. */
export class WsHub {
  private wss?: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private heartbeat?: NodeJS.Timeout;
  private readonly logger: Logger;
  private readonly path: string;
  private readonly heartbeatMs: number;

  constructor({ logger, path = "/ws", heartbeatMs = 30_000 }: HubOptions) {
    this.logger = logger.child({ module: "ws" });
    this.path = path;
    this.heartbeatMs = heartbeatMs;
  }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: this.path, maxPayload: 16 * 1024 });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.heartbeat = setInterval(() => this.sweep(), this.heartbeatMs);
    this.heartbeat.unref();
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Sends { type: "message", topic, data } to every client subscribed to the topic. Returns the recipient count. */
  broadcast(topic: Topic, data: unknown): number {
    const payload = JSON.stringify({ type: "message", topic, data });
    let sent = 0;
    for (const [socket, state] of this.clients) {
      if (state.topics.has(topic) && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
        sent++;
      }
    }
    return sent;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.clients.keys()) socket.terminate();
    this.clients.clear();
    const wss = this.wss;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private onConnection(socket: WebSocket): void {
    const state: ClientState = { id: randomUUID(), topics: new Set(), alive: true };
    this.clients.set(socket, state);
    this.logger.debug({ clientId: state.id, clients: this.clients.size }, "client connected");

    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("message", (raw) => this.onMessage(socket, state, raw.toString()));
    socket.on("close", () => {
      this.clients.delete(socket);
      this.logger.debug({ clientId: state.id, clients: this.clients.size }, "client disconnected");
    });
    socket.on("error", (err) => this.logger.warn({ err, clientId: state.id }, "socket error"));
  }

  private onMessage(socket: WebSocket, state: ClientState, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.reply(socket, { type: "error", code: "INVALID_JSON", message: "Message must be JSON." });
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      return this.reply(socket, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: `Expected { type: "subscribe" | "unsubscribe", topic: ${[...STATIC_TOPICS, "candles:<SYMBOL>"].join(" | ")} }.`,
      });
    }
    const { type, topic } = parsed.data;
    if (type === "subscribe") state.topics.add(topic);
    else state.topics.delete(topic);
    this.reply(socket, { type: type === "subscribe" ? "subscribed" : "unsubscribed", topic });
  }

  private reply(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  /** Ping everyone; drop clients that did not answer the previous ping. */
  private sweep(): void {
    for (const [socket, state] of this.clients) {
      if (!state.alive) {
        this.logger.debug({ clientId: state.id }, "dropping dead client");
        this.clients.delete(socket);
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }
}
