import { tracker } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";
import { requireOperator, authErrorResponse } from "@/lib/auth";

/**
 * GET /api/tracker/notes?debtorPubKey=<hex>
 * Tracker API: get all notes for a debtor public key.
 */
export async function GET(req: NextRequest) {
  try {
    await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

  const debtorPubKey = req.nextUrl.searchParams.get("debtorPubKey");
  if (!debtorPubKey) {
    return NextResponse.json({ error: "Missing debtorPubKey parameter" }, { status: 400 });
  }
  const notes = await tracker.getNotesForKey(debtorPubKey);
  return NextResponse.json(notes);
}
