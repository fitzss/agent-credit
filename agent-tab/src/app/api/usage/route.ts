import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("providerId");
  const customerId = req.nextUrl.searchParams.get("customerId");
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50");

  const where: Record<string, string> = {};
  if (providerId) where.providerId = providerId;
  if (customerId) where.customerId = customerId;

  const events = await prisma.usageEvent.findMany({
    where,
    include: { tool: true, agentIdentity: true },
    orderBy: { timestamp: "desc" },
    take: limit,
  });

  return NextResponse.json(events);
}
