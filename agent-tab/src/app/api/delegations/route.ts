import { prisma } from "@/lib/prisma";
import { tracker, TrackerError } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const customerId = req.nextUrl.searchParams.get("customerId");
  const debtorPubKey = req.nextUrl.searchParams.get("debtorPubKey");

  if (debtorPubKey) {
    const delegations = await tracker.getDelegations(debtorPubKey);
    return NextResponse.json(delegations);
  }

  // App-layer convenience: look up by customerId
  if (customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return NextResponse.json([]);
    const delegations = await tracker.getDelegations(customer.publicKey);
    return NextResponse.json(delegations);
  }

  return NextResponse.json({ error: "Provide customerId or debtorPubKey" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // App-layer: resolve customerId to publicKey if needed
  let debtorPubKey = body.debtorPubKey;
  if (!debtorPubKey && body.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId } });
    if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    if (customer.signingMode !== "self-custody") {
      return NextResponse.json({ error: "Delegations are only for self-custody customers" }, { status: 400 });
    }
    debtorPubKey = customer.publicKey;
  }

  if (!debtorPubKey || !body.sessionPubKey || !body.spendCap || !body.expiresAt || !body.authSignature) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const result = await tracker.createDelegation({
      debtorPubKey,
      sessionPubKey: body.sessionPubKey,
      scopeProviderIds: body.scopeProviderIds || "*",
      scopeToolIds: body.scopeToolIds || "*",
      spendCap: body.spendCap,
      expiresAt: body.expiresAt,
      authSignature: body.authSignature,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof TrackerError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing delegation id" }, { status: 400 });
  const result = await tracker.revokeDelegation(id);
  return NextResponse.json(result);
}
