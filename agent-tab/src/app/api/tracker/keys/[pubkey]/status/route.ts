import { tracker } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/tracker/keys/:pubkey/status
 * Tracker API: get key status including total debt, delegations, reserve placeholders.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pubkey: string }> }
) {
  const { pubkey } = await params;
  const status = await tracker.getKeyStatus(pubkey);
  return NextResponse.json(status);
}
