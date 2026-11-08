import { resolve } from "node:path";
import type { Env } from "../config/env.js";
import { FileStore } from "./fileStore.js";
import type { Store } from "./store.js";
import { SupabaseStore } from "./supabaseStore.js";

export type { Store } from "./store.js";
export { FileStore } from "./fileStore.js";
export { SupabaseStore } from "./supabaseStore.js";
export { FileMirror } from "./mirror.js";

/** STORAGE=file (default, local development) or STORAGE=supabase. env.ts has already checked the Supabase variables. */
export function createStore(env: Pick<Env, "STORAGE" | "DATA_DIR" | "SUPABASE_URL" | "SUPABASE_SERVICE_KEY">): Store {
  if (env.STORAGE === "supabase") return new SupabaseStore({ url: env.SUPABASE_URL!, serviceKey: env.SUPABASE_SERVICE_KEY! });
  return new FileStore(resolve(env.DATA_DIR));
}

/** The documents the server keeps (each one is DATA_DIR/<name>.json). */
export const STORED_DOCUMENTS = ["settings", "signals", "users", "runner-state", "demo-accounts", "strategy-signals", "strategy-backtests", "strategy-runner-state", "telegram-events-sent", "telegram-events-failed", "telegram-sent", "telegram-failed", "news"];
export const STORED_FOLDERS = ["backtests"];
