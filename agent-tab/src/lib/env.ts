/**
 * Centralized environment-variable resolution for slice 14p.0.
 *
 * Two modes:
 *
 *   Dev (NODE_ENV !== "production" AND ALPHA_MODE !== "true"):
 *     - URLs (SIDECAR_URL, ERGO_NODE_URL, ERGO_NODE_API_KEY) fall back to
 *       documented dev defaults when unset.
 *     - AGENT_API_KEY_PEPPER has no fallback; it is always required.
 *       (See agent-key-hash.ts; the prior dev-fallback was dropped in 14p.0.)
 *
 *   Alpha (NODE_ENV === "production" OR ALPHA_MODE === "true"):
 *     - Every value listed in REQUIRED_IN_ALPHA must be set and non-empty.
 *     - URL fallbacks do NOT apply; missing values throw at module load.
 *     - The throw fires before any HTTP request is served because this
 *       module is imported at server startup via instrumentation.ts.
 *
 * Demo-tool allowlist:
 *   ALPHA_ALLOWED_DEMO_TOOLS is a comma-separated list of demo-tool slugs
 *   permitted in alpha mode. Default is empty (deny all). Outside alpha
 *   mode this var is ignored — the existing dev-mode dual gate
 *   (DEMO_MODE === "true" AND NODE_ENV !== "production") is unchanged.
 */

export function isAlphaMode(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.ALPHA_MODE === "true"
  );
}

function readAlphaRequired(name: string, devFallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (isAlphaMode()) {
    throw new Error(
      `[env] ${name} is required when ALPHA_MODE=true or NODE_ENV=production. ` +
        "Set it in the deploy environment.",
    );
  }
  if (devFallback === undefined) {
    throw new Error(
      `[env] ${name} is required (no fallback). Set it in your local .env.`,
    );
  }
  return devFallback;
}

// URLs and node API key. Dev fallbacks documented in .env.example.
export const SIDECAR_URL = readAlphaRequired(
  "SIDECAR_URL",
  "http://localhost:8081",
);
export const ERGO_NODE_URL = readAlphaRequired(
  "ERGO_NODE_URL",
  "http://localhost:9052",
);
export const ERGO_NODE_API_KEY = readAlphaRequired(
  "ERGO_NODE_API_KEY",
  "hello",
);

// Boot-time validation of required vars that don't have dev fallbacks.
// This intentionally does not memoize the values — callers that need them
// (e.g., agent-key-hash.ts for AGENT_API_KEY_PEPPER) read process.env directly
// so test mocks can override per-test. The role of this block is to surface
// missing values at startup with a clear message in alpha mode.
const REQUIRED_NO_FALLBACK = [
  "AGENT_API_KEY_PEPPER",
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "DEFAULT_OPERATOR_EMAIL",
] as const;

export function validateAlphaEnv(): void {
  if (!isAlphaMode()) return;
  const missing: string[] = [];
  for (const name of REQUIRED_NO_FALLBACK) {
    const v = process.env[name];
    if (!v || v.length === 0) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `[env] Required in alpha mode but missing or empty: ${missing.join(", ")}. ` +
        "Set them in the deploy environment before starting the server.",
    );
  }
  if (process.env.DEMO_MODE === "true") {
    // Visible to the operator: DEMO_MODE has no effect in alpha mode.
    // Polling intervals (reconcile.ts) and demo-tool gating both ignore it
    // when ALPHA_MODE=true / NODE_ENV=production; do not rely on it.
    console.warn(
      "[env] DEMO_MODE=true is set but ignored in alpha mode. Demo-only " +
        "behavior is disabled. Use ALPHA_ALLOWED_DEMO_TOOLS to opt specific " +
        "tools into the alpha runtime.",
    );
  }
}

// Run validation at module load. instrumentation.ts imports this module so
// the throw fires before HTTP requests are served.
validateAlphaEnv();

/**
 * Returns the set of demo-tool slugs explicitly allowlisted for the alpha
 * runtime. In dev mode (no alpha), this is informational only — the
 * existing DEMO_MODE dual gate continues to govern access.
 */
export function alphaAllowedDemoTools(): Set<string> {
  const raw = process.env.ALPHA_ALLOWED_DEMO_TOOLS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Gate for `/api/demo-tool/<slug>` routes. Returns true if the route
 * should serve the request, false if it should respond 404.
 *
 *   - Outside alpha mode: existing dual gate (DEMO_MODE === "true" AND
 *     NODE_ENV !== "production"). Unchanged from before slice 14p.0.
 *   - In alpha mode: slug must appear in ALPHA_ALLOWED_DEMO_TOOLS.
 */
export function isDemoToolEnabled(slug: string): boolean {
  if (isAlphaMode()) {
    return alphaAllowedDemoTools().has(slug);
  }
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.DEMO_MODE !== "true") return false;
  return true;
}
