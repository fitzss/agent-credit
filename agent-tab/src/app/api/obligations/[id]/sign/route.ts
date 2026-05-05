import { tracker, TrackerError } from "@/lib/tracker/service";
import { authErrorResponse, ownedCustomerIds, requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

/**
 * Thin app-layer wrapper around tracker.commitNoteUpdate().
 *
 * Slice 11b: gate POST with session owner-or-operator. Cryptographic
 * verification inside tracker.commitNoteUpdate is unchanged.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { signature, updateId, delegationId } = body as Record<string, unknown>;

  if (typeof signature !== "string" || typeof updateId !== "string") {
    return NextResponse.json({ error: "Missing signature or updateId" }, { status: 400 });
  }

  if (delegationId !== undefined && delegationId !== null && typeof delegationId !== "string") {
    return NextResponse.json({ error: "Invalid delegationId" }, { status: 400 });
  }

  const { id } = await params;

  // Phase 1: load (no role-aware decisions yet)
  const note = await prisma.obligationState.findUnique({ where: { id } });

  // Phase 2: role/ownership decision
  if (user.role === "operator") {
    if (!note) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (!note || !ownedIds || !ownedIds.includes(note.customerId)) {
      return NextResponse.json(
        { error: "customer not owned by current user" },
        { status: 403 }
      );
    }
  }

  try {
    const result = await tracker.commitNoteUpdate({
      noteId: id,
      updateId,
      signature,
      delegationId: typeof delegationId === "string" ? delegationId : undefined,
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
