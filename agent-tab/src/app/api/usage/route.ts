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

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const providerId = req.nextUrl.searchParams.get("providerId");
  const customerId = req.nextUrl.searchParams.get("customerId");
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50");

  if (customerId) {
    try {
      await requireCustomerOwned(customerId);
    } catch (e) {
      return authErrorResponse(e);
    }
  }

  const where: Prisma.UsageEventWhereInput = {};
  if (providerId) where.providerId = providerId;
  if (customerId) {
    where.customerId = customerId;
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (ownedIds !== null) where.customerId = { in: ownedIds };
  }

  const events = await prisma.usageEvent.findMany({
    where,
    include: { tool: true, agentIdentity: true },
    orderBy: { timestamp: "desc" },
    take: limit,
  });

  return NextResponse.json(toJsonSafe(events));
}
