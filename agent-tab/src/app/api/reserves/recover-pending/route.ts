import { prisma } from "@/lib/prisma";
import { reconcileRedemption } from "@/lib/reconcile";
import { NextRequest, NextResponse } from "next/server";
import { requireOperator, authErrorResponse } from "@/lib/auth";
import { ERGO_NODE_URL } from "@/lib/env";

/**
 * POST /api/reserves/recover-pending
 *
 * Checks all pending redemptions for a reserve and auto-reconciles any that have confirmed.
 */
export async function POST(req: NextRequest) {
  try {
    await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { reserveId } = await req.json();
  if (!reserveId) {
    return NextResponse.json({ error: "Missing reserveId" }, { status: 400 });
  }

  const pending = await prisma.pendingRedemption.findMany({
    where: { reserveId, status: "pending" },
    orderBy: { createdAt: "asc" },
  });

  if (pending.length === 0) {
    return NextResponse.json({ message: "No pending redemptions", recovered: [] });
  }

  const results: any[] = [];

  for (const p of pending) {
    // Already reconciled?
    const existing = await prisma.settlementEvent.findUnique({ where: { redemptionTxId: p.txId } });
    if (existing) {
      await prisma.pendingRedemption.update({ where: { id: p.id }, data: { status: "reconciled" } });
      results.push({ txId: p.txId, status: "already-reconciled" });
      continue;
    }

    // Confirmed on-chain?
    let confirmed = false;
    try {
      const res = await fetch(`${ERGO_NODE_URL}/blockchain/transaction/byId/${p.txId}`);
      const data = await res.json();
      confirmed = !!(data.inputs && !data.error);
    } catch { /* not yet */ }

    if (!confirmed) {
      results.push({ txId: p.txId, status: "still-pending" });
      continue;
    }

    // Reconcile
    try {
      const result = await reconcileRedemption({
        reserveId: p.reserveId,
        obligationId: p.obligationId,
        redemptionTxId: p.txId,
        grossRedeemNanoErg: p.grossRedeemNanoErg,
        feeNanoErg: p.feeNanoErg,
        netPayoutNanoErg: p.netPayoutNanoErg,
      });
      await prisma.pendingRedemption.update({ where: { id: p.id }, data: { status: "reconciled" } });
      results.push({ txId: p.txId, status: "reconciled", settlement: result.settlement });
    } catch (e: any) {
      results.push({ txId: p.txId, status: "failed", error: e.message });
    }
  }

  return NextResponse.json({ recovered: results });
}
