import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { toJsonSafe } from "@/lib/json-safe";
import { hashAgentApiKey } from "@/lib/agent-key-hash";
import {
  requireSession,
  requireCustomerOwned,
  ownedCustomerIds,
  authErrorResponse,
} from "@/lib/auth";
import type { Prisma } from "@prisma/client";

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const customerId = req.nextUrl.searchParams.get("customerId");

  if (customerId) {
    try {
      await requireCustomerOwned(customerId);
    } catch (e) {
      return authErrorResponse(e);
    }
  }

  const where: Prisma.AgentIdentityWhereInput = {};
  if (customerId) {
    where.customerId = customerId;
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (ownedIds !== null) where.customerId = { in: ownedIds };
  }

  const identities = await prisma.agentIdentity.findMany({
    where,
    include: { customer: true },
    orderBy: { createdAt: "desc" },
  });

  const safe = identities.map(({ apiKey: _ak, apiKeyHash: _h, ...rest }) => rest);

  return NextResponse.json(toJsonSafe(safe));
}

export async function POST(req: NextRequest) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.customerId || typeof body.customerId !== "string") {
    return NextResponse.json({ error: "customerId required" }, { status: 400 });
  }

  try {
    await requireCustomerOwned(body.customerId);
  } catch (e) {
    return authErrorResponse(e);
  }

  // NOTE: this 201 response includes the freshly-generated raw apiKey exactly
  // once. The caller (owning customer or operator) is expected to capture it
  // for the agent's runtime config. Slice 8A dual-writes apiKey + apiKeyHash;
  // slice 8B will drop the raw column and the 201 will become the only place
  // the raw value ever exists outside the caller's hands.
  const rawApiKey = randomUUID();
  const apiKeyHash = hashAgentApiKey(rawApiKey);
  const apiKeyPreview = `…${rawApiKey.slice(-4)}`;
  const identity = await prisma.agentIdentity.create({
    data: {
      customerId: body.customerId,
      label: body.label,
      allowedToolIds: body.allowedToolIds || "*",
      apiKey: rawApiKey,
      apiKeyHash,
      apiKeyPreview,
    },
  });

  return NextResponse.json(toJsonSafe(identity), { status: 201 });
}
