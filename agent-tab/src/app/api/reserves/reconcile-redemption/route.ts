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
      reserveId, obligationId, redemptionTxId,
      grossRedeemNanoErg: BigInt(grossRedeemNanoErg),
      feeNanoErg: feeNanoErg ? BigInt(feeNanoErg) : undefined,
      netPayoutNanoErg: netPayoutNanoErg ? BigInt(netPayoutNanoErg) : undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    if (e instanceof ReconcileError) {
      // Serialize BigInt fields in error detail (handles nested objects)
      const serializeBigInts = (obj: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(Object.entries(obj).map(([k, v]) => [k,
          typeof v === "bigint" ? v.toString()
          : v && typeof v === "object" && !Array.isArray(v) ? serializeBigInts(v as Record<string, unknown>)
          : v
        ]));
      const detail = e.detail ? serializeBigInts(e.detail) : {};
      return NextResponse.json({ error: e.message, ...detail }, { status: e.statusCode });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
