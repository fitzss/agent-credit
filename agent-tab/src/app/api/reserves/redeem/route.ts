import { prisma } from "@/lib/prisma";
import { reconcileRedemption, ReconcileError, computeCumulativeTrackerDebt, gatherExistingReserveEntries, ensureTrackerAligned, ensureSecretFile } from "@/lib/reconcile";
import { getReserveStatus } from "@/lib/sidecar-client";
import { NextRequest, NextResponse } from "next/server";

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:8081";
const ERGO_NODE_API_KEY = process.env.ERGO_NODE_API_KEY || "hello";
const NANO_PER_CREDIT = 1_000_000_000;

/**
 * POST /api/reserves/redeem
 *
 * One-shot: on-chain redemption + app-layer reconciliation.
 *
 * Before starting a new redemption, recovers any pending ones first.
 * On confirmation timeout, persists a PendingRedemption record for later recovery.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { reserveId, obligationId } = body;

  if (!reserveId || !obligationId) {
    return NextResponse.json({ error: "Missing required fields: reserveId, obligationId" }, { status: 400 });
  }

  // --- Step 0: Recover any pending redemptions for this reserve ---
  const recovered = await recoverPending(reserveId);

  // --- Step 1: Load DB records ---
  const reserve = await prisma.reserve.findUnique({ where: { id: reserveId } });
  if (!reserve) return NextResponse.json({ error: "Reserve not found" }, { status: 404 });
  if (!reserve.boxId) return NextResponse.json({ error: "Reserve has no on-chain boxId" }, { status: 400 });

  const obligation = await prisma.obligationState.findUnique({ where: { id: obligationId } });
  if (!obligation) return NextResponse.json({ error: "Obligation not found" }, { status: 404 });

  if (reserve.customerId !== obligation.customerId) {
    return NextResponse.json({ error: "Reserve and obligation belong to different customers" }, { status: 400 });
  }

  if (obligation.currentAmount <= 0) {
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
  const existingReserveEntries = await gatherExistingReserveEntries(reserve.customerId);
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
  const redeemAmountNanoErg = Math.round(obligation.currentAmount * NANO_PER_CREDIT);

  // Cumulative tracker debt: single source of truth via helper
  const { totalDebtNanoErg, previouslyRedeemedNanoErg } = await computeCumulativeTrackerDebt(
    reserve.customerId,
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
        totalDebtNanoErg,
        redeemAmountNanoErg,
        nodeApiKey: ERGO_NODE_API_KEY,
        existingReserveEntries,
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
  const feeNanoErg = redeemResult.feeNanoErg || 0;
  const netPayoutNanoErg = redeemResult.payoutNanoErg || 0;

  // --- Step 5: Poll for confirmation ---
  let confirmed = false;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const checkRes = await fetch(`${nodeUrl}/blockchain/transaction/byId/${txId}`);
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
        grossRedeemNanoErg: BigInt(redeemAmountNanoErg),
        feeNanoErg: BigInt(feeNanoErg),
        netPayoutNanoErg: BigInt(netPayoutNanoErg),
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
        grossRedeemNanoErg: BigInt(redeemAmountNanoErg),
        feeNanoErg: BigInt(feeNanoErg),
        netPayoutNanoErg: BigInt(netPayoutNanoErg),
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

  const nodeUrl = SIDECAR_URL.replace(/:\d+$/, ":9052");
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
      const checkRes = await fetch(`${nodeUrl}/blockchain/transaction/byId/${p.txId}`);
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
        grossRedeemNanoErg: Number(p.grossRedeemNanoErg),
        feeNanoErg: Number(p.feeNanoErg),
        netPayoutNanoErg: Number(p.netPayoutNanoErg),
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
