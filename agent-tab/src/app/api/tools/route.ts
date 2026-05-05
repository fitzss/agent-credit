import { prisma } from "@/lib/prisma";
import { parseCredits } from "@/lib/credits";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import { requireOperator, requireSession, authErrorResponse } from "@/lib/auth";

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const providerId = req.nextUrl.searchParams.get("providerId");
  const where = providerId ? { providerId } : {};
  const tools = await prisma.tool.findMany({
    where,
    include: { provider: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(toJsonSafe(tools));
}

export async function POST(req: NextRequest) {
  try {
    await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

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
