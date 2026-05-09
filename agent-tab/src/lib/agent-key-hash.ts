import { createHmac } from "crypto";

function resolvePepper(): string {
  const pepper = process.env.AGENT_API_KEY_PEPPER;
  if (pepper && pepper.length > 0) return pepper;
  throw new Error(
    "AGENT_API_KEY_PEPPER is required. Set it in your .env (dev) or deploy environment.",
  );
}

export function hashAgentApiKey(rawKey: string): string {
  const pepper = resolvePepper();
  return createHmac("sha256", pepper).update(rawKey).digest("hex");
}

export function previewAgentApiKey(rawKey: string): string {
  return `…${rawKey.slice(-4)}`;
}
