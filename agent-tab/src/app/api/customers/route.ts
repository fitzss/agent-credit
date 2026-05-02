import { prisma } from "@/lib/prisma";
import { generateKeypair } from "@/lib/crypto";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import {
  requireSession,
  requireOperator,
  ownedCustomerIds,
  authErrorResponse,
} from "@/lib/auth";
import type { Prisma } from "@prisma/client";

export async function GET() {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const where: Prisma.CustomerWhereInput = {};
  const ownedIds = await ownedCustomerIds(user);
  if (ownedIds !== null) where.id = { in: ownedIds };

  const customers = await prisma.customer.findMany({
    where,
    include: { agentIdentities: true, creditLines: { include: { provider: true } }, obligationStates: true },
    orderBy: { createdAt: "desc" },
  });
  const safe = customers.map(({ privateKey: _pk, agentIdentities, ...c }) => ({
    ...c,
    agentIdentities: (agentIdentities ?? []).map(({ apiKey: _ak, apiKeyHash: _h, ...a }) => a),
  }));
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
