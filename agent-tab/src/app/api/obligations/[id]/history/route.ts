import { tracker } from "@/lib/tracker/service";
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

  const history = await tracker.getNoteHistory(id);
  return NextResponse.json(toJsonSafe(history));
}
