import { prisma } from "@/lib/prisma";
import { getReserveStatus } from "@/lib/sidecar-client";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:8081";
const NANO_PER_CREDIT = 1_000_000_000;
const SECRETS_DIR = path.join(os.homedir(), ".chaincash-secrets");

/**
 * Ensure a secret file exists for a given role (owner/receiver) and pubkey.
 *
 * - If missing: creates it from the provided secretHex, mode 0o600
 * - If exists and pubKeyHex matches: no-op
 * - If exists but pubKeyHex mismatches: throws (never overwrites)
 * - If secretHex is empty/null in DB: throws with clear error
 *
 * File naming: {role}-{first8hexOfPubKey}.json
 * Contents: { "pubKeyHex": "...", "secretHex": "..." }
 */
export function ensureSecretFile(
  role: "owner" | "receiver",
  pubKeyHex: string,
  secretHex: string | null,
): void {
  if (!secretHex) {
    throw new ReconcileError(
      `No private key in DB for ${role} (pubkey ${pubKeyHex.substring(0, 16)}...). Cannot provision secret file.`,
      400,
    );
  }

  if (!fs.existsSync(SECRETS_DIR)) {
    fs.mkdirSync(SECRETS_DIR, { mode: 0o700 });
  }

  const prefix = pubKeyHex.substring(0, 8);
  const filename = `${role}-${prefix}.json`;
  const filepath = path.join(SECRETS_DIR, filename);

  if (fs.existsSync(filepath)) {
    // Verify match
    try {
      const existing = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      if (existing.pubKeyHex !== pubKeyHex) {
        throw new ReconcileError(
          `Secret file ${filename} exists but pubKeyHex mismatches. ` +
          `File has ${existing.pubKeyHex?.substring(0, 16)}..., expected ${pubKeyHex.substring(0, 16)}... ` +
          `Refusing to overwrite. Remove the file manually if the old key is no longer needed.`,
          409,
        );
      }
      // Match — nothing to do
    } catch (e) {
      if (e instanceof ReconcileError) throw e;
      throw new ReconcileError(`Cannot read existing secret file ${filename}: ${e}`, 500);
    }
  } else {
    // Create
    const content = JSON.stringify({ pubKeyHex, secretHex }, null, 2);
    fs.writeFileSync(filepath, content, { mode: 0o600 });
  }
}

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

/**
 * Compute the cumulative tracker debt for a (debtor, creditor) pair.
 *
 * The tracker tree stores ever-increasing cumulative debt: hash(A||B) → totalDebt.
 * For redemption, totalDebt = sum of all previously redeemed amounts + current obligation.
 * This is what the Schnorr signatures are computed over and what the contract verifies
 * against the tracker tree lookup.
 *
 * Invariant: totalDebtNanoErg == previouslyRedeemedNanoErg + currentObligationNanoErg
 *
 * This function is the single source of truth for this computation.
 * All redemption paths must use it to avoid silent regression of cumulative semantics.
 */
export async function computeCumulativeTrackerDebt(
  customerId: string,
  debtorPubKey: string,
  creditorPubKey: string,
  currentObligationNanoErg: number
): Promise<{ totalDebtNanoErg: number; previouslyRedeemedNanoErg: number }> {
  const priorSettlements = await prisma.settlementEvent.findMany({
    where: {
      method: "on-chain-redemption",
      status: "completed",
      obligationState: { customerId },
    },
    include: { obligationState: true },
  });

  const previouslyRedeemedNanoErg = priorSettlements
    .filter((s) =>
      s.obligationState.debtorPubKey === debtorPubKey &&
      s.obligationState.creditorPubKey === creditorPubKey
    )
    .reduce((sum, s) => sum + Math.round(s.amount * NANO_PER_CREDIT), 0);

  return {
    totalDebtNanoErg: previouslyRedeemedNanoErg + currentObligationNanoErg,
    previouslyRedeemedNanoErg,
  };
}

/**
 * Gather existing reserve tree entries from settlement history.
 * Used to reconstruct the PlasmaMap state for proof generation.
 *
 * IMPORTANT: Aggregates by (debtor, creditor) pair. The reserve tree stores
 * ONE cumulative value per pair, not individual settlement amounts. Multiple
 * settlements for the same pair must be summed into a single entry.
 */
