#!/usr/bin/env tsx
/**
 * backfill-settlement-event-reserve-id (slice 13d)
 *
 * Populates SettlementEvent.reserveId for existing on-chain redemption rows
 * after migration 20260508161224_add_reserve_id_to_settlement_event added
 * the column as nullable.
 *
 * Only operates on rows where:
 *   - method = "on-chain-redemption"
 *   - status = "completed"
 *   - reserveId IS NULL
 *   - redemptionTxId IS NOT NULL
 *
 * Manual settlements (method="manual") keep reserveId=NULL (not eligible).
 *
 * Candidate Reserve must satisfy ALL six criteria:
 *   C1 same customer:        Reserve.customerId == ObligationState.customerId
 *   C2 on-chain identity:    Reserve.boxId IS NOT NULL
 *   C3 creation height:      Reserve.creationHeight IS NOT NULL
 *   C4 lifecycle on-chain:   Reserve.lifecycle IN ("active", "depleted")
 *   C5 row predates settle:  Reserve.createdAt <= SettlementEvent.timestamp
 *   C6 real reserveTokenId:  /^[a-f0-9]{64}$/ AND not a placeholder pattern
 *
 * Selection requires exactly 1 candidate matching all six. If 0 or >1 match,
 * the script refuses to update the row and exits 1.
 *
 * Usage:
 *   tsx scripts/backfill-settlement-event-reserve-id.ts --dry-run    (default)
 *   tsx scripts/backfill-settlement-event-reserve-id.ts --execute
 *   tsx scripts/backfill-settlement-event-reserve-id.ts --help
 */

import { prisma } from "@/lib/prisma";

interface Args {
  phase: "dry-run" | "execute" | "help";
  allowFixtureStub: boolean;
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^aaaa1111/i,
  /^bbbb2222/i,
  /^cccc3333/i,
  /^dddd4444/i,
  /^v1-stub/i,
];
const HEX64 = /^[a-f0-9]{64}$/;

// Narrow exception: the v1-stub fixture predates the on-chain reserve model.
// Its SettlementEvent has method="on-chain-redemption" and a redemptionTxId,
// but the corresponding Reserve row carries placeholder data
// (creationHeight=null, reserveTokenId="v1-stub-token-fo..."). Real on-chain
// criteria reject it. With --allow-fixture-stub, the script bypasses C3 and
// C6 ONLY for this exact (customerId, reserveId) pair, and ONLY when there
// is exactly one settlement-needing-backfill under that customer.
//
// This is a TEST-FIXTURE EXCEPTION. Do NOT apply this pattern to production
// reserves. Do NOT extend the whitelist without explicit approval.
const FIXTURE_STUB_CUSTOMER_ID = "c29eadb1-0000-0000-0000-000000000001";
const FIXTURE_STUB_RESERVE_ID = "bf486d82-77ae-40ab-85b8-f201989c9fee";
const FIXTURE_STUB_TOKEN_ID_PATTERN = /^v1-stub/i;

