import { prisma } from "@/lib/prisma";
import { generateKeypair } from "@/lib/crypto";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import { requireOperator, authErrorResponse } from "@/lib/auth";

export async function GET() {
  const customers = await prisma.customer.findMany({
    include: { agentIdentities: true, creditLines: { include: { provider: true } }, obligationStates: true },
    orderBy: { createdAt: "desc" },
  });
  const safe = customers.map(({ privateKey: _, ...c }) => c);
  return NextResponse.json(toJsonSafe(safe));
}

export async function POST(req: NextRequest) {
  let operator;
  try {
    operator = await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

  const body = await req.json();
  const keypair = generateKeypair();
  const customer = await prisma.customer.create({
    data: {
      name: body.name,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      contactEmail: body.contactEmail || null,
      ownerUserId: operator.id,
    },
  });
  const { privateKey: _, ...safe } = customer;
  return NextResponse.json(toJsonSafe(safe), { status: 201 });
}
