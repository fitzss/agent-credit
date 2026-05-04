import { tracker } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import { requireOperator, authErrorResponse } from "@/lib/auth";

/**
 * GET /api/tracker/keys/:pubkey/status
 * Tracker API: get key status including total debt, delegations, reserve placeholders.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pubkey: string }> }
) {
  try {
    await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { pubkey } = await params;
  const status = await tracker.getKeyStatus(pubkey);
  return NextResponse.json(toJsonSafe(status));
}
