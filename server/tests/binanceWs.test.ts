import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createLogger } from "../src/logging/logger.js";
import { BinanceStream, buildStreamUrl, parseKlineMessage } from "../src/market/binanceWs.js";

const logger = createLogger({ level: "silent", pretty: false });

const klineMsg = (symbol: string, close: string, closed = false) =>
  JSON.stringify({
    stream: `${symbol.toLowerCase()}@kline_1m`,
    data: { e: "kline", s: symbol, k: { t: 1000, T: 60999, o: "1", h: "3", l: "0.5", c: close, v: "7", x: closed, i: "1m" } },
  });

const waitFor = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("stream helpers", () => {
  it("builds the combined stream URL for the three symbols", () => {
    expect(buildStreamUrl("wss://stream.binance.com:9443")).toBe(
      "wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/solusdt@kline_1m/ethusdt@kline_1m",
    );
  });

  it("parses kline events and ignores everything else", () => {
    expect(parseKlineMessage(klineMsg("BTCUSDT", "2.5", true))).toEqual([
      "BTCUSDT",
      { time: 1000, open: 1, high: 3, low: 0.5, close: 2.5, volume: 7, closed: true },
    ]);
    expect(parseKlineMessage(klineMsg("DOGEUSDT", "1"))).toBeNull();
    expect(parseKlineMessage("not json")).toBeNull();
    expect(parseKlineMessage(JSON.stringify({ data: { e: "trade" } }))).toBeNull();
  });
});

describe("BinanceStream", () => {
  let wss: WebSocketServer | undefined;
  let stream: BinanceStream | undefined;

  afterEach(async () => {
    stream?.stop();
    for (const c of wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = undefined;
  });

  async function startServer(port = 0) {
    const server = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return server;
  }

  it("emits status and candle events, keeps the latest candle, and reconnects after a drop", async () => {
    wss = await startServer();
    const port = (wss.address() as AddressInfo).port;
    const sockets: WsSocket[] = [];
    wss.on("connection", (s) => sockets.push(s));

    stream = new BinanceStream({ url: `ws://127.0.0.1:${port}/stream`, logger, minDelayMs: 20, maxDelayMs: 100 });
    const statuses: string[] = [];
    const candles: Array<[string, number]> = [];
    stream.on("status", (s) => statuses.push(s));
    stream.on("candle", (sym, c) => candles.push([sym, c.close]));

    expect(stream.getStatus()).toBe("Reconnecting");
    stream.start();
    await waitFor(() => statuses.includes("Live"));

    sockets[0]!.send(klineMsg("BTCUSDT", "10"));
    sockets[0]!.send(klineMsg("BTCUSDT", "11"));
    sockets[0]!.send(klineMsg("SOLUSDT", "5"));
    await waitFor(() => candles.length === 3);
    expect(stream.getLatest("BTCUSDT")?.close).toBe(11);
    expect(stream.getLatest("SOLUSDT")?.close).toBe(5);
    expect(stream.getLatest("ETHUSDT")).toBeUndefined();

    sockets[0]!.terminate(); // connection drop
    await waitFor(() => statuses.join() === "Live,Reconnecting");
    await waitFor(() => statuses.join() === "Live,Reconnecting,Live");
    expect(sockets).toHaveLength(2);
    expect(stream.getStatus()).toBe("Live");
  });

  it("keeps retrying with backoff while the server is unreachable", async () => {
    const probe = await startServer();
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve())); // nothing listens on this port now

    stream = new BinanceStream({ url: `ws://127.0.0.1:${port}/stream`, logger, minDelayMs: 20, maxDelayMs: 60 });
    stream.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(stream.getStatus()).toBe("Reconnecting");

    wss = await startServer(port); // comes back
    await waitFor(() => stream!.getStatus() === "Live");
  });
});
