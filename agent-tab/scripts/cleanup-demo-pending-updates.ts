#!/usr/bin/env tsx
/**
 * cleanup-demo-pending-updates
 *
 * One-shot operator tool to retire stale `pending` ObligationUpdate rows
 * that the tracker would refuse to commit (age > PENDING_TTL_MS).
 *
 * Mirrors `tracker.expirePendingUpdate` semantics exactly:
 *   - flips `signatureStatus: "pending" -> "rejected"` (no rows deleted)
 *   - decrements `obligationState.pendingAmount` by `update.delta`
 *
 * Usage:
 *   tsx scripts/cleanup-demo-pending-updates.ts                    # dry-run, all customers
 *   tsx scripts/cleanup-demo-pending-updates.ts --customer <id>    # dry-run, scoped
 *   tsx scripts/cleanup-demo-pending-updates.ts --apply --customer <id>
 *   tsx scripts/cleanup-demo-pending-updates.ts --apply --all
 *   tsx scripts/cleanup-demo-pending-updates.ts --max-age-ms 60000 # override cutoff
 *   tsx scripts/cleanup-demo-pending-updates.ts --reconcile        # also reconcile pendingAmount drift
 *   tsx scripts/cleanup-demo-pending-updates.ts --help
 *
 * Safety:
 *   --apply REQUIRES either --customer <id> OR --all (else exits non-zero).
 *   Defaults to dry-run; never deletes; idempotent on re-run.
 *
 *   --reconcile (in --apply mode) sets ObligationState.pendingAmount =
 *   Σ(delta) of remaining "pending" ObligationUpdate rows for that obligation,
 *   restoring the tracker invariant when prior data hygiene drifted it.
 *   Touches ONLY ObligationState.pendingAmount. Never currentAmount, signed
 *   history, settlement, reserve, or any other table.
 */

import { prisma } from "@/lib/prisma";
import { PENDING_TTL_MS } from "@/lib/tracker/service";

