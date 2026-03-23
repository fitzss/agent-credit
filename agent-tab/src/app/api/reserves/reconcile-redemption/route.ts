import { reconcileRedemption, ReconcileError } from "@/lib/reconcile";
import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/reserves/reconcile-redemption
 * Standalone reconciliation endpoint — for manual use or recovery.
 * The preferred path is the one-shot /api/reserves/redeem endpoint.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { reserveId, obligationId, redemptionTxId, grossRedeemNanoErg, feeNanoErg, netPayoutNanoErg } = body;

  if (!reserveId || !obligationId || !redemptionTxId || !grossRedeemNanoErg) {
    return NextResponse.json(
      { error: "Missing required fields: reserveId, obligationId, redemptionTxId, grossRedeemNanoErg" },
      { status: 400 }
    );
  }

  try {
    const result = await reconcileRedemption({
      reserveId, obligationId, redemptionTxId, grossRedeemNanoErg, feeNanoErg, netPayoutNanoErg,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    if (e instanceof ReconcileError) {
      return NextResponse.json({ error: e.message, ...e.detail }, { status: e.statusCode });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
