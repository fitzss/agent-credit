#!/usr/bin/env tsx
/**
 * check-settlement-readiness (slice 13a)
 *
 * Read-only diagnostic. Answers:
 *
 *   "Given a reserveId and an obligationStateId, can this obligation
 *    settle/redeem against this reserve right now? If not, exactly why not?"
 *
 * Mirrors the precondition gates of POST /api/reserves/redeem and
 * src/lib/reconcile.ts but READS instead of acts. Performs no DB writes,
 * no chain transactions, no sidecar mutations, no tracker deploys.
 *
 * Usage:
 *   npx tsx scripts/check-settlement-readiness.ts \
 *     --reserve-id <reserveId> \
 *     --obligation-state-id <obligationStateId>
 *
 *   Convenience:
 *     --latest-repo-lint   Substitute for --obligation-state-id. Resolves the
 *                          most recent ObligationState under provider
 *                          mcp-demo-repo-tools-001 (slice 12a.1 fixture).
 *                          Mutually exclusive with --obligation-state-id.
 *
 *   Other:
 *     --json               Emit JSON only (suppress human-readable stderr summary).
 *     --help, -h           Show this help.
 *
 * Exit codes:
 *   0  PASS   — every check green
 *   1  FAIL   — at least one blocker
 *   2  MISUSE — missing/conflicting/unknown flags, or --latest-repo-lint with no row
 *
 * ============================================================================
 * UNIT INVARIANT (v1)
 * ============================================================================
 * v1 settlement uses an identity mapping: 1 nanoCredit == 1 nanoErg.
 *
 *   - Source of truth: src/lib/credits.ts:NANOCREDITS_PER_CREDIT (== 1e9)
 *     and src/lib/credits.ts:nanoCreditsToNanoErg (returns input unchanged).
 *   - Reserve.valueNanoErg is denominated in nanoErg.
 *   - ObligationState.currentAmount is denominated in nanoCredits.
 *   - Under v1, comparing the two as the same magnitude is sound iff the
 *     identity holds. We verify the identity at runtime; if a future
 *     contract version breaks it, unit-crossing checks (#14, #16, #19)
 *     report WARN instead of silently passing.
 *
 *   Unit-crossing checks: #14 (tracker totalDebtNanoErg vs prior+current),
 *   #16 (sidecar valueNanoErg vs obligation currentAmount), #19 (Reserve
 *   avlTreeDigest DB vs sidecar — same hex string, no unit issue but
 *   listed here because it is part of the chain↔DB boundary).
 * ============================================================================
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { prisma } from "@/lib/prisma";
import { formatCredits, nanoCreditsToNanoErg } from "@/lib/credits";
import { getSidecarHealth, getReserveStatus, type SidecarHealth, type ReserveStatus } from "@/lib/sidecar-client";

// Where the redeem route writes/looks up Schnorr secret files.
// MUST match src/lib/reconcile.ts:SECRETS_DIR.
const SECRETS_DIR = path.join(os.homedir(), ".chaincash-secrets");

// Repo-lint demo provider, seeded by scripts/seed-repo-lint-demo.ts (slice 12a.1).
const REPO_LINT_PROVIDER_ID = "mcp-demo-repo-tools-001";

// Hard cap on each sidecar fetch. Script-local; does not modify sidecar-client.
const SIDECAR_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

interface Args {
  reserveId: string | null;
  obligationStateId: string | null;
  latestRepoLint: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    reserveId: null,
    obligationStateId: null,
    latestRepoLint: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--latest-repo-lint") {
      args.latestRepoLint = true;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--reserve-id") {
      const v = argv[++i];
      if (!v) throw new Error("--reserve-id requires a value");
      args.reserveId = v;
    } else if (a === "--obligation-state-id") {
      const v = argv[++i];
      if (!v) throw new Error("--obligation-state-id requires a value");
      args.obligationStateId = v;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(
    `check-settlement-readiness (slice 13a)\n\n` +
    `Read-only audit. Reports whether an obligation can settle against a reserve,\n` +
    `and if not, why. Performs no DB writes, no chain txs, no sidecar mutations.\n\n` +
    `Usage:\n` +
    `  npx tsx scripts/check-settlement-readiness.ts --reserve-id <id> --obligation-state-id <id>\n\n` +
    `Required:\n` +
    `  --reserve-id <id>           Reserve.id to audit against\n` +
    `  --obligation-state-id <id>  ObligationState.id to audit (mutually exclusive\n` +
    `                              with --latest-repo-lint)\n\n` +
    `Convenience:\n` +
    `  --latest-repo-lint          Resolve most recent ObligationState under\n` +
    `                              provider ${REPO_LINT_PROVIDER_ID}\n\n` +
    `Other:\n` +
    `  --json                      Emit JSON only (no stderr summary)\n` +
    `  --help, -h                  Show this help\n\n` +
    `Exit codes:\n` +
    `  0   PASS — every check green\n` +
    `  1   FAIL — at least one blocker (DB unchanged)\n` +
    `  2   MISUSE — missing/conflicting flags, or --latest-repo-lint with no row\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sidecar helpers (script-local timeout wrappers; do not modify sidecar-client)
// ─────────────────────────────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Check primitives
// ─────────────────────────────────────────────────────────────────────────

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface Check {
  id: number;
  label: string;
  status: CheckStatus;
  detail: string;
}

function pass(id: number, label: string, detail: string): Check {
  return { id, label, status: "pass", detail };
}
function fail(id: number, label: string, detail: string): Check {
  return { id, label, status: "fail", detail };
}
function warn(id: number, label: string, detail: string): Check {
  return { id, label, status: "warn", detail };
}
function skip(id: number, label: string, detail: string): Check {
  return { id, label, status: "skip", detail };
}

// ─────────────────────────────────────────────────────────────────────────
// Main audit
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n\n`);
    printHelp();
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // CLI validation
  if (args.obligationStateId && args.latestRepoLint) {
    process.stderr.write(
      `Error: --obligation-state-id and --latest-repo-lint are mutually exclusive.\n\n`,
    );
    printHelp();
    process.exit(2);
  }
  if (!args.reserveId) {
    process.stderr.write(`Error: --reserve-id is required.\n\n`);
    printHelp();
    process.exit(2);
  }
  if (!args.obligationStateId && !args.latestRepoLint) {
    process.stderr.write(
      `Error: provide --obligation-state-id <id> or --latest-repo-lint.\n\n`,
    );
    printHelp();
    process.exit(2);
  }

  // Resolve --latest-repo-lint
  let resolvedObligationStateId: string;
  if (args.latestRepoLint) {
    const latest = await prisma.obligationState.findFirst({
      where: { providerId: REPO_LINT_PROVIDER_ID },
      orderBy: { lastUpdatedAt: "desc" },
    });
    if (!latest) {
      process.stderr.write(
        `Error: --latest-repo-lint found no ObligationState under provider ${REPO_LINT_PROVIDER_ID}.\n` +
        `       Run scripts/seed-repo-lint-demo.ts and one /api/proxy call first.\n`,
      );
      await prisma.$disconnect();
      process.exit(2);
    }
    resolvedObligationStateId = latest.id;
  } else {
    resolvedObligationStateId = args.obligationStateId!;
  }

  // ── Load context (read-only) ───────────────────────────────────────────

  const reserve = await prisma.reserve.findUnique({
    where: { id: args.reserveId! },
    include: { customer: true },
  });

  const obligation = await prisma.obligationState.findUnique({
    where: { id: resolvedObligationStateId },
    include: { customer: true, provider: true },
  });

  // Sidecar /health (also gates checks 4, 14, 16, 19)
  let sidecarHealth: SidecarHealth | null = null;
  try {
    sidecarHealth = await withTimeout(getSidecarHealth(), SIDECAR_TIMEOUT_MS, "sidecar /health");
  } catch {
    sidecarHealth = null;
  }

  // Sidecar /reserve/status (only if reserve has a reserveTokenId we can ask about)
  let sidecarReserve: ReserveStatus | null = null;
  let sidecarReserveErr: string | null = null;
  if (sidecarHealth && reserve?.reserveTokenId) {
    try {
      sidecarReserve = await withTimeout(
        getReserveStatus(reserve.reserveTokenId),
        SIDECAR_TIMEOUT_MS,
        "sidecar /reserve/status",
      );
    } catch (e) {
      sidecarReserveErr = e instanceof Error ? e.message : String(e);
    }
  }

  const pendingRedemption = obligation
    ? await prisma.pendingRedemption.findFirst({
        where: { obligationId: obligation.id, status: "pending" },
      })
    : null;

  // ── Tracker readiness (only meaningful if reserve has trackerNftId) ───
  const currentTrackerBox = reserve?.trackerNftId
    ? await prisma.trackerBox.findFirst({
        where: { trackerNftId: reserve.trackerNftId, isCurrent: true },
        include: { entries: true },
      })
    : null;

  const trackerEntry = currentTrackerBox && obligation
    ? currentTrackerBox.entries.find(
        (e) =>
          e.debtorPubKey === obligation.debtorPubKey &&
          e.creditorPubKey === obligation.creditorPubKey,
      ) ?? null
    : null;

  // Prior on-chain settlements for this (debtor, creditor) pair.
  // Mirrors src/lib/reconcile.ts:computeCumulativeTrackerDebt.
  let priorRedeemedNanoErg = BigInt(0);
  let priorSettlementsCount = 0;
  if (obligation) {
    const priorSettlements = await prisma.settlementEvent.findMany({
      where: {
        method: "on-chain-redemption",
        status: "completed",
        obligationState: {
          customerId: obligation.customerId,
          debtorPubKey: obligation.debtorPubKey,
          creditorPubKey: obligation.creditorPubKey,
        },
      },
      include: { obligationState: true },
    });
    priorSettlementsCount = priorSettlements.length;
    priorRedeemedNanoErg = priorSettlements.reduce(
      (sum, s) => sum + nanoCreditsToNanoErg(s.amount),
      BigInt(0),
    );
  }

  // ── Run all 19 checks (always run every check; collect results) ───────

  const checks: Check[] = [];

  // 1. Sidecar /health reachable
  if (sidecarHealth) {
    checks.push(pass(1, "Sidecar /health reachable", `status=${sidecarHealth.status}, network=${sidecarHealth.network}`));
  } else {
    checks.push(fail(1, "Sidecar /health reachable", "sidecar unreachable or returned non-OK; check that the JVM sidecar is running on SIDECAR_URL"));
  }
  const sidecarReachable = !!sidecarHealth;

  // 2. Reserve row exists
  if (reserve) {
    checks.push(pass(2, "Reserve row exists", `id=${reserve.id}`));
  } else {
    checks.push(fail(2, "Reserve row exists", `no Reserve found with id=${args.reserveId}`));
  }

  // 3. Reserve.boxId non-null
  if (!reserve) {
    checks.push(skip(3, "Reserve.boxId non-null", "reserve row missing"));
  } else if (reserve.boxId) {
    checks.push(pass(3, "Reserve.boxId non-null", `boxId=${reserve.boxId.substring(0, 16)}...`));
  } else {
    checks.push(fail(3, "Reserve.boxId non-null", "reserve has no on-chain boxId; deploy the reserve first"));
  }

  // 4. Sidecar /reserve/status returns found:true
  if (!sidecarReachable) {
    checks.push(skip(4, "Sidecar /reserve/status: found", "sidecar unreachable"));
  } else if (!reserve) {
    checks.push(skip(4, "Sidecar /reserve/status: found", "reserve row missing"));
  } else if (sidecarReserveErr) {
    checks.push(skip(4, "Sidecar /reserve/status: found", `sidecar query failed: ${sidecarReserveErr}`));
  } else if (sidecarReserve?.found) {
    checks.push(pass(4, "Sidecar /reserve/status: found", `valueNanoErg=${sidecarReserve.valueNanoErg}`));
  } else {
    checks.push(fail(4, "Sidecar /reserve/status: found", "sidecar reports reserve not found on-chain for this reserveTokenId"));
  }

  // 5. Reserve.debtorPubKey == Customer.publicKey
  if (!reserve) {
    checks.push(skip(5, "Reserve.debtorPubKey matches Customer.publicKey", "reserve row missing"));
  } else if (!reserve.customer) {
    checks.push(fail(5, "Reserve.debtorPubKey matches Customer.publicKey", "reserve customer record missing"));
  } else if (reserve.debtorPubKey === reserve.customer.publicKey) {
    checks.push(pass(5, "Reserve.debtorPubKey matches Customer.publicKey", `${reserve.debtorPubKey.substring(0, 16)}...`));
  } else {
    checks.push(fail(5, "Reserve.debtorPubKey matches Customer.publicKey",
      `reserve.debtorPubKey=${reserve.debtorPubKey.substring(0, 16)}... but customer.publicKey=${reserve.customer.publicKey.substring(0, 16)}...`));
  }

  // 6. Obligation row exists
  if (obligation) {
    checks.push(pass(6, "Obligation row exists", `id=${obligation.id}`));
  } else {
    checks.push(fail(6, "Obligation row exists", `no ObligationState found with id=${resolvedObligationStateId}`));
  }

  // 7. Obligation.currentAmount > 0
  if (!obligation) {
    checks.push(skip(7, "Obligation.currentAmount > 0", "obligation row missing"));
  } else if (obligation.currentAmount > BigInt(0)) {
    checks.push(pass(7, "Obligation.currentAmount > 0", `${formatCredits(obligation.currentAmount)} credits`));
  } else {
    checks.push(fail(7, "Obligation.currentAmount > 0", "obligation already settled or never charged (currentAmount=0)"));
  }

  // 8. Reserve.customerId == Obligation.customerId
  if (!reserve || !obligation) {
    checks.push(skip(8, "Reserve and obligation share customer", "reserve or obligation row missing"));
  } else if (reserve.customerId === obligation.customerId) {
    checks.push(pass(8, "Reserve and obligation share customer", `customerId=${reserve.customerId}`));
  } else {
    checks.push(fail(8, "Reserve and obligation share customer",
      `reserve.customerId=${reserve.customerId} but obligation.customerId=${obligation.customerId}`));
  }

  // 9. Obligation.debtorPubKey == Customer.publicKey
  if (!obligation) {
    checks.push(skip(9, "Obligation.debtorPubKey matches Customer.publicKey", "obligation row missing"));
  } else if (!obligation.customer) {
    checks.push(fail(9, "Obligation.debtorPubKey matches Customer.publicKey", "obligation customer record missing"));
  } else if (obligation.debtorPubKey === obligation.customer.publicKey) {
    checks.push(pass(9, "Obligation.debtorPubKey matches Customer.publicKey", `${obligation.debtorPubKey.substring(0, 16)}...`));
  } else {
    checks.push(fail(9, "Obligation.debtorPubKey matches Customer.publicKey",
      `obligation.debtorPubKey=${obligation.debtorPubKey.substring(0, 16)}... but customer.publicKey=${obligation.customer.publicKey.substring(0, 16)}...`));
  }

  // 10. Obligation.creditorPubKey == Provider.publicKey
  if (!obligation) {
    checks.push(skip(10, "Obligation.creditorPubKey matches Provider.publicKey", "obligation row missing"));
  } else if (!obligation.provider) {
    checks.push(fail(10, "Obligation.creditorPubKey matches Provider.publicKey", "obligation provider record missing"));
  } else if (obligation.creditorPubKey === obligation.provider.publicKey) {
    checks.push(pass(10, "Obligation.creditorPubKey matches Provider.publicKey", `${obligation.creditorPubKey.substring(0, 16)}...`));
  } else {
    checks.push(fail(10, "Obligation.creditorPubKey matches Provider.publicKey",
      `obligation.creditorPubKey=${obligation.creditorPubKey.substring(0, 16)}... but provider.publicKey=${obligation.provider.publicKey.substring(0, 16)}...`));
  }

  // 11. No PendingRedemption with status="pending" for this obligation
  if (!obligation) {
    checks.push(skip(11, "No pending redemption in flight", "obligation row missing"));
  } else if (!pendingRedemption) {
    checks.push(pass(11, "No pending redemption in flight", "no pending redemption rows for this obligation"));
  } else {
    checks.push(fail(11, "No pending redemption in flight",
      `PendingRedemption ${pendingRedemption.id} (txId=${pendingRedemption.txId}) is in flight; wait for confirmation or call /api/reserves/recover-pending`));
  }

  // 12. Obligation has signature material
  if (!obligation) {
    checks.push(skip(12, "Obligation has signature material", "obligation row missing"));
  } else if (obligation.latestSignedMessage && obligation.latestSignature) {
    checks.push(pass(12, "Obligation has signature material",
      `latestSignature length=${obligation.latestSignature.length}`));
  } else {
    checks.push(fail(12, "Obligation has signature material",
      "obligation has no latestSignedMessage and/or latestSignature; redemption requires a signed obligation"));
  }

  // 13. TrackerEntry exists for (debtorPubKey, creditorPubKey) on the current TrackerBox
  if (!reserve || !obligation) {
    checks.push(skip(13, "TrackerEntry exists for pair", "reserve or obligation row missing"));
  } else if (!currentTrackerBox) {
    checks.push(fail(13, "TrackerEntry exists for pair",
      `no current TrackerBox for trackerNftId=${reserve.trackerNftId.substring(0, 16)}...`));
  } else if (trackerEntry) {
    checks.push(pass(13, "TrackerEntry exists for pair",
      `entry id=${trackerEntry.id}, totalDebtNanoErg=${trackerEntry.totalDebtNanoErg.toString()}`));
  } else {
    checks.push(fail(13, "TrackerEntry exists for pair",
      `current TrackerBox has no entry for (debtorPubKey=${obligation.debtorPubKey.substring(0, 16)}..., creditorPubKey=${obligation.creditorPubKey.substring(0, 16)}...); deploy/update the tracker for this pair before redeeming`));
  }

  // 14. TrackerEntry.totalDebtNanoErg matches priorSettlements + obligation.currentAmount.
  // UNIT-CROSSING: lhs is nanoErg (chain-native); rhs is computed from
  // priorRedeemedNanoErg (already nanoErg via nanoCreditsToNanoErg) +
  // obligation.currentAmount (nanoCredits) under the v1 identity.
  if (!obligation || !trackerEntry) {
    checks.push(skip(14, "TrackerEntry.totalDebtNanoErg aligned", "obligation or tracker entry missing"));
  } else {
    const expectedTotalDebtNanoErg = priorRedeemedNanoErg + nanoCreditsToNanoErg(obligation.currentAmount);
    // Verify v1 identity holds at runtime; if not, downgrade to WARN per plan.
    const probe = nanoCreditsToNanoErg(BigInt(123_456_789));
    if (probe !== BigInt(123_456_789)) {
      checks.push(warn(14, "TrackerEntry.totalDebtNanoErg aligned",
        "unit identity not provable for v1; verify NANOCREDITS_PER_CREDIT and nanoCreditsToNanoErg in src/lib/credits.ts"));
    } else if (trackerEntry.totalDebtNanoErg === expectedTotalDebtNanoErg) {
      checks.push(pass(14, "TrackerEntry.totalDebtNanoErg aligned",
        `tracker=${trackerEntry.totalDebtNanoErg.toString()} nanoErg, expected=${expectedTotalDebtNanoErg.toString()} nanoErg ` +
        `(prior ${priorSettlementsCount} settlement(s) = ${priorRedeemedNanoErg.toString()} + obligation ${nanoCreditsToNanoErg(obligation.currentAmount).toString()})`));
    } else {
      checks.push(fail(14, "TrackerEntry.totalDebtNanoErg aligned",
        `tracker=${trackerEntry.totalDebtNanoErg.toString()} nanoErg but expected=${expectedTotalDebtNanoErg.toString()} nanoErg ` +
        `(prior ${priorSettlementsCount} settlement(s) = ${priorRedeemedNanoErg.toString()} + obligation ${nanoCreditsToNanoErg(obligation.currentAmount).toString()}); redeploy tracker with current totals`));
    }
  }

  // 15. Contract-version compatibility: v1 reserves cannot redeem twice for the same pair
  if (!reserve || !obligation) {
    checks.push(skip(15, "Contract version permits this redemption", "reserve or obligation row missing"));
  } else if (reserve.contractVersion === "v2") {
    checks.push(pass(15, "Contract version permits this redemption", "v2 contract permits repeated same-pair redemptions"));
  } else if (priorSettlementsCount === 0) {
    checks.push(pass(15, "Contract version permits this redemption", "v1 contract; no prior settlements for this pair"));
  } else {
    checks.push(fail(15, "Contract version permits this redemption",
      `reserve.contractVersion=v1 (insert-only) but ${priorSettlementsCount} prior on-chain settlement(s) exist for this (debtor, creditor) pair; deploy a v2 reserve to redeem again for the same pair`));
  }

  // 16. Reserve collateral sufficient: sidecar valueNanoErg >= obligation.currentAmount (1:1 v1 identity)
  // UNIT-CROSSING: lhs nanoErg, rhs nanoCredits → nanoErg via identity.
  if (!sidecarReachable) {
    checks.push(skip(16, "Reserve collateral sufficient", "sidecar unreachable"));
  } else if (!sidecarReserve?.found || sidecarReserve.valueNanoErg == null) {
    checks.push(skip(16, "Reserve collateral sufficient", "sidecar reserve status not available"));
  } else if (!obligation) {
    checks.push(skip(16, "Reserve collateral sufficient", "obligation row missing"));
  } else {
    const probe = nanoCreditsToNanoErg(BigInt(123_456_789));
    if (probe !== BigInt(123_456_789)) {
      checks.push(warn(16, "Reserve collateral sufficient",
        "unit identity not provable for v1; cannot compare reserve nanoErg to obligation nanoCredits"));
    } else {
      const obligationNanoErg = nanoCreditsToNanoErg(obligation.currentAmount);
      const reserveValueNanoErg = BigInt(sidecarReserve.valueNanoErg);
      if (reserveValueNanoErg >= obligationNanoErg) {
        checks.push(pass(16, "Reserve collateral sufficient",
          `reserve=${reserveValueNanoErg.toString()} nanoErg, needed=${obligationNanoErg.toString()} nanoErg`));
      } else {
        checks.push(fail(16, "Reserve collateral sufficient",
          `reserve=${reserveValueNanoErg.toString()} nanoErg but needs=${obligationNanoErg.toString()} nanoErg; top up the reserve before redeeming`));
      }
    }
  }

  // 17. Owner secret file present (filesystem stat — read-only)
  if (!reserve) {
    checks.push(skip(17, "Owner secret file present", "reserve row missing"));
  } else {
    const ownerFile = path.join(SECRETS_DIR, `owner-${reserve.debtorPubKey.substring(0, 8)}.json`);
    try {
      fs.statSync(ownerFile);
      checks.push(pass(17, "Owner secret file present", `${ownerFile}`));
    } catch {
      checks.push(fail(17, "Owner secret file present",
        `missing ${ownerFile}; will be auto-provisioned on first redeem if Customer.privateKey is set`));
    }
  }

  // 18. Receiver secret file present (filesystem stat — read-only)
  if (!obligation) {
    checks.push(skip(18, "Receiver secret file present", "obligation row missing"));
  } else {
    const receiverFile = path.join(SECRETS_DIR, `receiver-${obligation.creditorPubKey.substring(0, 8)}.json`);
    try {
      fs.statSync(receiverFile);
      checks.push(pass(18, "Receiver secret file present", `${receiverFile}`));
    } catch {
      checks.push(fail(18, "Receiver secret file present",
        `missing ${receiverFile}; will be auto-provisioned on first redeem if Provider.privateKey is set`));
    }
  }

  // 19. Reserve.avlTreeDigest matches sidecar avlTreeDigest (R5 digest drift detection)
  if (!sidecarReachable) {
    checks.push(skip(19, "Reserve.avlTreeDigest matches sidecar", "sidecar unreachable"));
  } else if (!sidecarReserve?.found) {
    checks.push(skip(19, "Reserve.avlTreeDigest matches sidecar", "sidecar reserve status not available"));
  } else if (!reserve) {
    checks.push(skip(19, "Reserve.avlTreeDigest matches sidecar", "reserve row missing"));
  } else if (!reserve.avlTreeDigest && !sidecarReserve.avlTreeDigest) {
    checks.push(pass(19, "Reserve.avlTreeDigest matches sidecar", "both null (no prior redemptions)"));
  } else if (reserve.avlTreeDigest && sidecarReserve.avlTreeDigest && reserve.avlTreeDigest === sidecarReserve.avlTreeDigest) {
    checks.push(pass(19, "Reserve.avlTreeDigest matches sidecar", `digest=${reserve.avlTreeDigest.substring(0, 16)}...`));
  } else {
    checks.push(fail(19, "Reserve.avlTreeDigest matches sidecar",
      `db=${reserve.avlTreeDigest ?? "null"} but chain=${sidecarReserve.avlTreeDigest ?? "null"}; redeem route would refuse with 'Reserve R5 digest drift detected'`));
  }

  // ── Aggregate result ──────────────────────────────────────────────────

  const checksTotal = checks.length;
  const checksPassed = checks.filter((c) => c.status === "pass").length;
  const checksFailed = checks.filter((c) => c.status === "fail").length;
  const checksSkipped = checks.filter((c) => c.status === "skip").length;
  const checksWarn = checks.filter((c) => c.status === "warn").length;
  const blockingReasons = checks
    .filter((c) => c.status === "fail" || c.status === "warn")
    .map((c) => `[#${c.id}] ${c.label}: ${c.detail}`);

  // PASS only if zero fails AND zero warns. Skips are treated as inconclusive,
  // so they do NOT pass the audit either — except the all-skipped case where
  // the sidecar is down: in that case checksFailed will already be ≥ 1
  // because check #1 itself failed.
  const result: "PASS" | "FAIL" =
    checksFailed === 0 && checksWarn === 0 && checksSkipped === 0 ? "PASS" : "FAIL";

  const nextStep =
    result === "PASS"
      ? "Audit PASS. Obligation can settle against this reserve. Run slice 13b receipt-to-reserve demo when available."
      : `Audit FAIL. Resolve blocker(s): ${blockingReasons.map((r) => r.split(":")[0]).join(", ")}. Re-run audit.`;

  // ── Build report ──────────────────────────────────────────────────────

  const amountReadyToSettle = obligation && obligation.currentAmount > BigInt(0)
    ? obligation.currentAmount.toString()
    : "0";

  const report = {
    unitInvariant: {
      version: "v1" as const,
      note: "1 nanoCredit == 1 nanoErg (identity mapping); audit unit-compatible iff this holds.",
    },
    summary: {
      result,
      checksTotal,
      checksPassed,
      checksFailed,
      checksSkipped,
      checksWarn,
    },
    inputs: {
      reserveId: args.reserveId,
      obligationStateId: resolvedObligationStateId,
      latestRepoLint: args.latestRepoLint,
    },
    reserve: reserve
      ? {
          id: reserve.id,
          customerId: reserve.customerId,
          debtorPubKey: reserve.debtorPubKey,
          reserveTokenId: reserve.reserveTokenId,
          trackerNftId: reserve.trackerNftId,
          boxId: reserve.boxId,
          valueNanoErg: reserve.valueNanoErg.toString(),
          avlTreeDigest: reserve.avlTreeDigest,
          contractVersion: reserve.contractVersion,
          lifecycle: reserve.lifecycle,
          customerPublicKey: reserve.customer?.publicKey ?? null,
        }
      : null,
    obligation: obligation
      ? {
          id: obligation.id,
          providerId: obligation.providerId,
          customerId: obligation.customerId,
          currentAmount: obligation.currentAmount.toString(),
          currentAmountFormatted: formatCredits(obligation.currentAmount),
          pendingAmount: obligation.pendingAmount.toString(),
          version: obligation.version,
          debtorPubKey: obligation.debtorPubKey,
          creditorPubKey: obligation.creditorPubKey,
          settlementStatus: obligation.settlementStatus,
          latestSignaturePresent: !!obligation.latestSignedMessage && !!obligation.latestSignature,
          customerPublicKey: obligation.customer?.publicKey ?? null,
          providerPublicKey: obligation.provider?.publicKey ?? null,
        }
      : null,
    keyAlignment: {
      reserveDebtorMatchesCustomer:
        !!reserve && !!reserve.customer && reserve.debtorPubKey === reserve.customer.publicKey,
      obligationDebtorMatchesCustomer:
        !!obligation && !!obligation.customer && obligation.debtorPubKey === obligation.customer.publicKey,
      obligationCreditorMatchesProvider:
        !!obligation && !!obligation.provider && obligation.creditorPubKey === obligation.provider.publicKey,
      sameCustomer:
        !!reserve && !!obligation && reserve.customerId === obligation.customerId,
    },
    amountReadyToSettle,
    sidecarHealth: sidecarHealth
      ? {
          reachable: true,
          status: sidecarHealth.status,
          network: sidecarHealth.network,
          sidecarVersion: sidecarHealth.sidecarVersion,
        }
      : { reachable: false, status: null, network: null, sidecarVersion: null },
    sidecarReserveStatus: sidecarReserve,
    trackerReadiness: currentTrackerBox
      ? {
          currentBoxId: currentTrackerBox.boxId,
          currentDbId: currentTrackerBox.id,
          treeDigestHex: currentTrackerBox.treeDigestHex,
          entryFound: !!trackerEntry,
          entryTotalDebtNanoErg: trackerEntry?.totalDebtNanoErg.toString() ?? null,
          expectedTotalDebtNanoErg: obligation
            ? (priorRedeemedNanoErg + nanoCreditsToNanoErg(obligation.currentAmount)).toString()
            : null,
          aligned: !!trackerEntry && !!obligation &&
            trackerEntry.totalDebtNanoErg ===
              priorRedeemedNanoErg + nanoCreditsToNanoErg(obligation.currentAmount),
        }
      : null,
    pendingRedemption: pendingRedemption
      ? { hasInFlight: true, txId: pendingRedemption.txId }
      : { hasInFlight: false, txId: null },
    priorSettlements: {
      countForPair: priorSettlementsCount,
      totalRedeemedNanoErg: priorRedeemedNanoErg.toString(),
    },
    checks,
    blockingReasons,
    nextStep,
  };

  // ── Emit ──────────────────────────────────────────────────────────────

  // JSON to stdout (always)
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  // Human summary to stderr (unless --json)
  if (!args.json) {
    const lines: string[] = [];
    lines.push("");
    lines.push("Settlement readiness check");
    lines.push("");
    if (reserve) {
      lines.push(
        `  Reserve:    ${reserve.id.substring(0, 8)}  ` +
        `(${reserve.customer?.name ?? "?"}, ${reserve.contractVersion}, ` +
        `${reserve.boxId ? "deployed" : "no boxId"}, lifecycle=${reserve.lifecycle})`,
      );
    } else {
      lines.push(`  Reserve:    NOT FOUND (${args.reserveId})`);
    }
    if (obligation) {
      lines.push(
        `  Obligation: ${obligation.id.substring(0, 8)}  ` +
        `(${obligation.customer?.name ?? "?"} → ${obligation.provider?.name ?? "?"}, ` +
        `${formatCredits(obligation.currentAmount)} credits, ` +
        `${obligation.latestSignature ? "signed" : "unsigned"})`,
      );
    } else {
      lines.push(`  Obligation: NOT FOUND (${resolvedObligationStateId})`);
    }
    lines.push(
      `  Sidecar:    ${sidecarHealth ? `ok (${sidecarHealth.network}, ${sidecarHealth.sidecarVersion})` : "unreachable"}`,
    );
    if (currentTrackerBox && trackerEntry) {
      const aligned = trackerEntry.totalDebtNanoErg ===
        (obligation ? priorRedeemedNanoErg + nanoCreditsToNanoErg(obligation.currentAmount) : BigInt(-1));
      lines.push(
        `  Tracker:    ${aligned ? "aligned" : "MISALIGNED"} ` +
        `(totalDebt=${trackerEntry.totalDebtNanoErg.toString()} nanoErg)`,
      );
    } else if (currentTrackerBox) {
      lines.push(`  Tracker:    no entry for this pair on current box`);
    } else {
      lines.push(`  Tracker:    no current TrackerBox`);
    }
    lines.push("");
    lines.push(
      `  Result: ${result} — ${checksPassed}/${checksTotal} checks passed` +
      (checksFailed ? `, ${checksFailed} failed` : "") +
      (checksWarn ? `, ${checksWarn} warn` : "") +
      (checksSkipped ? `, ${checksSkipped} skipped` : ""),
    );
    if (blockingReasons.length > 0) {
      lines.push("");
      lines.push("  Blockers:");
      for (const r of blockingReasons) {
        lines.push(`    - ${r}`);
      }
    }
    lines.push("");
    lines.push(`  Next step: ${nextStep}`);
    lines.push("");
    process.stderr.write(lines.join("\n"));
  }

  await prisma.$disconnect();
  process.exit(result === "PASS" ? 0 : 1);
}

main().catch(async (e) => {
  process.stderr.write(`check-settlement-readiness error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
