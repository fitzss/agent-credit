import { createHmac } from "crypto";

const DEV_FALLBACK_PEPPER = "agent-credit-dev-pepper-not-for-prod";

let devWarningEmitted = false;

function resolvePepper(): string {
  const pepper = process.env.AGENT_API_KEY_PEPPER;
  if (pepper && pepper.length > 0) return pepper;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AGENT_API_KEY_PEPPER is required in production. Set it in the deploy environment.",
    );
  }

  if (!devWarningEmitted) {
    devWarningEmitted = true;
    console.warn(
      "[agent-key-hash] AGENT_API_KEY_PEPPER not set; using dev fallback. " +
        "Do not rely on this in production.",
    );
  }
  return DEV_FALLBACK_PEPPER;
}

export function hashAgentApiKey(rawKey: string): string {
  const pepper = resolvePepper();
  return createHmac("sha256", pepper).update(rawKey).digest("hex");
}
