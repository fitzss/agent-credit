import { tracker, TrackerError } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  requireCustomerOwned,
  authErrorResponse,
} from "@/lib/auth";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await params;

  const obligation = await prisma.obligationState.findUnique({
    where: { id },
    select: { customerId: true },
  });
  if (!obligation) {
    return NextResponse.json({ error: "obligation not found" }, { status: 404 });
  }

  try {
    await requireCustomerOwned(obligation.customerId);
  } catch (e) {
    return authErrorResponse(e);
  }

  try {
    const proof = await tracker.getNoteProof(id);
    return NextResponse.json(toJsonSafe(proof));
  } catch (e) {
    if (e instanceof TrackerError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    throw e;
  }
}