export async function gatherExistingReserveEntries(customerId: string) {
  const priorSettlements = await prisma.settlementEvent.findMany({
    where: {
      method: "on-chain-redemption",
      status: "completed",
      obligationState: { customerId },
    },
    include: { obligationState: true },
  });

  // Aggregate by (debtor, creditor) pair — the reserve tree has one key per pair
  const pairMap = new Map<string, { ownerPubKeyHex: string; receiverPubKeyHex: string; redeemedNanoErg: number }>();
  for (const s of priorSettlements) {
    if (!s.redemptionTxId) continue;
    const pairKey = `${s.obligationState.debtorPubKey}|${s.obligationState.creditorPubKey}`;
    const existing = pairMap.get(pairKey);
    if (existing) {
      existing.redeemedNanoErg += Math.round(s.amount * NANO_PER_CREDIT);
    } else {
      pairMap.set(pairKey, {
        ownerPubKeyHex: s.obligationState.debtorPubKey,
        receiverPubKeyHex: s.obligationState.creditorPubKey,
        redeemedNanoErg: Math.round(s.amount * NANO_PER_CREDIT),
      });
    }
  }
  return Array.from(pairMap.values());
}

// --- Tracker lifecycle (TrackerBox + TrackerEntry models) ---

export interface TrackerDeploymentRecord {
  trackerNftId: string;
  debtorPubKey: string;
  creditorPubKey: string;
  totalDebtNanoErg: number;
  boxId: string;
  trackerPubKeyHex: string;
  treeDigestHex: string;
  txId?: string;
}

/**
 * Record a tracker deployment. Creates a TrackerBox with one TrackerEntry.
 * Supersedes any prior current box for the same NFT.
 *
 * Currently single-pair: each deploy creates a new box with one entry.
 * Phase B (multi-pair) will create boxes with multiple entries.
 */
export async function recordTrackerDeployment(record: TrackerDeploymentRecord) {
  // Mark any existing current box for this NFT as superseded
  await prisma.trackerBox.updateMany({
    where: { trackerNftId: record.trackerNftId, isCurrent: true },
    data: { isCurrent: false },
  });

  // Also update legacy TrackerDeployment if it exists
  await prisma.trackerDeployment.updateMany({
    where: { trackerNftId: record.trackerNftId, isCurrent: true },
    data: { isCurrent: false },
  });

  // Create new TrackerBox with entry
  const box = await prisma.trackerBox.create({
    data: {
      trackerNftId: record.trackerNftId,
      boxId: record.boxId,
      trackerPubKeyHex: record.trackerPubKeyHex,
      treeDigestHex: record.treeDigestHex,
      txId: record.txId,
      isCurrent: true,
      entries: {
        create: {
          debtorPubKey: record.debtorPubKey,
          creditorPubKey: record.creditorPubKey,
          totalDebtNanoErg: BigInt(record.totalDebtNanoErg),
        },
      },
    },
    include: { entries: true },
  });

  return box;
}

/**
 * Get the current tracker box for a given NFT ID.
 * Returns the box with all its entries.
 */
export async function getCurrentTrackerBox(trackerNftId: string) {
  return prisma.trackerBox.findFirst({
    where: { trackerNftId, isCurrent: true },
    include: { entries: true },
  });
}

/**
 * Find a specific pair's entry in the current tracker box.
 * Returns null if the box doesn't exist or the pair has no entry.
 */
export async function getTrackerEntryForPair(
  trackerNftId: string,
  debtorPubKey: string,
  creditorPubKey: string,
) {
  const box = await getCurrentTrackerBox(trackerNftId);
  if (!box) return null;
  const entry = box.entries.find(
    (e) => e.debtorPubKey === debtorPubKey && e.creditorPubKey === creditorPubKey
  );
  return entry ? { ...entry, trackerBoxId: box.boxId, trackerBox: box } : null;
}

/**
 * Validate that the current tracker box has an aligned entry for the given pair.
 * Returns { trackerBoxId } if aligned.
 * Throws ReconcileError if missing or stale.
 */
