import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { toJsonSafe } from "@/lib/json-safe";
import { hashAgentApiKey, previewAgentApiKey } from "@/lib/agent-key-hash";
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
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          publicKey: true,
          status: true,
          signingMode: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const safe = identities.map(({ apiKeyHash: _h, ...rest }) => rest);

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

  // The raw apiKey is generated in-memory only and never stored. The 201
  // response is the one and only place it ever leaves the server; if the
  // caller does not capture it here, it is unrecoverable. The DB stores
  // apiKeyHash (HMAC-SHA256 + pepper) and apiKeyPreview (last 4 chars).
  const rawApiKey = randomUUID();
  const apiKeyHash = hashAgentApiKey(rawApiKey);
  const apiKeyPreview = previewAgentApiKey(rawApiKey);
  const identity = await prisma.agentIdentity.create({
    data: {
      customerId: body.customerId,
      label: body.label,
      allowedToolIds: body.allowedToolIds || "*",
      apiKeyHash,
      apiKeyPreview,
    },
  });

  // Drop apiKeyHash from the response — server-only, same contract as GETs.
  // Attach the raw apiKey explicitly: the only place it leaves the server.
  const { apiKeyHash: _h, ...safeRow } = identity;
  return NextResponse.json(
    toJsonSafe({ ...safeRow, apiKey: rawApiKey }),
    { status: 201 },
  );
}
