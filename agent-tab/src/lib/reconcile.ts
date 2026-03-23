import { prisma } from "@/lib/prisma";
import { getReserveStatus } from "@/lib/sidecar-client";

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:8081";
const NANO_PER_CREDIT = 1_000_000_000;

export interface ReconcileInput {
  reserveId: string;
  obligationId: string;
  redemptionTxId: string;
  grossRedeemNanoErg: number;
  feeNanoErg?: number;
  netPayoutNanoErg?: number;
}

export interface ReconcileResult {
  reconciled: true;
  redemptionTxId: string;
  accounting: {
    grossRedeemNanoErg: number;
    feeNanoErg: number | null;
    netPayoutNanoErg: number | null;
    grossRedeemCredits: number;
  };
  chainVerification: Record<string, boolean>;
  before: Record<string, any>;
  after: Record<string, any>;
  settlement: Record<string, any>;
}

export class ReconcileError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public detail?: any
  ) {
    super(message);
  }
}

/**
 * Core reconciliation logic — chain-verified, idempotent, atomic.
 * Throws ReconcileError on any guardrail failure.
 */
export async function reconcileRedemption(input: ReconcileInput): Promise<ReconcileResult> {
  const { reserveId, obligationId, redemptionTxId, grossRedeemNanoErg, feeNanoErg, netPayoutNanoErg } = input;

  // --- Guardrail 1: Duplicate detection ---
  const existing = await prisma.settlementEvent.findUnique({ where: { redemptionTxId } });
  if (existing) {
    throw new ReconcileError("Redemption already reconciled", 409, {
      existingSettlement: {
        id: existing.id,
        amount: existing.amount,
        redemptionTxId: existing.redemptionTxId,
      },
    });
  }

  // --- Load DB records ---
  const reserve = await prisma.reserve.findUnique({ where: { id: reserveId } });
  if (!reserve) throw new ReconcileError("Reserve not found", 404);

  const obligation = await prisma.obligationState.findUnique({ where: { id: obligationId } });
  if (!obligation) throw new ReconcileError("Obligation not found", 404);

  // --- Guardrail 2: Context consistency ---
  if (reserve.customerId !== obligation.customerId) {
    throw new ReconcileError("Reserve and obligation belong to different customers", 400, {
      reserveCustomerId: reserve.customerId,
      obligationCustomerId: obligation.customerId,
    });
  }

  // --- Guardrail 3: Sufficient debt ---
  const grossRedeemCredits = grossRedeemNanoErg / NANO_PER_CREDIT;
  if (obligation.currentAmount < grossRedeemCredits - 0.000001) {
    throw new ReconcileError("Obligation has insufficient debt", 409, {
      obligationCurrentAmount: obligation.currentAmount,
      grossRedeemCredits,
    });
  }

  // --- Guardrail 4: Verify tx on-chain ---
  const nodeUrl = SIDECAR_URL.replace(/:\d+$/, ":9052");
  let txData: any;
  try {
    const txRes = await fetch(`${nodeUrl}/blockchain/transaction/byId/${redemptionTxId}`);
    txData = await txRes.json();
    if (txData.error || !txData.inputs) {
      throw new ReconcileError("Redemption tx not found on-chain", 404, { redemptionTxId });
    }
  } catch (e: any) {
    if (e instanceof ReconcileError) throw e;
    throw new ReconcileError(`Failed to verify tx on-chain: ${e.message}`, 502);
  }

  // --- Guardrail 5: Tx spent expected box ---
  const txInputBoxIds: string[] = txData.inputs.map((i: any) => i.boxId);
  if (reserve.boxId && !txInputBoxIds.includes(reserve.boxId)) {
    throw new ReconcileError("Tx did not spend expected reserve box", 409, {
      expectedBoxId: reserve.boxId,
      actualInputs: txInputBoxIds,
    });
  }

  // --- Guardrail 6: Reserve token in output ---
  const txOutputs: any[] = txData.outputs || [];
  const reserveOutput = txOutputs.find((o: any) =>
    o.assets?.some((a: any) => a.tokenId === reserve.reserveTokenId)
  );
  if (!reserveOutput) {
    throw new ReconcileError("Reserve token not found in tx outputs", 409);
  }

  // --- Guardrail 7: Outflow matches ---
  const newReserveValue = BigInt(reserveOutput.value);
  const expectedValueAfter = reserve.valueNanoErg - BigInt(grossRedeemNanoErg);
  if (newReserveValue !== expectedValueAfter) {
    throw new ReconcileError("Reserve outflow mismatch", 409, {
      dbValueBefore: reserve.valueNanoErg.toString(),
      grossRedeemNanoErg,
      expectedAfter: expectedValueAfter.toString(),
      actualNewBoxValue: newReserveValue.toString(),
    });
  }

  // --- Guardrail 8: Sidecar cross-check ---
  const chainState = await getReserveStatus(reserve.reserveTokenId);
  if (!chainState.found || BigInt(chainState.valueNanoErg!) !== newReserveValue) {
    throw new ReconcileError("Sidecar state disagrees with tx output", 409);
  }

  // --- Compute ---
  const newObligationAmount = Math.max(0, obligation.currentAmount - grossRedeemCredits);
  const isFullySettled = newObligationAmount <= 0;

  const before = {
    reserve: { boxId: reserve.boxId, valueNanoErg: reserve.valueNanoErg.toString(), lifecycle: reserve.lifecycle },
    obligation: { currentAmount: obligation.currentAmount, settlementStatus: obligation.settlementStatus },
  };

  // --- Atomic writes ---
  const [, settlement] = await prisma.$transaction([
    prisma.reserve.update({
      where: { id: reserveId },
      data: {
        boxId: reserveOutput.boxId,
        valueNanoErg: newReserveValue,
        avlTreeDigest: chainState.avlTreeDigest,
        lifecycle: newReserveValue > 0n ? "active" : "depleted",
      },
    }),
    prisma.settlementEvent.create({
      data: {
        obligationStateId: obligationId,
        amount: grossRedeemCredits,
        method: "on-chain-redemption",
        status: "completed",
        redemptionTxId,
      },
    }),
    prisma.obligationState.update({
      where: { id: obligationId },
      data: {
        currentAmount: newObligationAmount,
        settlementStatus: isFullySettled ? "settled" : "partial",
      },
    }),
  ]);

  const after = {
    reserve: { boxId: reserveOutput.boxId, valueNanoErg: newReserveValue.toString(), lifecycle: newReserveValue > 0n ? "active" : "depleted" },
    obligation: { currentAmount: newObligationAmount, settlementStatus: isFullySettled ? "settled" : "partial" },
  };

  return {
    reconciled: true,
    redemptionTxId,
    accounting: { grossRedeemNanoErg, feeNanoErg: feeNanoErg || null, netPayoutNanoErg: netPayoutNanoErg || null, grossRedeemCredits },
    chainVerification: { txConfirmed: true, spentExpectedBox: true, reserveTokenInOutput: true, outflowVerified: true, sidecarConsistent: true },
    before,
    after,
    settlement: { id: settlement.id, amount: settlement.amount, method: settlement.method, redemptionTxId: settlement.redemptionTxId },
  };
}
