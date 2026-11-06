/**
 * Creates sample candles and signals for offline demos. Writes only to server/data/demo and never contacts Binance.
 *   npm run seed            then start the server with DEMO_MODE=true
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSeed } from "../src/demo/seedData.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = writeSeed(serverRoot);
console.log(`Seeded ${r.candleCount} candles and ${r.signalCount} signals (${r.buy} BUY, ${r.sell} SELL) into ${r.dir}`);
console.log("Run the server offline with DEMO_MODE=true (for example: DEMO_MODE=true npm run dev).");
