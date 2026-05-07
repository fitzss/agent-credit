import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import { requireSession, authErrorResponse } from "@/lib/auth";
import { PENDING_TTL_MS } from "@/lib/tracker/service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await params;

  const customer = await prisma.customer.findUnique({
    where: { id },
    select: { id: true, ownerUserId: true },
  });

  if (user.role === "operator") {
    if (!customer) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404 },
      );
    }
  } else {
    if (!customer || customer.ownerUserId !== user.id) {
      return NextResponse.json(
        { error: "customer not owned by current user" },
        { status: 403 },
      );
    }
  }

  const updates = await prisma.obligationUpdate.findMany({
    where: {
      signatureStatus: "pending",
      timestamp: { gte: new Date(Date.now() - PENDING_TTL_MS) },
      obligationState: { is: { customerId: id } },
    },
    select: {
      id: true,
      obligationStateId: true,
      canonicalMessage: true,
      delta: true,
      newAmount: true,
      type: true,
      delegationId: true,
      // ObligationUpdate stores agentIdentityId as a column but does not
      // declare a Prisma relation to AgentIdentity. Surface the id only;
      // the UI looks up the agent label via customer.agentIdentities.
      agentIdentityId: true,
      timestamp: true,
      obligationState: {
        select: {
          id: true,
          providerId: true,
          provider: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { timestamp: "desc" },
  });

  return NextResponse.json(toJsonSafe(updates));
}
