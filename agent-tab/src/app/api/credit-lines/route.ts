import { prisma } from "@/lib/prisma";
import { parseCredits } from "@/lib/credits";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";

export async function GET(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("providerId");
  const customerId = req.nextUrl.searchParams.get("customerId");
  const where: Record<string, string> = {};
  if (providerId) where.providerId = providerId;
  if (customerId) where.customerId = customerId;

  const lines = await prisma.creditLine.findMany({
    where,
    include: { provider: true, customer: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(toJsonSafe(lines));
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Create credit line and initialize obligation state atomically
  const [creditLine] = await prisma.$transaction([
    prisma.creditLine.create({
      data: {
        providerId: body.providerId,
        customerId: body.customerId,
        limitAmount: parseCredits(String(body.limitAmount)),
        alertThreshold: body.alertThreshold ?? 0.8,
        dueDays: body.dueDays ?? 30,
      },
    }),
    prisma.obligationState.upsert({
      where: {
        providerId_customerId: {
          providerId: body.providerId,
          customerId: body.customerId,
        },
      },
      create: {
        providerId: body.providerId,
        customerId: body.customerId,
        currentAmount: BigInt(0),
      },
      update: {},
    }),
  ]);

  return NextResponse.json(toJsonSafe(creditLine), { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, ...data } = body;
  const updated = await prisma.creditLine.update({
    where: { id },
    data,
  });
  return NextResponse.json(toJsonSafe(updated));
}
