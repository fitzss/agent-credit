import { prisma } from "@/lib/prisma";
import { parseCredits } from "@/lib/credits";
import { tracker, TrackerError } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { requireSession, ownedCustomerIds, authErrorResponse } from "@/lib/auth";

/**
 * Settlement — app-layer action that uses tracker for note update.
 */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const body = await req.json();
  const { providerId, customerId, amount, method } = body;

  if (!providerId || !customerId || !amount) {
    return NextResponse.json({ error: "Missing providerId, customerId, or amount" }, { status: 400 });
  }

  // Inline ownership: operator bypass; customer-role missing/foreign customerId
  // collapses to 403 with the same body so customer-role users cannot enumerate
  // customer ids via differential responses.
  if (user.role !== "operator") {
    const ownedIds = await ownedCustomerIds(user);
    if (!ownedIds || !ownedIds.includes(customerId)) {
      return NextResponse.json(
        { error: "customer not owned by current user" },
        { status: 403 }
      );
    }
  }

  const parsedAmount = parseCredits(String(amount));

  const obligation = await prisma.obligationState.findUnique({
    where: { providerId_customerId: { providerId, customerId } },
  });
  if (!obligation) {
    return NextResponse.json({ error: "No obligation found" }, { status: 404 });
  }

  const settleAmount = parsedAmount < obligation.currentAmount ? parsedAmount : obligation.currentAmount;
  if (settleAmount <= BigInt(0)) {
    return NextResponse.json({ error: "Nothing to settle" }, { status: 400 });
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const isSelfCustody = customer.signingMode === "self-custody";
  const trackerKey = isSelfCustody ? undefined : customer.privateKey;

  try {
    const delta = -settleAmount;
    const result = await tracker.proposeNoteUpdate(
      {
        debtorPubKey: obligation.debtorPubKey,
        creditorPubKey: obligation.creditorPubKey,
        delta,
        expectedVersion: obligation.version,
        requestId: uuid(),
        providerId,
      },
      trackerKey
    );

    // Create settlement event (app-layer concern)
    const settlement = await prisma.settlementEvent.create({
      data: {
        obligationStateId: obligation.id,
        amount: settleAmount,
        method: method || "manual",
        status: "completed",
      },
    });

    // Update settlement status
    const newAmount = obligation.currentAmount - settleAmount;
    if (newAmount <= BigInt(0) && !isSelfCustody) {
      await prisma.obligationState.update({
        where: { id: obligation.id },
        data: { settlementStatus: "settled" },
      });
    }

    return NextResponse.json({
      obligation: {
        currentAmount: result.currentAmount.toString(),
        pendingAmount: result.pendingAmount.toString(),
        version: result.version,
      },
      settlement: { ...settlement, amount: settlement.amount.toString() },
      ...(isSelfCustody
        ? {
            pendingSignature: true,
            canonicalMessage: result.canonicalMessage,
            obligationId: result.noteId,
            updateId: result.updateId,
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof TrackerError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }
}
