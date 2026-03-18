/**
 * Client for the ChainCash JVM sidecar.
 * Handles all Ergo-specific operations: reserve deployment, scanning, status.
 */

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:8081";

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
