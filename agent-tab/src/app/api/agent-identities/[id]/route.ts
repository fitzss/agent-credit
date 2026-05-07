import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import { requireSession, authErrorResponse } from "@/lib/auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

  const { status } = body as Record<string, unknown>;
  if (status !== "active" && status !== "revoked") {
    return NextResponse.json(
      { error: "status must be 'active' or 'revoked'" },
      { status: 400 },
    );
  }

  const { id } = await params;
  const agent = await prisma.agentIdentity.findUnique({
    where: { id },
    select: {
      id: true,
      customerId: true,
      customer: { select: { ownerUserId: true } },
    },
  });

  if (user.role === "operator") {
    if (!agent) {
      return NextResponse.json({ error: "Agent identity not found" }, { status: 404 });
    }
  } else {
    if (!agent || agent.customer.ownerUserId !== user.id) {
      return NextResponse.json(
        { error: "agent identity not owned by current user" },
        { status: 403 },
      );
    }
  }

  const updated = await prisma.agentIdentity.update({
    where: { id },
    data: { status },
  });
  const { apiKeyHash: _h, ...safe } = updated;
  return NextResponse.json(toJsonSafe(safe));
}
