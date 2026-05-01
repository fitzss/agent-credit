import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import {
  requireSession,
  requireCustomerOwned,
  ownedCustomerIds,
  authErrorResponse,
} from "@/lib/auth";
import type { Prisma } from "@prisma/client";

function previewApiKey(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null;
  return `…${apiKey.slice(-4)}`;
}

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

  const safe = identities.map(({ apiKey, ...rest }) => ({
    ...rest,
    apiKeyPreview: previewApiKey(apiKey),
  }));

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
  // for the agent's runtime config. This is temporary until the future
  // key-hashing slice replaces the raw column with apiKeyHash + a one-time
  // recovery token.
  const identity = await prisma.agentIdentity.create({
    data: {
      customerId: body.customerId,
      label: body.label,
      allowedToolIds: body.allowedToolIds || "*",
    },
  });

  return NextResponse.json(toJsonSafe(identity), { status: 201 });
}
