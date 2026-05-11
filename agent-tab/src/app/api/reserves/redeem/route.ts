import { prisma } from "@/lib/prisma";
import { reconcileRedemption, ReconcileError, computeCumulativeTrackerDebt, gatherExistingReserveEntries, ensureTrackerAligned, ensureSecretFile, REDEEM_POLL_INTERVAL_MS, REDEEM_POLL_ATTEMPTS } from "@/lib/reconcile";
import { getReserveStatus } from "@/lib/sidecar-client";
import { NextRequest, NextResponse } from "next/server";
import { requireSession, ownedCustomerIds, authErrorResponse } from "@/lib/auth";

import { nanoCreditsToNanoErg } from "@/lib/credits";
import { SIDECAR_URL, ERGO_NODE_URL, ERGO_NODE_API_KEY, OPERATOR_MAX_REDEEM_NANOERG } from "@/lib/env";
import { CANONICAL_RESERVE_ID, refuseIfCanonical } from "@/lib/canonical";

/**
 * POST /api/reserves/redeem
 *
 * One-shot: on-chain redemption + app-layer reconciliation.
 *
 * On confirmation timeout, persists a PendingRedemption record for later recovery.
 *
 * Order-of-checks rationale (slice 10b): auth → required-fields → load both rows
 * → role/ownership decision (phase 2) → same-customer equality (phase 3) →
 * recoverPending (only after ownership confirmed) → existing redeem guardrails.
 * recoverPending was previously the FIRST action in this handler; moving it past
 * ownership prevents a customer-role caller from triggering reconciliation work
 * on a foreign or nonexistent reserve. Do not merge phase 2 and phase 3, and do
 * not move recoverPending back to the top.
 */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const body = await req.json();
  const { reserveId, obligationId } = body;

  if (!reserveId || !obligationId) {
    return NextResponse.json({ error: "Missing required fields: reserveId, obligationId" }, { status: 400 });
  }

  // --- Pre-load canonical refuse (slice 16b) ---
  // Canonical reserve is globally read-only; refuse before any DB load or
  // ownership computation. Catches the case where the canonical Reserve row
  // is missing from DB but the canonical id is still being requested.
  if (reserveId === CANONICAL_RESERVE_ID) {
    return NextResponse.json(
      { error: "canonical reserve is read-only", code: "CANONICAL_REFUSE", field: "reserveId" },
      { status: 403 },
    );
  }

  // --- Phase 1: Load both rows (no role-aware decisions, no side effects) ---
  const reserve = await prisma.reserve.findUnique({
    where: { id: reserveId },
    include: { customer: true },
  });
  const obligation = await prisma.obligationState.findUnique({ where: { id: obligationId } });

  // --- Post-load canonical refuse (slice 16b) ---
  // Defense in depth: also refuse if the loaded reserve's tokenId or
  // trackerNftId match canonical (even if the request used a non-canonical
  // Reserve.id that happens to alias the canonical token/tracker).
  if (reserve) {
    const hit = refuseIfCanonical({
      reserveId: reserve.id,
      reserveTokenId: reserve.reserveTokenId,
      trackerNftId: reserve.trackerNftId,
    });
    if (hit) {
      return NextResponse.json(
        { error: hit.reason, code: "CANONICAL_REFUSE", field: hit.field },
        { status: 403 },
      );
    }
  }

  // --- Phase 2: Role/ownership decision (must run BEFORE phase 3 mismatch
  // and BEFORE recoverPending). Customer-role users get one collapsed 403 for
  // missing/foreign/non-owned-on-either-side; operators retain 404 differentials.
  if (user.role === "operator") {
    if (!reserve) return NextResponse.json({ error: "Reserve not found" }, { status: 404 });
    if (!obligation) return NextResponse.json({ error: "Obligation not found" }, { status: 404 });
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (
      !reserve ||
      !obligation ||
      !ownedIds ||
      !ownedIds.includes(reserve.customerId) ||
      !ownedIds.includes(obligation.customerId)
    ) {
      return NextResponse.json(
        { error: "customer not owned by current user" },
        { status: 403 }
      );
    }
  }

  // --- Phase 3: Same-customer equality (only reached after ownership confirmed) ---
  if (reserve.customerId !== obligation.customerId) {
    return NextResponse.json({ error: "Reserve and obligation belong to different customers" }, { status: 400 });
  }

  // --- Self-custody network refuse (slice 16b) ---
  // Placed AFTER ownership + same-customer to preserve the customer-role
  // collapsed-403 information-leak guarantee. Reads process.env.ERGO_NETWORK
  // fresh per request so tests can override without restarting the server.
  if (reserve.customer?.signingMode === "self-custody") {
    const ergoNetwork = process.env.ERGO_NETWORK;
    if (ergoNetwork !== "testnet") {
      return NextResponse.json(
        {
          error: `operator-mode redemption requires ERGO_NETWORK=testnet (got ${JSON.stringify(ergoNetwork)})`,
          code: "OPERATOR_NETWORK_REFUSE",
          ergoNetwork: ergoNetwork ?? null,
        },
        { status: 403 },
      );
    }
  }

  // --- Step 1.5: Recover any pending redemptions for this reserve ---
  // Moved from "Step 0" (top of handler) to AFTER auth + ownership + equality.
  // recoverPending writes settlement state; running it before ownership would
  // let a customer-role caller trigger reconciliation on a foreign reserve.
  const recovered = await recoverPending(reserveId);

  // --- Existing reserve precondition check ---
  if (!reserve.boxId) return NextResponse.json({ error: "Reserve has no on-chain boxId" }, { status: 400 });

  if (obligation.currentAmount <= BigInt(0)) {
    // If we just recovered a pending redemption for this obligation, report it
    if (recovered.length > 0) {
      const match = recovered.find(r => r.obligationId === obligationId && r.status === "reconciled");
      if (match) {
        return NextResponse.json({
          phase: "recovered",
          message: "Pending redemption was auto-recovered and reconciled",
          recoveredTxId: match.txId,
          recovered,
        });
      }
    }
    return NextResponse.json({ error: "Obligation already settled (currentAmount=0)" }, { status: 409 });
  }

  // --- Step 1b: Check no pending redemption already in flight for this obligation ---
  const existingPending = await prisma.pendingRedemption.findFirst({
    where: { obligationId, status: "pending" },
  });
  if (existingPending) {
    return NextResponse.json({
      error: "A pending redemption already exists for this obligation",
      pendingTxId: existingPending.txId,
      hint: "Wait for confirmation or call this endpoint again to trigger auto-recovery",
    }, { status: 409 });
  }

  // --- Step 1c: Ensure secret files exist for owner and receiver ---
  try {
    const customer = await prisma.customer.findUnique({ where: { id: reserve.customerId } });
    const provider = await prisma.provider.findUnique({ where: { id: obligation.providerId } });
    ensureSecretFile("owner", obligation.debtorPubKey, customer?.privateKey ?? null);
    ensureSecretFile("receiver", obligation.creditorPubKey, provider?.privateKey ?? null);
  } catch (e: any) {
    if (e instanceof ReconcileError) {
      return NextResponse.json({ error: e.message, phase: "secret-provisioning" }, { status: e.statusCode });
    }
    return NextResponse.json({ error: e.message, phase: "secret-provisioning" }, { status: 500 });
  }

  // --- Step 2: Contract version guardrail ---
  // v1 reserves (insert-only) only support one redemption per (owner, receiver) pair.
  // v2 reserves (insert+update) support repeated same-pair redemption.
  const existingReserveEntries = await gatherExistingReserveEntries(reserve.id);
  const hasPriorRedemptionForThisPair = existingReserveEntries.some(
    (e) => e.ownerPubKeyHex === obligation.debtorPubKey &&
           e.receiverPubKeyHex === obligation.creditorPubKey
  );

  if (hasPriorRedemptionForThisPair && reserve.contractVersion === "v1") {
    return NextResponse.json({
      error: "Reserve is v1 (insert-only): cannot redeem again for the same (owner, receiver) pair",
      detail: {
        contractVersion: reserve.contractVersion,
        hint: "Deploy a v2 reserve under the updated contract to support repeated same-pair redemption",
      },
    }, { status: 409 });
  }

  // --- Step 3: Compute redemption parameters ---
  // v1: nanoCredits = nanoERG (identity)
  const redeemAmountNanoErg = nanoCreditsToNanoErg(obligation.currentAmount);

  // --- Operator cap refuse (slice 16b) ---
  // Fires only for self-custody reserves AND only when the cap env var is set.
  // Tracker-managed paths (Demo Debtor, prove.sh fixtures) bypass this guard.
  if (
    reserve.customer?.signingMode === "self-custody" &&
    OPERATOR_MAX_REDEEM_NANOERG !== null &&
    redeemAmountNanoErg > OPERATOR_MAX_REDEEM_NANOERG
  ) {
    return NextResponse.json(
      {
        error: `redeemAmountNanoErg ${redeemAmountNanoErg.toString()} exceeds OPERATOR_MAX_REDEEM_NANOERG ${OPERATOR_MAX_REDEEM_NANOERG.toString()}`,
        code: "OPERATOR_CAP",
        redeemAmountNanoErg: redeemAmountNanoErg.toString(),
        capNanoErg: OPERATOR_MAX_REDEEM_NANOERG.toString(),
      },
      { status: 409 },
    );
  }

  // Cumulative tracker debt: single source of truth via helper
  const { totalDebtNanoErg, previouslyRedeemedNanoErg } = await computeCumulativeTrackerDebt(
    reserve.id,
    obligation.debtorPubKey,
    obligation.creditorPubKey,
    redeemAmountNanoErg
  );

  // --- Step 3b: Ensure tracker deployment is aligned (auto-deploy if stale/missing) ---
  let trackerBoxId: string;
  let trackerAutoDeployed = false;
  try {
    const trackerResult = await ensureTrackerAligned({
      trackerNftId: reserve.trackerNftId,
      debtorPubKey: obligation.debtorPubKey,
      creditorPubKey: obligation.creditorPubKey,
      totalDebtNanoErg,
    });
    trackerBoxId = trackerResult.trackerBoxId;
    trackerAutoDeployed = trackerResult.autoDeployed;
  } catch (e: any) {
    if (e instanceof ReconcileError) {
      return NextResponse.json({ error: e.message, phase: "tracker-deploy", ...e.detail }, { status: e.statusCode });
    }
    return NextResponse.json({ error: e.message, phase: "tracker-deploy" }, { status: 500 });
  }

  // --- Step 3c: Pre-check R5 digest ---
  const chainState = await getReserveStatus(reserve.reserveTokenId);
  if (!chainState.found) {
    return NextResponse.json({ error: "Reserve not found on-chain" }, { status: 404 });
  }
  if (reserve.avlTreeDigest && chainState.avlTreeDigest &&
      reserve.avlTreeDigest !== chainState.avlTreeDigest) {
    return NextResponse.json({
      error: "Reserve R5 digest drift detected",
      detail: { dbDigest: reserve.avlTreeDigest, chainDigest: chainState.avlTreeDigest },
    }, { status: 409 });
  }

  // --- Step 4: Call sidecar ---
  let redeemResult: any;
  try {
    const sidecarRes = await fetch(`${SIDECAR_URL}/reserve/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reserveBoxId: reserve.boxId,
        trackerBoxId,
        trackerNftId: reserve.trackerNftId,
        ownerPubKeyHex: reserve.debtorPubKey,
        receiverPubKeyHex: obligation.creditorPubKey,
        totalDebtNanoErg: Number(totalDebtNanoErg),
        redeemAmountNanoErg: Number(redeemAmountNanoErg),
        nodeApiKey: ERGO_NODE_API_KEY,
        existingReserveEntries: existingReserveEntries.map((e) => ({
          ...e,
          redeemedNanoErg: Number(e.redeemedNanoErg),
        })),
        // Pass all tracker tree entries for multi-entry proof generation
        trackerEntries: await (async () => {
          const { getCurrentTrackerBox } = await import("@/lib/reconcile");
          const box = await getCurrentTrackerBox(reserve.trackerNftId);
          return box?.entries.map((e) => ({
            ownerPubKeyHex: e.debtorPubKey,
            receiverPubKeyHex: e.creditorPubKey,
            totalDebtNanoErg: Number(e.totalDebtNanoErg),
          })) || [];
        })(),
      }),
    });
    redeemResult = await sidecarRes.json();
    if (redeemResult.error) {
      return NextResponse.json({
        error: redeemResult.error,
        phase: "on-chain-redemption",
      }, { status: 502 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Sidecar call failed: ${e.message}`, phase: "on-chain-redemption" }, { status: 502 });
  }

  const txId = redeemResult.txId?.replace(/"/g, "") || redeemResult.txId;
  const feeNanoErg = BigInt(redeemResult.feeNanoErg || 0);
  const netPayoutNanoErg = BigInt(redeemResult.payoutNanoErg || 0);

  // --- Step 5: Poll for confirmation ---
  let confirmed = false;
  for (let i = 0; i < REDEEM_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, REDEEM_POLL_INTERVAL_MS));
    try {
      const checkRes = await fetch(`${ERGO_NODE_URL}/blockchain/transaction/byId/${txId}`);
      const checkData = await checkRes.json();
      if (checkData.inputs && !checkData.error) { confirmed = true; break; }
    } catch { /* retry */ }
  }

  if (!confirmed) {
    // --- Persist PendingRedemption for later recovery ---
    const pending = await prisma.pendingRedemption.create({
      data: {
        txId,
        reserveId,
        obligationId,
        grossRedeemNanoErg: redeemAmountNanoErg,
        feeNanoErg,
        netPayoutNanoErg,
        status: "pending",
      },
    });

    return NextResponse.json({
      txId,
      phase: "pending",
      pendingRedemptionId: pending.id,
      message: "Tx submitted but not yet confirmed. A PendingRedemption record has been saved. " +
               "Call this endpoint again or /api/reserves/recover-pending to auto-reconcile after confirmation.",
      ...(recovered.length > 0 ? { priorRecoveries: recovered } : {}),
    }, { status: 202 });
  }

  // --- Step 6: Reconcile ---
  try {
    const result = await reconcileRedemption({
      reserveId, obligationId, redemptionTxId: txId,
      grossRedeemNanoErg: redeemAmountNanoErg, feeNanoErg, netPayoutNanoErg,
    });
    return NextResponse.json({
      ...result, phase: "complete",
      ...(trackerAutoDeployed ? { trackerAutoDeployed: true } : {}),
      ...(recovered.length > 0 ? { priorRecoveries: recovered } : {}),
    });
  } catch (e: any) {
    // Redemption on-chain but reconciliation failed — persist as pending
    await prisma.pendingRedemption.create({
      data: {
        txId, reserveId, obligationId,
        grossRedeemNanoErg: redeemAmountNanoErg,
        feeNanoErg,
        netPayoutNanoErg,
        status: "pending",
      },
    });
    return NextResponse.json({
      error: `Reconciliation failed: ${e.message}`,
      phase: "reconciliation-failed",
      txId,
      message: "PendingRedemption saved. Will auto-recover on next call.",
    }, { status: 207 });
  }
}

