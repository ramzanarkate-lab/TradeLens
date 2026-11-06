import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createLogger } from "../src/logging/logger.js";
import { WsHub } from "../src/ws/hub.js";

const logger = createLogger({ level: "silent", pretty: false });

let server: Server;
let hub: WsHub;
let url: string;
const sockets: WebSocket[] = [];

type Msg = { type?: string; topic?: string; code?: string; data?: unknown };

async function connect(opts: WebSocket.ClientOptions = {}): Promise<{ ws: WebSocket; inbox: Msg[] }> {
  const ws = new WebSocket(url, opts);
  const inbox: Msg[] = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString()) as Msg));
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, inbox };
}

const waitFor = async (check: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  hub = new WsHub({ logger, heartbeatMs: 50 });
  server = createServer();
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("WsHub", () => {
  it("accepts a subscribe message and only sends to subscribed clients", async () => {
    const a = await connect();
    const b = await connect();
    await waitFor(() => hub.clientCount() === 2);

    a.ws.send(JSON.stringify({ type: "subscribe", topic: "signals" }));
    await waitFor(() => a.inbox.some((m) => m.type === "subscribed" && m.topic === "signals"));

    expect(hub.broadcast("signals", { id: 1 })).toBe(1);
    await waitFor(() => a.inbox.some((m) => m.type === "message"));
    expect(a.inbox.find((m) => m.type === "message")).toEqual({ type: "message", topic: "signals", data: { id: 1 } });

    // b never subscribed, and a is not subscribed to "candles"
    expect(hub.broadcast("candles", { x: 1 })).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.inbox).toEqual([]);
    expect(a.inbox.filter((m) => m.type === "message")).toHaveLength(1);
  });

  it("stops sending after unsubscribe and rejects bad messages", async () => {
    const a = await connect();
    a.ws.send(JSON.stringify({ type: "subscribe", topic: "status" }));
    await waitFor(() => a.inbox.some((m) => m.type === "subscribed"));
    a.ws.send(JSON.stringify({ type: "unsubscribe", topic: "status" }));
    await waitFor(() => a.inbox.some((m) => m.type === "unsubscribed"));
    expect(hub.broadcast("status", {})).toBe(0);

    a.ws.send(JSON.stringify({ type: "subscribe", topic: "bogus" }));
    await waitFor(() => a.inbox.some((m) => m.type === "error" && m.code === "INVALID_MESSAGE"));
    a.ws.send("not json");
    await waitFor(() => a.inbox.some((m) => m.code === "INVALID_JSON"));
  });

  it("drops clients that stop answering heartbeat pings", async () => {
    await connect({ autoPong: false }); // never answers server pings
    await waitFor(() => hub.clientCount() === 1);
    await waitFor(() => hub.clientCount() === 0, 3000);
  });

  it("supports per-symbol candle topics and rejects unknown symbols", async () => {
    const a = await connect();
    a.ws.send(JSON.stringify({ type: "subscribe", topic: "candles:BTCUSDT" }));
    await waitFor(() => a.inbox.some((m) => m.type === "subscribed" && m.topic === "candles:BTCUSDT"));
    expect(hub.broadcast("candles:SOLUSDT", {})).toBe(0);
    expect(hub.broadcast("candles:BTCUSDT", { x: 1 })).toBe(1);

    a.ws.send(JSON.stringify({ type: "subscribe", topic: "candles:DOGEUSDT" }));
    await waitFor(() => a.inbox.some((m) => m.code === "INVALID_MESSAGE"));
  });

  it("keeps healthy clients connected through heartbeats", async () => {
    await connect();
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.clientCount()).toBe(1);
  });
});
