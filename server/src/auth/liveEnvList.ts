import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * A comma-separated list from the env file that is re-read whenever the file changes (checked on every call by its
 * modified time), so editing it takes effect on the next request without a restart. Falls back to `fallback()` when the
 * file or the key is missing.
 */
export function liveEnvList(file: string, key: string, fallback: () => string[]): () => string[] {
  let seenAt = -1;
  let cached: string[] | null = null;
  const pattern = new RegExp(`^\\s*${key}\\s*=(.*)$`, "m");
  return () => {
    try {
      if (!existsSync(file)) return fallback();
      const mtime = statSync(file).mtimeMs;
      if (mtime !== seenAt) {
        seenAt = mtime;
        const match = pattern.exec(readFileSync(file, "utf8"));
        cached = match ? match[1]!.replace(/^["']|["']\s*$/g, "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean) : null;
      }
      return cached ?? fallback();
    } catch {
      return fallback();
    }
  };
}
