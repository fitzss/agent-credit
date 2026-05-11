/**
 * Canonical reserve identifiers (slice 16b).
 *
 * The canonical reserve is the shared fixture referenced by prove.sh and
 * the demo invariants. It is **read-only** — no redemption against it is
 * permitted regardless of caller role. Server-side enforcement lives in
 * /api/reserves/redeem; this module is the single source of truth for the
 * three identifiers and the refuse helper.
 *
 * The same constants are currently also inlined in:
 *   agent-tab/scripts/operator-reserve-init.ts
 *   agent-tab/scripts/seed-settlement-demo-reserve.ts
 * Deduping those copies is a follow-up cleanup, not part of 16b.
 */

export const CANONICAL_RESERVE_ID =
  "e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c";
export const CANONICAL_RESERVE_TOKEN_ID =
  "2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937";
export const CANONICAL_TRACKER_NFT_ID =
  "d234898d01d478db47ab2073e4e5289a414be79e0ecb8670a9f4fc44d8d70f5b";

export type CanonicalField = "reserveId" | "reserveTokenId" | "trackerNftId";

export interface CanonicalRefusal {
  reason: string;
  field: CanonicalField;
}

export function refuseIfCanonical(ids: {
  reserveId?: string | null;
  reserveTokenId?: string | null;
  trackerNftId?: string | null;
}): CanonicalRefusal | null {
  if (ids.reserveId === CANONICAL_RESERVE_ID) {
    return { reason: "canonical reserve is read-only", field: "reserveId" };
  }
  if (ids.reserveTokenId === CANONICAL_RESERVE_TOKEN_ID) {
    return { reason: "canonical reserve token", field: "reserveTokenId" };
  }
  if (ids.trackerNftId === CANONICAL_TRACKER_NFT_ID) {
    return { reason: "canonical tracker NFT", field: "trackerNftId" };
  }
  return null;
}
