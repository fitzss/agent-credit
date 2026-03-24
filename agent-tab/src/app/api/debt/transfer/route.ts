import { prisma } from "@/lib/prisma";
import { computeCumulativeTrackerDebt } from "@/lib/reconcile";
import { NextRequest, NextResponse } from "next/server";

const NANO_PER_CREDIT = 1_000_000_000;

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
 */
export async function POST(req: NextRequest) {
  const { fromObligationId, toObligationId, amountCredits } = await req.json();

  if (!fromObligationId || !toObligationId || !amountCredits) {
    return NextResponse.json(
      { error: "Missing required fields: fromObligationId, toObligationId, amountCredits" },
      { status: 400 }
    );
  }

  // --- Guardrail 1: Positive amount ---
  if (amountCredits <= 0) {
    return NextResponse.json({ error: "Transfer amount must be positive" }, { status: 400 });
  }

  if (fromObligationId === toObligationId) {
    return NextResponse.json({ error: "Cannot transfer to the same obligation" }, { status: 400 });
  }

  // --- Load obligations ---
  const fromOb = await prisma.obligationState.findUnique({ where: { id: fromObligationId } });
  if (!fromOb) return NextResponse.json({ error: "Source obligation not found" }, { status: 404 });

  const toOb = await prisma.obligationState.findUnique({ where: { id: toObligationId } });
  if (!toOb) return NextResponse.json({ error: "Target obligation not found" }, { status: 404 });

  // --- Guardrail 2: Same debtor ---
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
  if (fromOb.currentAmount < amountCredits - 0.000001) {
    return NextResponse.json({
      error: "Source obligation has insufficient debt for this transfer",
      sourceCurrentAmount: fromOb.currentAmount,
      transferAmount: amountCredits,
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
  // After transfer, the source pair's cumulative totalDebt must remain >= previouslyRedeemed.
  // totalDebt = previouslyRedeemed + currentAmount. After transfer: currentAmount decreases.
  // New totalDebt = previouslyRedeemed + (currentAmount - amountCredits).
  // Constraint: new totalDebt >= previouslyRedeemed → currentAmount - amountCredits >= 0.
  // This is already covered by guardrail 3. But let's check explicitly in nanoERG to be precise.
  const amountNanoErg = Math.round(amountCredits * NANO_PER_CREDIT);
  const newSourceAmount = fromOb.currentAmount - amountCredits;
  const newSourceAmountNanoErg = Math.round(newSourceAmount * NANO_PER_CREDIT);

  const { previouslyRedeemedNanoErg } = await computeCumulativeTrackerDebt(
    fromOb.customerId,
    fromOb.debtorPubKey,
    fromOb.creditorPubKey,
    newSourceAmountNanoErg, // hypothetical post-transfer amount
  );

  // Post-transfer totalDebt for source pair
  const postTransferTotalDebt = previouslyRedeemedNanoErg + newSourceAmountNanoErg;
  if (postTransferTotalDebt < previouslyRedeemedNanoErg) {
    // This shouldn't happen if newSourceAmountNanoErg >= 0, but check explicitly
    return NextResponse.json({
      error: "Transfer would make source pair's totalDebt fall below already-redeemed amount",
      previouslyRedeemedNanoErg,
      postTransferTotalDebtNanoErg: postTransferTotalDebt,
    }, { status: 409 });
  }

  // --- Execute atomically ---
  const newFromAmount = Math.max(0, fromOb.currentAmount - amountCredits);
  const newToAmount = toOb.currentAmount + amountCredits;

  const [updatedFrom, updatedTo, transfer] = await prisma.$transaction([
    prisma.obligationState.update({
      where: { id: fromObligationId },
      data: {
        currentAmount: newFromAmount,
        settlementStatus: newFromAmount <= 0 ? "settled" : "current",
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
        amountCredits,
        amountNanoErg: BigInt(amountNanoErg),
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
      amountCredits: transfer.amountCredits,
      amountNanoErg: transfer.amountNanoErg.toString(),
      fromCreditorPubKey: transfer.fromCreditorPubKey.substring(0, 16) + "...",
      toCreditorPubKey: transfer.toCreditorPubKey.substring(0, 16) + "...",
      status: transfer.status,
    },
    fromObligation: {
      id: updatedFrom.id,
      currentAmount: updatedFrom.currentAmount,
      settlementStatus: updatedFrom.settlementStatus,
    },
    toObligation: {
      id: updatedTo.id,
      currentAmount: updatedTo.currentAmount,
      settlementStatus: updatedTo.settlementStatus,
    },
    note: "Tracker will auto-update on next redemption for either pair.",
  });
}