export async function validateTrackerAlignment(
  trackerNftId: string,
  debtorPubKey: string,
  creditorPubKey: string,
  requiredTotalDebtNanoErg: number,
): Promise<{ trackerBoxId: string }> {
  const entry = await getTrackerEntryForPair(trackerNftId, debtorPubKey, creditorPubKey);

  if (!entry) {
    throw new ReconcileError(
      "No tracker entry found for this (debtor, creditor) pair. Deploy tracker first.",
      404,
      { trackerNftId, debtorPubKey: debtorPubKey.substring(0, 16) + "...", creditorPubKey: creditorPubKey.substring(0, 16) + "..." }
    );
  }

  const committedDebt = Number(entry.totalDebtNanoErg);
  if (committedDebt !== requiredTotalDebtNanoErg) {
    throw new ReconcileError(
      "Tracker cumulative debt is stale: committed debt does not match required totalDebt.",
      409,
      {
        committedDebtNanoErg: committedDebt,
        requiredTotalDebtNanoErg,
        trackerBoxId: entry.trackerBoxId,
        hint: "Redeploy tracker with totalDebtNanoErg=" + requiredTotalDebtNanoErg,
      }
    );
  }

  return { trackerBoxId: entry.trackerBoxId };
}

const ERGO_NODE_API_KEY = process.env.ERGO_NODE_API_KEY || "hello";

/**
 * Deploy a tracker box via the sidecar and record it in DB.
 * Waits for on-chain confirmation before returning.
 * Returns the new TrackerDeployment record.
 */
export async function deployAndRecordTracker(params: {
  trackerNftId: string;
  debtorPubKey: string;
  creditorPubKey: string;
  totalDebtNanoErg: number;
}): Promise<{ trackerBoxId: string; deployment: any }> {
  const { trackerNftId, debtorPubKey, creditorPubKey, totalDebtNanoErg } = params;

  // Call sidecar
  const res = await fetch(`${SIDECAR_URL}/tracker/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ownerPubKeyHex: debtorPubKey,
      receiverPubKeyHex: creditorPubKey,
      totalDebtNanoErg,
      trackerNftId,
      nodeApiKey: ERGO_NODE_API_KEY,
    }),
  });
  const result = await res.json();
  if (result.error) {
    throw new ReconcileError(`Tracker deploy failed: ${result.error}`, 502);
  }

  // Record in DB (supersedes prior current deployment)
  const deployment = await recordTrackerDeployment({
    trackerNftId,
    debtorPubKey,
    creditorPubKey,
    totalDebtNanoErg,
    boxId: result.trackerBoxId,
    trackerPubKeyHex: result.trackerPubKeyHex,
    treeDigestHex: result.treeDigestHex,
    txId: result.txId,
  });

  // Wait for on-chain confirmation (tracker must be confirmed before redemption tx can reference it)
  const nodeUrl = SIDECAR_URL.replace(/:\d+$/, ":9052");
  let confirmed = false;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const checkRes = await fetch(`${nodeUrl}/blockchain/box/byId/${result.trackerBoxId}`);
      const checkData = await checkRes.json();
      if (checkData.boxId && !checkData.error) { confirmed = true; break; }
    } catch { /* retry */ }
  }

  if (!confirmed) {
    throw new ReconcileError(
      "Tracker deployed but not yet confirmed on-chain after 2 minutes. Retry redemption later.",
      202,
      { trackerBoxId: result.trackerBoxId, txId: result.txId }
    );
  }

  return { trackerBoxId: result.trackerBoxId, deployment };
}

/**
 * Ensure a tracker deployment is aligned for the given pair and totalDebt.
 * If aligned → returns trackerBoxId.
 * If stale or missing → auto-deploys a new tracker, waits for confirmation, returns new trackerBoxId.
 */
export async function ensureTrackerAligned(params: {
  trackerNftId: string;
  debtorPubKey: string;
  creditorPubKey: string;
  totalDebtNanoErg: number;
}): Promise<{ trackerBoxId: string; autoDeployed: boolean }> {
  const { trackerNftId, debtorPubKey, creditorPubKey, totalDebtNanoErg } = params;

  const entry = await getTrackerEntryForPair(trackerNftId, debtorPubKey, creditorPubKey);

  if (entry && Number(entry.totalDebtNanoErg) === totalDebtNanoErg) {
    // Aligned — use existing
    return { trackerBoxId: entry.trackerBoxId, autoDeployed: false };
  }

  // Stale or missing — auto-deploy

  const { trackerBoxId } = await deployAndRecordTracker({
    trackerNftId, debtorPubKey, creditorPubKey, totalDebtNanoErg,
  });

  return { trackerBoxId, autoDeployed: true };
}
