import { prisma } from "@/lib/prisma";
import { parseCredits } from "@/lib/credits";
import { tracker, TrackerError } from "@/lib/tracker/service";
import { validateTrustSignal, TrustSignalError } from "@/lib/adapters/trust-signal";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";

export async function GET(req: NextRequest) {
  const customerId = req.nextUrl.searchParams.get("customerId");
  const debtorPubKey = req.nextUrl.searchParams.get("debtorPubKey");

  if (debtorPubKey) {
    const delegations = await tracker.getDelegations(debtorPubKey);
    return NextResponse.json(toJsonSafe(delegations));
  }

  // App-layer convenience: look up by customerId
  if (customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return NextResponse.json([]);
    const delegations = await tracker.getDelegations(customer.publicKey);
    return NextResponse.json(toJsonSafe(delegations));
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

  // Agent binding: require agentIdentityId for new delegations
  const agentIdentityId = body.agentIdentityId;
  if (!agentIdentityId) {
    return NextResponse.json({ error: "Missing agentIdentityId — new delegations must be agent-bound" }, { status: 400 });
  }

  // Validate agent exists and belongs to the same customer
  const agent = await prisma.agentIdentity.findUnique({ where: { id: agentIdentityId } });
  if (!agent) {
    return NextResponse.json({ error: "Agent identity not found" }, { status: 400 });
  }
  const customer = body.customerId
    ? await prisma.customer.findUnique({ where: { id: body.customerId } })
    : await prisma.customer.findFirst({ where: { publicKey: debtorPubKey } });
  if (!customer || agent.customerId !== customer.id) {
    return NextResponse.json({ error: "Agent does not belong to this customer" }, { status: 400 });
  }

  // Trust-signal gate (v0): optional partner-issued eligibility signal.
  // Both fields must be supplied together or both omitted. Signal is opaque
  // to the route — the helper does binary validation via static dispatch.
  const trustSignalIssuer = body.trustSignalIssuer;
  const trustSignal = body.trustSignal;
  if ((trustSignalIssuer && !trustSignal) || (!trustSignalIssuer && trustSignal)) {
    return NextResponse.json(
      { error: "trustSignalIssuer and trustSignal must be supplied together", code: "MALFORMED_REQUEST" },
      { status: 400 }
    );
  }
  if (trustSignalIssuer && trustSignal) {
    try {
      await validateTrustSignal(trustSignalIssuer, trustSignal);
    } catch (e) {
      if (e instanceof TrustSignalError) {
        const status = e.code === "INVALID_SIGNAL" ? 403 : 400;
        return NextResponse.json({ error: e.message, code: e.code }, { status });
      }
      throw e;
    }
  }

  try {
    const result = await tracker.createDelegation({
      debtorPubKey,
      agentIdentityId,
      sessionPubKey: body.sessionPubKey,
      scopeProviderIds: body.scopeProviderIds || "*",
      scopeToolIds: body.scopeToolIds || "*",
      spendCap: parseCredits(String(body.spendCap)),
      expiresAt: body.expiresAt,
      authSignature: body.authSignature,
    });
    return NextResponse.json(toJsonSafe(result), { status: 201 });
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
  return NextResponse.json(toJsonSafe(result));
}
