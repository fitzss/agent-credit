import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("providerId");
  const where = providerId ? { providerId } : {};
  const tools = await prisma.tool.findMany({
    where,
    include: { provider: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(tools);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const tool = await prisma.tool.create({
    data: {
      providerId: body.providerId,
      name: body.name,
      description: body.description || "",
      endpoint: body.endpoint,
      costPerCall: body.costPerCall,
    },
  });
  return NextResponse.json(tool, { status: 201 });
}