interface Args {
  apply: boolean;
  all: boolean;
  customer: string | null;
  maxAgeMs: number;
  reconcile: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    all: false,
    customer: null,
    maxAgeMs: PENDING_TTL_MS,
    reconcile: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--all") args.all = true;
    else if (a === "--reconcile") args.reconcile = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--customer") {
      const v = argv[++i];
      if (!v) throw new Error("--customer requires a value");
      args.customer = v;
    } else if (a === "--max-age-ms") {
      const v = argv[++i];
      if (!v) throw new Error("--max-age-ms requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error("--max-age-ms must be a non-negative number");
      args.maxAgeMs = n;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`cleanup-demo-pending-updates\n
Retires stale 'pending' ObligationUpdate rows by flipping them to 'rejected'
and reclaiming the corresponding pendingAmount on the parent obligation.

Flags:
  (no flags)              Dry-run, scope=all customers. Prints rows that would be
                          mutated, then exits without touching the DB.
  --customer <id>         Limit scope to one customerId.
  --apply                 Mutating mode. REQUIRES --customer <id> OR --all.
  --all                   With --apply: explicit acknowledgement that the
                          mutation should hit every customer.
  --max-age-ms <ms>       Override the staleness cutoff. Default = PENDING_TTL_MS
                          (${PENDING_TTL_MS} ms).
  --reconcile             Also reconcile ObligationState.pendingAmount drift.
                          Sets pendingAmount = Σ(delta of remaining pending rows)
                          per obligation in scope. Idempotent. Touches ONLY
                          ObligationState.pendingAmount.
  --help, -h              Show this help.

Examples:
  tsx scripts/cleanup-demo-pending-updates.ts
  tsx scripts/cleanup-demo-pending-updates.ts --customer auth-demo-bolt-labs-001
  tsx scripts/cleanup-demo-pending-updates.ts --apply --customer auth-demo-bolt-labs-001
  tsx scripts/cleanup-demo-pending-updates.ts --apply --customer auth-demo-bolt-labs-001 --reconcile
  tsx scripts/cleanup-demo-pending-updates.ts --apply --all
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.apply && !args.all && !args.customer) {
    process.stderr.write(
      "ERROR: --apply requires either --customer <id> or --all to be set explicitly.\n" +
        "       This guard prevents accidental broad mutation outside demo scope.\n",
    );
    process.exitCode = 2;
    return;
  }

  const cutoff = new Date(Date.now() - args.maxAgeMs);
  const customerScope = args.customer
    ? { obligationState: { is: { customerId: args.customer } } }
    : {};
  const obligationCustomerScope = args.customer
    ? { customerId: args.customer }
    : {};

  const rows = await prisma.obligationUpdate.findMany({
    where: {
      signatureStatus: "pending",
      timestamp: { lt: cutoff },
      ...customerScope,
    },
    select: {
      id: true,
      obligationStateId: true,
      delta: true,
      timestamp: true,
      type: true,
      agentIdentityId: true,
      delegationId: true,
      obligationState: {
        select: { customerId: true, providerId: true, pendingAmount: true },
      },
    },
    orderBy: { timestamp: "asc" },
  });

  const mode = args.apply ? "APPLY" : "DRY-RUN";
  const scopeLabel = args.customer ? `customer=${args.customer}` : args.all ? "all" : "all (dry-run)";
  process.stdout.write(`[${mode}] cutoff=${cutoff.toISOString()} scope=${scopeLabel}\n`);
  process.stdout.write(`[${mode}] matched ${rows.length} stale pending row(s)\n\n`);

  if (rows.length > 0) {
    // Per-row table
    process.stdout.write(
      "updateId                              | obligationStateId                     | customerId                            | providerId                            | ageMin | type       | delta            | agentId                               | delegationId\n",
    );
    process.stdout.write(
      "-------------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------- | ------ | ---------- | ---------------- | ------------------------------------- | ----\n",
    );
    for (const r of rows) {
      const ageMin = Math.floor((Date.now() - r.timestamp.getTime()) / 60000);
      process.stdout.write(
        `${r.id.padEnd(36)} | ${r.obligationStateId.padEnd(37)} | ${(r.obligationState.customerId ?? "").padEnd(37)} | ${(r.obligationState.providerId ?? "").padEnd(37)} | ${String(ageMin).padStart(6)} | ${r.type.padEnd(10)} | ${r.delta.toString().padStart(16)} | ${(r.agentIdentityId ?? "(null)").padEnd(37)} | ${r.delegationId ?? "(null)"}\n`,
      );
    }

    // Per-obligation totals
    const byObligation = new Map<string, { count: number; deltaSum: bigint; pendingAmountBefore: bigint }>();
    for (const r of rows) {
      const cur = byObligation.get(r.obligationStateId);
      if (cur) {
        cur.count += 1;
        cur.deltaSum += r.delta;
      } else {
        byObligation.set(r.obligationStateId, {
          count: 1,
          deltaSum: r.delta,
          pendingAmountBefore: r.obligationState.pendingAmount,
        });
      }
    }
    process.stdout.write("\nPer-obligation totals (delta to reclaim):\n");
    for (const [obligationId, agg] of byObligation) {
      process.stdout.write(
        `  ${obligationId}: ${agg.count} row(s), Σdelta=${agg.deltaSum.toString()} nanoCredits, pendingAmount before=${agg.pendingAmountBefore.toString()}\n`,
      );
    }

    if (args.apply) {
      // Apply: per-row $transaction mirroring tracker.expirePendingUpdate
      process.stdout.write("\nApplying expiry transactions...\n");
      let applied = 0;
      for (const r of rows) {
        await prisma.$transaction([
          prisma.obligationUpdate.update({
            where: { id: r.id },
            data: { signatureStatus: "rejected" },
          }),
          prisma.obligationState.update({
            where: { id: r.obligationStateId },
            data: { pendingAmount: { decrement: r.delta } },
          }),
        ]);
        applied += 1;
      }
      process.stdout.write(`Applied ${applied} of ${rows.length}.\n`);

      // Post-apply per-obligation pendingAmount snapshot
      process.stdout.write("\nPer-obligation pendingAmount after:\n");
      for (const obligationId of byObligation.keys()) {
        const o = await prisma.obligationState.findUnique({
          where: { id: obligationId },
          select: { pendingAmount: true },
        });
        process.stdout.write(`  ${obligationId}: pendingAmount after=${o?.pendingAmount.toString() ?? "(missing)"}\n`);
      }
    }
  } else {
    process.stdout.write(args.apply ? "0 stale rows to expire.\n" : "0 stale rows to retire.\n");
  }

  // Reconciliation pass (optional, gated on --reconcile)
  if (args.reconcile) {
    process.stdout.write(`\n[${mode}] reconciliation pass: pendingAmount drift\n`);
    const obligations = await prisma.obligationState.findMany({
      where: obligationCustomerScope,
      select: { id: true, customerId: true, providerId: true, pendingAmount: true },
    });
    const drifts: { id: string; customerId: string; providerId: string; current: bigint; target: bigint; drift: bigint }[] = [];
    for (const o of obligations) {
      const pendingRows = await prisma.obligationUpdate.findMany({
        where: { obligationStateId: o.id, signatureStatus: "pending" },
        select: { delta: true },
      });
      const target = pendingRows.reduce((s, r) => s + r.delta, BigInt(0));
      if (target !== o.pendingAmount) {
        drifts.push({ id: o.id, customerId: o.customerId, providerId: o.providerId, current: o.pendingAmount, target, drift: o.pendingAmount - target });
      }
    }
    if (drifts.length === 0) {
      process.stdout.write("  no obligationStates have pendingAmount drift.\n");
    } else {
      process.stdout.write("  obligationStateId                     | customerId                            | providerId                            | current          | target           | drift\n");
      process.stdout.write("  ------------------------------------- | ------------------------------------- | ------------------------------------- | ---------------- | ---------------- | -----\n");
      for (const d of drifts) {
        process.stdout.write(
          `  ${d.id.padEnd(37)} | ${d.customerId.padEnd(37)} | ${d.providerId.padEnd(37)} | ${d.current.toString().padStart(16)} | ${d.target.toString().padStart(16)} | ${d.drift.toString()}\n`,
        );
      }
      if (args.apply) {
        process.stdout.write("\nApplying reconciliation transactions...\n");
        for (const d of drifts) {
          await prisma.obligationState.update({
            where: { id: d.id },
            data: { pendingAmount: d.target },
          });
          process.stdout.write(`  ${d.id}: pendingAmount ${d.current.toString()} → ${d.target.toString()}\n`);
        }
      } else {
        process.stdout.write("\nDRY-RUN: no obligationStates mutated. Re-run with --apply (and --customer or --all) to reconcile.\n");
      }
    }
  }

  if (!args.apply) {
    process.stdout.write("\nDRY-RUN: no mutations. Re-run with --apply --customer <id> or --apply --all to mutate.\n");
  }
}

main()
  .catch((e) => {
    process.stderr.write(`cleanup-demo-pending-updates failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
