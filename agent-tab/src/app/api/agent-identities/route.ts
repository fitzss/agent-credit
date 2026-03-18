import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const customerId = req.nextUrl.searchParams.get("customerId");
  const where = customerId ? { customerId } : {};
  const identities = await prisma.agentIdentity.findMany({
    where,
    include: { customer: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(identities);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const identity = await prisma.agentIdentity.create({
    data: {
      customerId: body.customerId,
      label: body.label,
      allowedToolIds: body.allowedToolIds || "*",
    },
  });
  return NextResponse.json(identity, { status: 201 });
}
