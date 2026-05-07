import { prisma } from "@/lib/prisma";
import { parseCredits, nanoCreditsToNanoErg } from "@/lib/credits";
import { computeCumulativeTrackerDebt } from "@/lib/reconcile";
import { NextRequest, NextResponse } from "next/server";
import { requireSession, ownedCustomerIds, authErrorResponse } from "@/lib/auth";

/**
 * POST /api/debt/transfer
 *
 * Debt transfer (novation): move amountCredits from obligation(A→B) to obligation(A→C).
 * Both obligations must share the same debtor (customer).
 *
 * The transfer only changes obligation amounts in Agent Tab.
 * The tracker tree auto-updates on the next redemption attempt for either pair
 * (via ensureTrackerAligned → deployAndRecordTracker).
 *
 * No on-chain transaction. No reserve contract interaction. No Schnorr signatures.
 *
 * Guardrails:
 * 1. Same debtor for both obligations
 * 2. Positive transfer amount
 * 3. Source has sufficient currentAmount
 * 4. No pending redemption for either obligation
 * 5. Redeemed-floor: source pair's post-transfer totalDebt >= previouslyRedeemed
 *
 * Order-of-checks rationale (slice 10b): auth → required-fields/amount/self
 * → load both rows → role/ownership decision (phase 2) → same-debtor equality
 * (phase 3) → existing pubKey/balance/pending/redeemed-floor guardrails →
 * atomic transaction. Phase 2 must run before phase 3 so customer-role users
 * cannot use the same-debtor 400 to enumerate foreign obligation ids.
 */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { fromObligationId, toObligationId, amountCredits } = await req.json();

  if (!fromObligationId || !toObligationId || !amountCredits) {
    return NextResponse.json(
      { error: "Missing required fields: fromObligationId, toObligationId, amountCredits" },
      { status: 400 }
    );
  }

  // --- Guardrail 1: Positive amount ---
  const amountStr = String(amountCredits);
  if (amountStr.startsWith("-") || amountStr === "0") {
    return NextResponse.json({ error: "Transfer amount must be positive" }, { status: 400 });
  }
  let amountNanoCredits: bigint;
  try {
    amountNanoCredits = parseCredits(amountStr);
  } catch {
    return NextResponse.json({ error: "Invalid amount format" }, { status: 400 });
  }
  if (amountNanoCredits <= BigInt(0)) {
    return NextResponse.json({ error: "Transfer amount must be positive" }, { status: 400 });
  }

  if (fromObligationId === toObligationId) {
    return NextResponse.json({ error: "Cannot transfer to the same obligation" }, { status: 400 });
  }

  // --- Phase 1: Load both obligations (no role-aware decisions) ---
  const fromOb = await prisma.obligationState.findUnique({ where: { id: fromObligationId } });
  const toOb = await prisma.obligationState.findUnique({ where: { id: toObligationId } });

  // --- Phase 2: Role/ownership decision (must run BEFORE phase 3 same-debtor check) ---
  if (user.role === "operator") {
    if (!fromOb) return NextResponse.json({ error: "Source obligation not found" }, { status: 404 });
    if (!toOb) return NextResponse.json({ error: "Target obligation not found" }, { status: 404 });
  } else {
    const ownedIds = await ownedCustomerIds(user);
    if (
      !fromOb ||
      !toOb ||
      !ownedIds ||
      !ownedIds.includes(fromOb.customerId) ||
      !ownedIds.includes(toOb.customerId)
    ) {
      return NextResponse.json(
        { error: "customer not owned by current user" },
        { status: 403 }
      );
    }
  }

  // --- Phase 3: Same debtor (only reached after ownership confirmed) ---
  if (fromOb.customerId !== toOb.customerId) {
    return NextResponse.json({
      error: "Obligations must belong to the same debtor (customer)",
      fromCustomerId: fromOb.customerId,
      toCustomerId: toOb.customerId,
    }, { status: 400 });
  }

  if (fromOb.debtorPubKey !== toOb.debtorPubKey) {
    return NextResponse.json({
      error: "Obligations must share the same debtorPubKey",
    }, { status: 400 });
  }

  // --- Guardrail 3: Sufficient source amount ---
  if (fromOb.currentAmount < amountNanoCredits) {
    return NextResponse.json({
      error: "Source obligation has insufficient debt for this transfer",
      sourceCurrentAmount: fromOb.currentAmount.toString(),
      transferAmount: amountNanoCredits.toString(),
    }, { status: 409 });
  }

  // --- Guardrail 4: No pending redemptions ---
  const pendingFrom = await prisma.pendingRedemption.findFirst({
    where: { obligationId: fromObligationId, status: "pending" },
  });
  if (pendingFrom) {
    return NextResponse.json({
      error: "Source obligation has a pending redemption — wait for it to complete",
      pendingTxId: pendingFrom.txId,
    }, { status: 409 });
  }

  const pendingTo = await prisma.pendingRedemption.findFirst({
    where: { obligationId: toObligationId, status: "pending" },
  });
  if (pendingTo) {
    return NextResponse.json({
      error: "Target obligation has a pending redemption — wait for it to complete",
      pendingTxId: pendingTo.txId,
    }, { status: 409 });
  }

  // --- Guardrail 5: Redeemed-floor constraint ---
  const amountNanoErg = nanoCreditsToNanoErg(amountNanoCredits);
  const newSourceAmount = fromOb.currentAmount - amountNanoCredits;
  const newSourceAmountNanoErg = nanoCreditsToNanoErg(newSourceAmount);

  const { previouslyRedeemedNanoErg } = await computeCumulativeTrackerDebt(
    fromOb.customerId,
    fromOb.debtorPubKey,
    fromOb.creditorPubKey,
    newSourceAmountNanoErg, // hypothetical post-transfer amount
  );

  // Post-transfer totalDebt for source pair
  const postTransferTotalDebt = previouslyRedeemedNanoErg + newSourceAmountNanoErg;
  if (postTransferTotalDebt < previouslyRedeemedNanoErg) {
    return NextResponse.json({
      error: "Transfer would make source pair's totalDebt fall below already-redeemed amount",
      previouslyRedeemedNanoErg: previouslyRedeemedNanoErg.toString(),
      postTransferTotalDebtNanoErg: postTransferTotalDebt.toString(),
    }, { status: 409 });
  }

  // --- Execute atomically ---
  const newFromAmount = newSourceAmount < BigInt(0) ? BigInt(0) : newSourceAmount;
  const newToAmount = toOb.currentAmount + amountNanoCredits;

  const [updatedFrom, updatedTo, transfer] = await prisma.$transaction([
    prisma.obligationState.update({
      where: { id: fromObligationId },
      data: {
        currentAmount: newFromAmount,
        settlementStatus: newFromAmount <= BigInt(0) ? "settled" : "current",
      },
    }),
    prisma.obligationState.update({
      where: { id: toObligationId },
      data: {
        currentAmount: newToAmount,
        settlementStatus: "current",
      },
    }),
    prisma.debtTransfer.create({
      data: {
        fromObligationId,
        toObligationId,
        amountCredits: amountNanoCredits,
        amountNanoErg,
        debtorPubKey: fromOb.debtorPubKey,
        fromCreditorPubKey: fromOb.creditorPubKey,
        toCreditorPubKey: toOb.creditorPubKey,
        status: "completed",
      },
    }),
  ]);

  return NextResponse.json({
    transfer: {
      id: transfer.id,
      amountCredits: transfer.amountCredits.toString(),
      amountNanoErg: transfer.amountNanoErg.toString(),
      fromCreditorPubKey: transfer.fromCreditorPubKey.substring(0, 16) + "...",
      toCreditorPubKey: transfer.toCreditorPubKey.substring(0, 16) + "...",
      status: transfer.status,
    },
    fromObligation: {
      id: updatedFrom.id,
      currentAmount: updatedFrom.currentAmount.toString(),
      settlementStatus: updatedFrom.settlementStatus,
    },
    toObligation: {
      id: updatedTo.id,
      currentAmount: updatedTo.currentAmount.toString(),
      settlementStatus: updatedTo.settlementStatus,
    },
    note: "Tracker will auto-update on next redemption for either pair.",
  });
}
