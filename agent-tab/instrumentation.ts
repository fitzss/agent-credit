/**
 * Next.js instrumentation hook.
 * Runs once at server startup, before any HTTP request is served.
 *
 * Importing src/lib/env triggers validateAlphaEnv(), which throws with a
 * clear message when ALPHA_MODE=true (or NODE_ENV=production) and any
 * required environment variable is missing. The throw lands at boot, not
 * on the first request.
 */
export async function register(): Promise<void> {
  await import("./src/lib/env");
}
