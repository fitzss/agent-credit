import { prisma } from "@/lib/prisma";
import { parseCredits } from "@/lib/credits";
import { tracker, TrackerError } from "@/lib/tracker/service";
import { validateTrustSignal, TrustSignalError } from "@/lib/adapters/trust-signal";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";
import {
  requireSession,
  ownedCustomerIds,
  authErrorResponse,
} from "@/lib/auth";
import type { Customer } from "@prisma/client";

// ----------------------------------------------------------------------------
// Two-phase customer resolution.
//
// Phase 1 (this helper): load the row. No role-aware decisions.
// Phase 2 (in handlers): operator → 404 if missing; customer-role → collapse
//   missing AND not-owned to a single 403, so customer-role users cannot
//   enumerate ids/pubKeys via differential responses.
// Phase 3 (in handlers): mismatch check, ONLY after phase 2 has confirmed the
//   caller's access. A customer-role user must never see the 400 mismatch
//   verdict for a foreign or missing customer — that would leak existence.
//
// Downstream code uses canonicalCustomer.id and canonicalCustomer.publicKey;
// body.debtorPubKey is never passed to tracker.createDelegation.
// ----------------------------------------------------------------------------
async function loadCustomerFromInputs(args: {
  customerId?: string | null;
  debtorPubKey?: string | null;
}): Promise<{ customer: Customer | null; hadBoth: boolean }> {
  const { customerId, debtorPubKey } = args;
  const hadBoth = !!customerId && !!debtorPubKey;
  if (customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    return { customer, hadBoth };
  }
  if (debtorPubKey) {
    const customer = await prisma.customer.findFirst({ where: { publicKey: debtorPubKey } });
    return { customer, hadBoth };
  }
  return { customer: null, hadBoth: false };
}

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const customerId = req.nextUrl.searchParams.get("customerId");
  const debtorPubKey = req.nextUrl.searchParams.get("debtorPubKey");

  if (!customerId && !debtorPubKey) {
    return NextResponse.json({ error: "Provide customerId or debtorPubKey" }, { status: 400 });
  }

  const { customer, hadBoth } = await loadCustomerFromInputs({ customerId, debtorPubKey });

  // Phase 2 — role/ownership decision. Customer-role users get 403 for
  // BOTH missing and not-owned customers; operators get 404 for missing.
  if (user.role === "operator") {
    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (!customer || !ownedIds || !ownedIds.includes(customer.id)) {
      return NextResponse.json({ error: "customer not owned by current user" }, { status: 403 });
    }
  }

  // Phase 3 — mismatch check. Only reached after phase 2 has confirmed the
  // caller's access. Customer-role users can only see this 400 for owned
  // customers; foreign / missing customerIds were already 403'd above.
  if (hadBoth && debtorPubKey !== customer.publicKey) {
    return NextResponse.json(
      { error: "customerId and debtorPubKey refer to different customers" },
      { status: 400 },
    );
  }

  const delegations = await tracker.getDelegations(customer.publicKey);
  return NextResponse.json(toJsonSafe(delegations));
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const body = await req.json();

  // Malformed-input check — neither customer selector supplied. Returns 400
  // for both roles. Runs BEFORE loadCustomerFromInputs so a malformed POST
  // is not mis-categorized as operator-404 / customer-403.
  if (!body.customerId && !body.debtorPubKey) {
    return NextResponse.json({ error: "Provide customerId or debtorPubKey" }, { status: 400 });
  }

  const { customer, hadBoth } = await loadCustomerFromInputs({
    customerId: body.customerId,
    debtorPubKey: body.debtorPubKey,
  });

  // Phase 2 — role/ownership decision. Same leak-surface rule as GET.
  if (user.role === "operator") {
    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (!customer || !ownedIds || !ownedIds.includes(customer.id)) {
      return NextResponse.json({ error: "customer not owned by current user" }, { status: 403 });
    }
  }

  // Phase 3 — mismatch check. Only reached after phase 2 has confirmed the
  // caller's access to the loaded customer.
  if (hadBoth && body.debtorPubKey !== customer.publicKey) {
    return NextResponse.json(
      { error: "customerId and debtorPubKey refer to different customers" },
      { status: 400 },
    );
  }

  if (customer.signingMode !== "self-custody") {
    return NextResponse.json({ error: "Delegations are only for self-custody customers" }, { status: 400 });
  }

  // Required-fields check — debtorPubKey is no longer required from the
  // caller because we use canonical.publicKey downstream.
  if (!body.sessionPubKey || !body.spendCap || !body.expiresAt || !body.authSignature) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Agent binding: require agentIdentityId for new delegations
  const agentIdentityId = body.agentIdentityId;
  if (!agentIdentityId) {
    return NextResponse.json({ error: "Missing agentIdentityId — new delegations must be agent-bound" }, { status: 400 });
  }

  const agent = await prisma.agentIdentity.findUnique({ where: { id: agentIdentityId } });
  if (!agent || agent.customerId !== customer.id) {
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
      debtorPubKey: customer.publicKey,
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
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing delegation id" }, { status: 400 });

  const delegation = await prisma.delegation.findUnique({
    where: { id },
    select: { id: true, customerId: true },
  });

  // Same leak-surface rule: operator gets 404 for missing; customer-role
  // collapses missing + foreign into a single 403.
  if (user.role === "operator") {
    if (!delegation) {
      return NextResponse.json({ error: "Delegation not found" }, { status: 404 });
    }
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (!delegation || !ownedIds || !ownedIds.includes(delegation.customerId)) {
      return NextResponse.json({ error: "customer not owned by current user" }, { status: 403 });
    }
  }

  const result = await tracker.revokeDelegation(id);
  return NextResponse.json(toJsonSafe(result));
}
