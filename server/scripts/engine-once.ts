/**
 * Runs ONE signal cycle and exits (for GitHub Actions):  npm run engine:once
 *   exit 0 = done (or "another run in progress"), exit 1 = error.
 * The long-running server (npm start) is separate and unchanged. Needs the environment variables of the server
 * (STORAGE=supabase with SUPABASE_URL and SUPABASE_SERVICE_KEY, and the Telegram ones if posting is wanted).
 * Nothing secret is ever printed: every log line is masked.
 */
import "dotenv/config";
import { EnvError, parseEnv } from "../src/config/env.js";
import { createMaskedLogger, maskSecrets, runOnce, secretValues } from "../src/runner/engineOnce.js";
import { createOnceSteps } from "../src/runner/onceWiring.js";
import { createStore } from "../src/storage/index.js";

const secrets = secretValues(process.env);
const logger = createMaskedLogger(process.env.LOG_LEVEL ?? "info", secrets);

async function main(): Promise<number> {
  const env = parseEnv(process.env, { skipAuthCheck: true }); // no one signs in here
  const store = createStore(env);
  const steps = createOnceSteps(env, store, logger);
  const result = await runOnce({ store, steps, logger });
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const text = err instanceof EnvError ? err.message : err instanceof Error ? err.message : String(err);
    logger.error({ err: maskSecrets(text, secrets) }, "engine run failed");
    process.exit(1);
  },
);
