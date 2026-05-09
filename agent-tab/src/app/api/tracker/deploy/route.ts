import { prisma } from "@/lib/prisma";
import { recordTrackerDeployment, computeCumulativeTrackerDebt } from "@/lib/reconcile";
import { NextRequest, NextResponse } from "next/server";
import { requireOperator, authErrorResponse } from "@/lib/auth";

import { nanoCreditsToNanoErg } from "@/lib/credits";
import { SIDECAR_URL, ERGO_NODE_API_KEY } from "@/lib/env";

/**
 * POST /api/tracker/deploy
 *
 * Deploys a tracker box for a (reserve, obligation) pair.
 * Computes the correct cumulative totalDebt automatically.
 * Records the deployment in TrackerDeployment for lifecycle tracking.
 */
export async function POST(req: NextRequest) {
  try {
    await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { reserveId, obligationId } = await req.json();

  if (!reserveId || !obligationId) {
    return NextResponse.json({ error: "Missing reserveId or obligationId" }, { status: 400 });
  }

  const reserve = await prisma.reserve.findUnique({ where: { id: reserveId } });
  if (!reserve) return NextResponse.json({ error: "Reserve not found" }, { status: 404 });

  const obligation = await prisma.obligationState.findUnique({ where: { id: obligationId } });
  if (!obligation) return NextResponse.json({ error: "Obligation not found" }, { status: 404 });

  if (reserve.customerId !== obligation.customerId) {
    return NextResponse.json({ error: "Reserve and obligation belong to different customers" }, { status: 400 });
  }

  if (obligation.currentAmount <= BigInt(0)) {
    return NextResponse.json({ error: "Obligation has no debt to commit" }, { status: 409 });
  }

  // Compute the correct cumulative totalDebt (v1: nanoCredits = nanoERG)
  const redeemAmountNanoErg = nanoCreditsToNanoErg(obligation.currentAmount);
  const { totalDebtNanoErg } = await computeCumulativeTrackerDebt(
    reserve.id,
    obligation.debtorPubKey,
    obligation.creditorPubKey,
    redeemAmountNanoErg,
  );

  // Call sidecar
  let sidecarResult: any;
  try {
    const res = await fetch(`${SIDECAR_URL}/tracker/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerPubKeyHex: obligation.debtorPubKey,
        receiverPubKeyHex: obligation.creditorPubKey,
        totalDebtNanoErg: Number(totalDebtNanoErg),
        trackerNftId: reserve.trackerNftId,
        nodeApiKey: ERGO_NODE_API_KEY,
      }),
    });
    sidecarResult = await res.json();
    if (sidecarResult.error) {
      return NextResponse.json({ error: sidecarResult.error, phase: "sidecar" }, { status: 502 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Sidecar call failed: ${e.message}` }, { status: 502 });
  }

  // Record in DB
  const deployment = await recordTrackerDeployment({
    trackerNftId: reserve.trackerNftId,
    debtorPubKey: obligation.debtorPubKey,
    creditorPubKey: obligation.creditorPubKey,
    totalDebtNanoErg,
    boxId: sidecarResult.trackerBoxId,
    trackerPubKeyHex: sidecarResult.trackerPubKeyHex,
    treeDigestHex: sidecarResult.treeDigestHex,
    txId: sidecarResult.txId,
  });

  return NextResponse.json({
    deployment: {
      id: deployment.id,
      trackerBoxId: sidecarResult.trackerBoxId,
      totalDebtNanoErg: totalDebtNanoErg.toString(),
      trackerPubKeyHex: sidecarResult.trackerPubKeyHex,
      treeDigestHex: sidecarResult.treeDigestHex,
      txId: sidecarResult.txId,
      isCurrent: true,
    },
    note: "Tracker deployed and recorded. Wait for block confirmation before redeeming.",
  }, { status: 201 });
}
