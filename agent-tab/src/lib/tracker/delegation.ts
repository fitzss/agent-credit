import { verifySignature } from "@/lib/crypto";

/**
 * Tracker-layer delegation logic.
 * Validates delegation authorizations and checks scope/cap/expiry.
 * Pure functions — no database access. Designed to move cleanly
 * into a separate tracker service later.
 */

export function buildDelegationMessage(
  debtorPubKey: string,
  sessionPubKey: string,
  scopeProviderIds: string,
  scopeToolIds: string,
  spendCap: number,
  expiresAt: string
): string {
  return `agentab:delegate:v1|${debtorPubKey}|${sessionPubKey}|${scopeProviderIds}|${scopeToolIds}|${spendCap.toFixed(8)}|${expiresAt}`;
}

export async function verifyDelegationAuth(
  authMessage: string,
  authSignature: string,
  debtorPubKey: string
): Promise<boolean> {
  return verifySignature(authMessage, authSignature, debtorPubKey);
}

export interface DelegationScope {
  scopeProviderIds: string;
  scopeToolIds: string;
  spendCap: number;
  spentSoFar: number;
  expiresAt: Date;
  status: string;
}

export function checkDelegationScope(
  delegation: DelegationScope,
  providerId: string,
  toolId: string,
  cost: number,
  now: Date = new Date()
): { ok: boolean; reason?: string } {
  if (delegation.status !== "active") {
    return { ok: false, reason: `Delegation is ${delegation.status}` };
  }

  if (now >= delegation.expiresAt) {
    return { ok: false, reason: "Delegation expired" };
  }

  if (delegation.scopeProviderIds !== "*") {
    const allowed = delegation.scopeProviderIds.split(",");
    if (!allowed.includes(providerId)) {
      return { ok: false, reason: "Provider not in delegation scope" };
    }
  }

  if (delegation.scopeToolIds !== "*") {
    const allowed = delegation.scopeToolIds.split(",");
    if (!allowed.includes(toolId)) {
      return { ok: false, reason: "Tool not in delegation scope" };
    }
  }

  if (delegation.spentSoFar + cost > delegation.spendCap) {
    return { ok: false, reason: `Delegation spend cap exceeded (${delegation.spentSoFar.toFixed(2)} + ${cost.toFixed(2)} > ${delegation.spendCap.toFixed(2)})` };
  }

  return { ok: true };
}

export async function verifySessionSignature(
  canonicalMessage: string,
  signature: string,
  sessionPubKey: string
): Promise<boolean> {
  return verifySignature(canonicalMessage, signature, sessionPubKey);
}