function parseArgs(argv: string[]): Args {
  const a: Args = { phase: "dry-run", allowFixtureStub: false };
  let phasesSeen = 0;
  for (const flag of argv) {
    if (flag === "--dry-run") { a.phase = "dry-run"; phasesSeen++; }
    else if (flag === "--execute") { a.phase = "execute"; phasesSeen++; }
    else if (flag === "--allow-fixture-stub") { a.allowFixtureStub = true; }
    else if (flag === "--help" || flag === "-h") { a.phase = "help"; }
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (phasesSeen > 1) throw new Error("--dry-run and --execute are mutually exclusive");
  return a;
}

function printHelp(): void {
  process.stderr.write(
    `backfill-settlement-event-reserve-id (slice 13d)\n\n` +
    `Populates SettlementEvent.reserveId for on-chain rows after migration.\n\n` +
    `Usage:\n` +
    `  --dry-run                 Print what would change. No writes. Default.\n` +
    `  --execute                 Apply backfill. Refuses on any ambiguity.\n` +
    `  --allow-fixture-stub      Whitelist the v1-stub TEST FIXTURE (customer\n` +
    `                            ${FIXTURE_STUB_CUSTOMER_ID.slice(0, 8)}..., reserve ${FIXTURE_STUB_RESERVE_ID.slice(0, 8)}...)\n` +
    `                            so its single legacy on-chain SettlementEvent\n` +
    `                            backfills despite C3+C6 failing. Test-fixture\n` +
    `                            exception only — NOT a production rule.\n` +
    `  --help, -h                Show this help.\n\n` +
    `Exit codes: 0 PASS, 1 ambiguous/no candidate found.\n`,
  );
}

interface Criterion {
  pass: boolean;
  value: string;
}

interface CandidateReport {
  reserveId: string;
  reserveTokenIdShort: string;
  criteria: Record<string, Criterion>;
  selected: boolean;
  rejectedFor: string[];
}

interface RowReport {
  settlementEventId: string;
  redemptionTxIdShort: string | null;
  settlementTimestamp: string;
  obligationStateId: string;
  obligationCustomerId: string;
  candidates: CandidateReport[];
  selectedCount: number;
  willAssign: string | null;
  status: "ready" | "ambiguous" | "no-candidate";
}

function isPlaceholder(reserveTokenId: string): boolean {
  if (!HEX64.test(reserveTokenId)) return true;
  for (const p of PLACEHOLDER_PATTERNS) if (p.test(reserveTokenId)) return true;
  return false;
}

interface ReserveRow {
  id: string;
  customerId: string;
  reserveTokenId: string;
  boxId: string | null;
  creationHeight: number | null;
  lifecycle: string;
  createdAt: Date;
}

interface SettlementRow {
  id: string;
  obligationStateId: string;
  reserveId: string | null;
  redemptionTxId: string | null;
  timestamp: Date;
}

function isFixtureStubPair(reserve: ReserveRow, obligationCustomerId: string): boolean {
  return (
    obligationCustomerId === FIXTURE_STUB_CUSTOMER_ID &&
    reserve.id === FIXTURE_STUB_RESERVE_ID &&
    FIXTURE_STUB_TOKEN_ID_PATTERN.test(reserve.reserveTokenId)
  );
}

function evaluateCandidate(
  reserve: ReserveRow,
  obligationCustomerId: string,
  settlementTimestamp: Date,
  allowFixtureStub: boolean,
): CandidateReport & { fixtureStubExceptionApplied: boolean } {
  const criteria: Record<string, Criterion> = {};
  const fixtureStubMatch = isFixtureStubPair(reserve, obligationCustomerId);
  const fixtureStubExceptionApplied = allowFixtureStub && fixtureStubMatch;

  criteria.C1_sameCustomer = {
    pass: reserve.customerId === obligationCustomerId,
    value: `${reserve.customerId.slice(0, 8)}=${obligationCustomerId.slice(0, 8)}`,
  };

  criteria.C2_boxIdNonNull = {
    pass: reserve.boxId !== null,
    value: reserve.boxId ? `${reserve.boxId.slice(0, 16)}...` : "null",
  };

  if (fixtureStubExceptionApplied) {
    criteria.C3_creationHeight = {
      pass: true,
      value: `${reserve.creationHeight !== null ? String(reserve.creationHeight) : "null"} (BYPASSED — fixture-stub exception)`,
    };
  } else {
    criteria.C3_creationHeight = {
      pass: reserve.creationHeight !== null,
      value: reserve.creationHeight !== null ? String(reserve.creationHeight) : "null",
    };
  }

  criteria.C4_lifecycle = {
    pass: reserve.lifecycle === "active" || reserve.lifecycle === "depleted",
    value: reserve.lifecycle,
  };

  criteria.C5_createdBefore = {
    pass: reserve.createdAt <= settlementTimestamp,
    value: `${reserve.createdAt.toISOString()} ${reserve.createdAt <= settlementTimestamp ? "<=" : ">"} ${settlementTimestamp.toISOString()}`,
  };

  const placeholder = isPlaceholder(reserve.reserveTokenId);
  if (fixtureStubExceptionApplied) {
    criteria.C6_realTokenId = {
      pass: true,
      value: `${reserve.reserveTokenId.slice(0, 16)}... (BYPASSED — fixture-stub exception)`,
    };
  } else {
    criteria.C6_realTokenId = {
      pass: !placeholder,
      value: placeholder
        ? `${reserve.reserveTokenId.slice(0, 16)}... (placeholder pattern)`
        : `${reserve.reserveTokenId.slice(0, 16)}...`,
    };
  }

  const rejectedFor: string[] = [];
  for (const [name, c] of Object.entries(criteria)) {
    if (!c.pass) rejectedFor.push(name.split("_")[0]);
  }

  return {
    reserveId: reserve.id,
    reserveTokenIdShort: `${reserve.reserveTokenId.slice(0, 16)}...`,
    criteria,
    selected: rejectedFor.length === 0,
    rejectedFor,
    fixtureStubExceptionApplied,
  };
}

async function evaluateRow(
  s: SettlementRow,
  allowFixtureStub: boolean,
  customerEligibleCount: Map<string, number>,
): Promise<RowReport & { fixtureStubExceptionApplied: boolean }> {
  const obligation = await prisma.obligationState.findUnique({ where: { id: s.obligationStateId } });
  if (!obligation) {
    return {
      settlementEventId: s.id,
      redemptionTxIdShort: s.redemptionTxId ? `${s.redemptionTxId.slice(0, 12)}...` : null,
      settlementTimestamp: s.timestamp.toISOString(),
      obligationStateId: s.obligationStateId,
      obligationCustomerId: "<missing>",
      candidates: [],
      selectedCount: 0,
      willAssign: null,
      status: "no-candidate",
      fixtureStubExceptionApplied: false,
    };
  }

  // The fixture-stub exception applies ONLY when the customer has exactly one
  // settlement-needing-backfill. If somehow there are more, we refuse the
  // exception (this should never happen in practice but is a defensive guard).
  const isStubCustomer = obligation.customerId === FIXTURE_STUB_CUSTOMER_ID;
  const customerEligible = customerEligibleCount.get(obligation.customerId) ?? 0;
  const allowExceptionForThisRow = allowFixtureStub && isStubCustomer && customerEligible === 1;

  const reserves = await prisma.reserve.findMany({ where: { customerId: obligation.customerId } });
  const candidateReports = reserves.map((r) =>
    evaluateCandidate(r as ReserveRow, obligation.customerId, s.timestamp, allowExceptionForThisRow),
  );
  const selectedCandidates = candidateReports.filter((c) => c.selected);
  const selectedCount = selectedCandidates.length;
  const willAssign = selectedCount === 1 ? selectedCandidates[0].reserveId : null;
  const status: RowReport["status"] = selectedCount === 1 ? "ready" : selectedCount > 1 ? "ambiguous" : "no-candidate";
  const fixtureStubExceptionApplied = candidateReports.some((c) => c.fixtureStubExceptionApplied && c.selected);

  return {
    settlementEventId: s.id,
    redemptionTxIdShort: s.redemptionTxId ? `${s.redemptionTxId.slice(0, 12)}...` : null,
    settlementTimestamp: s.timestamp.toISOString(),
    obligationStateId: s.obligationStateId,
    obligationCustomerId: obligation.customerId,
    candidates: candidateReports,
    selectedCount,
    willAssign,
    status,
    fixtureStubExceptionApplied,
  };
}

async function loadEligibleSettlements(): Promise<SettlementRow[]> {
  return prisma.settlementEvent.findMany({
    where: {
      method: "on-chain-redemption",
      status: "completed",
      reserveId: null,
      redemptionTxId: { not: null },
    },
    select: {
      id: true,
      obligationStateId: true,
      reserveId: true,
      redemptionTxId: true,
      timestamp: true,
    },
    orderBy: { timestamp: "asc" },
  });
}

async function buildCustomerEligibleCount(rows: SettlementRow[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const obl = await prisma.obligationState.findUnique({
      where: { id: r.obligationStateId },
      select: { customerId: true },
    });
    if (!obl) continue;
    map.set(obl.customerId, (map.get(obl.customerId) ?? 0) + 1);
  }
  return map;
}

function emitFixtureStubBanner(): void {
  process.stderr.write(
    `[backfill] --allow-fixture-stub is ENABLED.\n` +
    `[backfill]   This is a TEST-FIXTURE EXCEPTION, not a production rule.\n` +
    `[backfill]   Whitelist applies ONLY to:\n` +
    `[backfill]     customerId = ${FIXTURE_STUB_CUSTOMER_ID}\n` +
    `[backfill]     reserveId  = ${FIXTURE_STUB_RESERVE_ID}\n` +
    `[backfill]     reserveTokenId pattern = /^v1-stub/i\n` +
    `[backfill]     condition  = exactly 1 settlement-needing-backfill for this customer\n` +
    `[backfill]   With the whitelist matched, criteria C3 + C6 are bypassed for this pair.\n` +
    `[backfill]   No production reserve is affected by this flag.\n`,
  );
}

async function cmdDryRun(allowFixtureStub: boolean): Promise<number> {
  process.stderr.write(`[backfill-dry-run] loading eligible SettlementEvent rows\n`);
  if (allowFixtureStub) emitFixtureStubBanner();
  const rows = await loadEligibleSettlements();
  process.stderr.write(`[backfill-dry-run] ${rows.length} eligible row(s)\n`);

  const customerEligible = await buildCustomerEligibleCount(rows);
  const reports: Array<RowReport & { fixtureStubExceptionApplied: boolean }> = [];
  for (const r of rows) reports.push(await evaluateRow(r, allowFixtureStub, customerEligible));

  const ready = reports.filter((r) => r.status === "ready").length;
  const ambiguous = reports.filter((r) => r.status === "ambiguous").length;
  const noCandidate = reports.filter((r) => r.status === "no-candidate").length;
  const fixtureStubApplied = reports.filter((r) => r.fixtureStubExceptionApplied).length;

  const out = {
    phase: "dry-run",
    allowFixtureStub,
    summary: { total: rows.length, ready, ambiguous, noCandidate, fixtureStubApplied },
    rows: reports,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");

  process.stderr.write(`[backfill-dry-run] ${ready}/${rows.length} ready, ${ambiguous} ambiguous, ${noCandidate} no-candidate, ${fixtureStubApplied} via fixture-stub exception\n`);
  if (ambiguous > 0 || noCandidate > 0) {
    process.stderr.write(`[backfill-dry-run] BLOCKED — manual review needed before --execute can run\n`);
    return 1;
  }
  if (rows.length === 0) {
    process.stderr.write(`[backfill-dry-run] 0 rows need updating\n`);
    return 0;
  }
  process.stderr.write(`[backfill-dry-run] All rows have exactly one candidate. Run --execute to apply.\n`);
  return 0;
}

async function cmdExecute(allowFixtureStub: boolean): Promise<number> {
  process.stderr.write(`[backfill-execute] re-evaluating rows under transaction\n`);
  if (allowFixtureStub) emitFixtureStubBanner();
  const rows = await loadEligibleSettlements();
  process.stderr.write(`[backfill-execute] ${rows.length} eligible row(s)\n`);

  if (rows.length === 0) {
    process.stdout.write(JSON.stringify({ phase: "execute", summary: { total: 0, updated: 0 }, rows: [] }, null, 2) + "\n");
    process.stderr.write(`[backfill-execute] 0 rows. Nothing to do.\n`);
    return 0;
  }

  const customerEligible = await buildCustomerEligibleCount(rows);
  const reports: Array<RowReport & { fixtureStubExceptionApplied: boolean }> = [];
  for (const r of rows) reports.push(await evaluateRow(r, allowFixtureStub, customerEligible));

  const ambiguous = reports.filter((r) => r.status === "ambiguous").length;
  const noCandidate = reports.filter((r) => r.status === "no-candidate").length;
  if (ambiguous > 0 || noCandidate > 0) {
    process.stdout.write(JSON.stringify({ phase: "execute-aborted", allowFixtureStub, summary: { total: rows.length, ambiguous, noCandidate }, rows: reports }, null, 2) + "\n");
    process.stderr.write(`[backfill-execute] REFUSING — ambiguous or no-candidate rows present. Re-run --dry-run for details.\n`);
    return 1;
  }

  await prisma.$transaction(
    reports.map((r) =>
      prisma.settlementEvent.update({
        where: { id: r.settlementEventId },
        data: { reserveId: r.willAssign! },
      }),
    ),
  );

  process.stdout.write(
    JSON.stringify(
      {
        phase: "execute",
        allowFixtureStub,
        summary: {
          total: rows.length,
          updated: reports.length,
          fixtureStubApplied: reports.filter((r) => r.fixtureStubExceptionApplied).length,
        },
        rows: reports.map((r) => ({
          settlementEventId: r.settlementEventId,
          redemptionTxIdShort: r.redemptionTxIdShort,
          assignedReserveId: r.willAssign,
          fixtureStubExceptionApplied: r.fixtureStubExceptionApplied,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  process.stderr.write(`[backfill-execute] PASS — updated ${reports.length} row(s)\n`);
  return 0;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n\n`);
    printHelp();
    process.exit(2);
  }

  if (args.phase === "help") {
    printHelp();
    process.exit(0);
  }

  let code: number;
  if (args.phase === "execute") code = await cmdExecute(args.allowFixtureStub);
  else code = await cmdDryRun(args.allowFixtureStub);

  process.exit(code);
}

main()
  .catch((e) => {
    process.stderr.write(`backfill failed: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof Error && e.stack) process.stderr.write(e.stack + "\n");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
