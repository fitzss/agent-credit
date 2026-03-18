import { prisma } from "@/lib/prisma";
import { generateKeypair } from "@/lib/crypto";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const providers = await prisma.provider.findMany({
    include: { tools: true, creditLines: { include: { customer: true } }, obligationStates: true },
    orderBy: { createdAt: "desc" },
  });
  // Strip private keys from response
  const safe = providers.map(({ privateKey: _, ...p }) => p);
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const keypair = generateKeypair();
  const provider = await prisma.provider.create({
    data: {
      name: body.name,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      settlementPrefs: body.settlementPrefs || "manual",
      defaultDueDays: body.defaultDueDays || 30,
    },
  });
  const { privateKey: _, ...safe } = provider;
  return NextResponse.json(safe, { status: 201 });
}
