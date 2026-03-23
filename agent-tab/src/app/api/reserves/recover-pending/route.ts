import { prisma } from "@/lib/prisma";
import { reconcileRedemption } from "@/lib/reconcile";
import { NextRequest, NextResponse } from "next/server";

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:8081";

/**
 * POST /api/reserves/recover-pending
 *
 * Checks all pending redemptions for a reserve and auto-reconciles any that have confirmed.
 */
export async function POST(req: NextRequest) {
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

  const nodeUrl = SIDECAR_URL.replace(/:\d+$/, ":9052");
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
      const res = await fetch(`${nodeUrl}/blockchain/transaction/byId/${p.txId}`);
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
        grossRedeemNanoErg: Number(p.grossRedeemNanoErg),
        feeNanoErg: Number(p.feeNanoErg),
        netPayoutNanoErg: Number(p.netPayoutNanoErg),
      });
      await prisma.pendingRedemption.update({ where: { id: p.id }, data: { status: "reconciled" } });
      results.push({ txId: p.txId, status: "reconciled", settlement: result.settlement });
    } catch (e: any) {
      results.push({ txId: p.txId, status: "failed", error: e.message });
    }
  }

  return NextResponse.json({ recovered: results });
}