// --- Recovery logic ---

interface RecoveryResult {
  txId: string;
  obligationId: string;
  status: "reconciled" | "still-pending" | "already-reconciled" | "failed";
  detail?: string;
}

async function recoverPending(reserveId: string): Promise<RecoveryResult[]> {
  const pending = await prisma.pendingRedemption.findMany({
    where: { reserveId, status: "pending" },
  });

  if (pending.length === 0) return [];

  const results: RecoveryResult[] = [];

  for (const p of pending) {
    // Check if already reconciled (settlement exists)
    const existingSettlement = await prisma.settlementEvent.findUnique({
      where: { redemptionTxId: p.txId },
    });
    if (existingSettlement) {
      await prisma.pendingRedemption.update({
        where: { id: p.id },
        data: { status: "reconciled" },
      });
      results.push({ txId: p.txId, obligationId: p.obligationId, status: "already-reconciled" });
      continue;
    }

    // Check if tx is confirmed on-chain
    let txConfirmed = false;
    try {
      const checkRes = await fetch(`${ERGO_NODE_URL}/blockchain/transaction/byId/${p.txId}`);
      const checkData = await checkRes.json();
      txConfirmed = !!(checkData.inputs && !checkData.error);
    } catch { /* not confirmed */ }

    if (!txConfirmed) {
      results.push({ txId: p.txId, obligationId: p.obligationId, status: "still-pending" });
      continue;
    }

    // Confirmed — run reconciliation
    try {
      await reconcileRedemption({
        reserveId: p.reserveId,
        obligationId: p.obligationId,
        redemptionTxId: p.txId,
        grossRedeemNanoErg: p.grossRedeemNanoErg,
        feeNanoErg: p.feeNanoErg,
        netPayoutNanoErg: p.netPayoutNanoErg,
      });
      await prisma.pendingRedemption.update({
        where: { id: p.id },
        data: { status: "reconciled" },
      });
      results.push({ txId: p.txId, obligationId: p.obligationId, status: "reconciled" });
    } catch (e: any) {
      results.push({ txId: p.txId, obligationId: p.obligationId, status: "failed", detail: e.message });
    }
  }

  return results;
}
