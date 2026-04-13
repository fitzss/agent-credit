import { tracker, TrackerError } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";

/**
 * Thin app-layer wrapper around tracker.commitNoteUpdate().
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const { signature, updateId, delegationId } = body;

  if (!signature || !updateId) {
    return NextResponse.json({ error: "Missing signature or updateId" }, { status: 400 });
  }

  try {
    const result = await tracker.commitNoteUpdate({
      noteId: id,
      updateId,
      signature,
      delegationId,
    });

    return NextResponse.json({
      obligationId: result.noteId,
      updateId,
      version: result.version,
      signed: true,
      verified: result.verified,
      delegated: result.delegated,
      obligation: {
        currentAmount: result.currentAmount.toString(),
        pendingAmount: result.pendingAmount.toString(),
      },
    });
  } catch (e) {
    if (e instanceof TrackerError) {
      const status = e.code === "SIGNATURE_INVALID" ? 403
        : e.code === "UPDATE_EXPIRED" ? 410
        : e.code === "DELEGATION_EXPIRED" || e.code === "DELEGATION_INVALID" ? 403
        : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    throw e;
  }
}
