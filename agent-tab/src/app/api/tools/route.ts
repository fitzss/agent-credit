import { prisma } from "@/lib/prisma";
import { parseCredits } from "@/lib/credits";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";

export async function GET(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("providerId");
  const where = providerId ? { providerId } : {};
  const tools = await prisma.tool.findMany({
    where,
    include: { provider: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(toJsonSafe(tools));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const tool = await prisma.tool.create({
    data: {
      providerId: body.providerId,
      name: body.name,
      description: body.description || "",
      endpoint: body.endpoint,
      costPerCall: parseCredits(String(body.costPerCall)),
    },
  });
  return NextResponse.json(toJsonSafe(tool), { status: 201 });
}
