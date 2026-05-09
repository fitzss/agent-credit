/**
 * Client for the ChainCash JVM sidecar.
 * Handles all Ergo-specific operations: reserve deployment, scanning, status.
 */

import { SIDECAR_URL } from "@/lib/env";

export interface SidecarHealth {
  status: string;
  network: string;
  nodeUrl: string;
  basisAddress: string;
  sidecarVersion: string;
}

export interface DeployResult {
  deploymentRequestJson: unknown;
  reserveAddress: string;
  scanRequestJson: unknown;
  network: string;
}

export interface ReserveStatus {
  found: boolean;
  boxId: string | null;
  valueNanoErg: number | null;
  ownerPubKey: string | null;
  trackerNftId: string | null;
  avlTreeDigest: string | null;
  creationHeight: number | null;
}

async function sidecarFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${SIDECAR_URL}${path}`, options);
}

export async function getSidecarHealth(): Promise<SidecarHealth | null> {
  try {
    const res = await sidecarFetch("/health");
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getNetworkHeight(): Promise<number | null> {
  try {
    const res = await sidecarFetch("/network/height");
    const data = await res.json();
    return data.height ?? null;
  } catch {
    return null;
  }
}

export async function deployReserve(params: {
  ownerPubKeyHex: string;
  trackerNftId: string;
  reserveTokenId: string;
  initialCollateralNanoErg?: number;
}): Promise<DeployResult> {
  const res = await sidecarFetch("/reserve/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function createScanRequest(reserveTokenId: string): Promise<unknown> {
  const res = await sidecarFetch("/reserve/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reserveTokenId }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.scanRequestJson;
}

export async function getReserveStatus(reserveTokenId: string): Promise<ReserveStatus> {
  const res = await sidecarFetch(`/reserve/status?reserveTokenId=${reserveTokenId}`);
  return res.json();
}

/**
 * Get the sidecar's current compiled Basis contract address.
 * This is the v2 (insert+update) contract address.
 * Used to derive contractVersion for reserves by comparing reserveAddress.
 */
export async function getCurrentBasisAddress(): Promise<string | null> {
  try {
    const health = await getSidecarHealth();
    return health?.basisAddress || null;
  } catch {
    return null;
  }
}

/**
 * Derive contract version from a reserve's address.
 * If the reserve address matches the sidecar's current compiled contract → v2.
 * Otherwise → v1.
 */
export async function deriveContractVersion(reserveAddress: string | null): Promise<"v1" | "v2"> {
  if (!reserveAddress) return "v1";
  const currentAddress = await getCurrentBasisAddress();
  if (!currentAddress) return "v1"; // can't determine — default safe
  return reserveAddress === currentAddress ? "v2" : "v1";
}
