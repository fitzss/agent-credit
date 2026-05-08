# Reserve-scoped settlement history (slice 13d)

## Why this slice exists

Slice 13c attempted the first end-to-end on-chain settlement demo against a dedicated demo reserve (slice 13b's `04b807e7`, distinct from the canonical `e7f6f1c2`). Stage 6 of the 13c demo failed at the JVM sidecar with:

```
Reserve tree drift detected!
  reconstructed=16273d44...
  onChain=4ec61f48...
```

Root cause: `src/lib/reconcile.ts:gatherExistingReserveEntries(customerId)` and `src/lib/reconcile.ts:computeCumulativeTrackerDebt(customerId, ...)` both scoped `SettlementEvent` queries by `customerId` only. When two reserves exist under the same customer (canonical and the new slice-13b demo reserve, both under Demo Debtor), the demo redemption pulled in canonical's prior settlement entries. The sidecar reconstructed an AVL tree that didn't match the demo reserve's actual on-chain R5 digest. The tx never went through.

The Ergo Basis contract is correct: each reserve box's R5 stores its own per-(debtor, creditor) cumulative redeemed total. The agent-tab side conflated customers with reserves because `SettlementEvent` had no `reserveId` field. **No sidecar or contract change was needed; this was purely an agent-tab scoping bug.**

## What this slice ships

A schema migration plus a one-shot backfill plus six code edits, all in one slice.

### Schema migration

`prisma/migrations/20260508161224_add_reserve_id_to_settlement_event/migration.sql`

Adds a nullable `reserveId TEXT` column to `SettlementEvent`, plus a foreign key to `Reserve`, plus an index on `reserveId`. The migration uses Prisma's standard SQLite RedefineTables pattern (temp table → INSERT SELECT preserving all original columns → DROP old → RENAME → recreate indexes). Only `SettlementEvent` is touched; no other model is modified.

The column is nullable forever. Manual settlements (`method="manual"` via `src/app/api/settle/route.ts`) have no on-chain reserve context and legitimately need `reserveId=NULL`. The "every on-chain redemption SettlementEvent has a reserveId" invariant is enforced in code — `reconcileRedemption`'s atomic `SettlementEvent.create` payload now includes `reserveId: input.reserveId`.

### Backfill

`scripts/backfill-settlement-event-reserve-id.ts`

A `--dry-run` / `--execute` / `--allow-fixture-stub` / `--help` CLI. Operates only on rows where:
- `method = "on-chain-redemption"`
- `status = "completed"`
- `reserveId IS NULL`
- `redemptionTxId IS NOT NULL`

Each candidate `Reserve` row must satisfy all six criteria. The script prints every candidate with each criterion's value:

| Criterion | Source | Why it proves "deployed before settlement" |
|---|---|---|
| C1 same customer | `Reserve.customerId == ObligationState.customerId` | Trivial scope. |
| C2 has on-chain identity | `Reserve.boxId IS NOT NULL` | Placeholder rows never get a `boxId`. |
| C3 has on-chain creation height | `Reserve.creationHeight IS NOT NULL` | Set by sidecar `/reserve/status` only after deployment confirms. |
| C4 lifecycle on-chain | `Reserve.lifecycle IN ("active", "depleted")` | Rules out `"requested"`/`"submitted"`. |
| C5 row predates settlement | `Reserve.createdAt <= SettlementEvent.timestamp` | DB row was created before the settlement was recorded. |
| C6 real reserveTokenId | matches `/^[a-f0-9]{64}$/` AND not a placeholder pattern | Defensive against placeholder rows like `aaaa1111...`. |

Selection requires `selectedCount === 1`. If 0 or >1 candidates pass, `--execute` refuses (exit 1).

#### `--allow-fixture-stub` (test-fixture exception, not a production rule)

The v1-stub fixture (`bf486d82` reserve under customer `c29eadb1`) is fake test scaffolding. Its `reserveTokenId` starts with `v1-stub-`, its `creationHeight` is null, and it never had a real on-chain deployment. The strict criteria correctly reject it. With `--allow-fixture-stub`, the script bypasses C3 and C6 ONLY for that exact (customerId, reserveId) pair, and only when the customer has exactly one settlement-needing-backfill. The script prints a banner declaring the exception is in effect.

This whitelist is surgical and visible in the code. Do not extend it without explicit approval.

### Code changes

| File:line | Change |
|---|---|
| `src/lib/reconcile.ts:223` (in `reconcileRedemption` `$transaction`) | Added `reserveId: input.reserveId` to `SettlementEvent.create` payload. |
| `src/lib/reconcile.ts:275` `computeCumulativeTrackerDebt` | Signature changed from `(customerId, debtor, creditor, current)` to `(reserveId, debtor, creditor, current)`. WHERE clause now scopes by `reserveId`. |
| `src/lib/reconcile.ts:311` `gatherExistingReserveEntries` | Signature changed from `(customerId)` to `(reserveId)`. WHERE clause now scopes by `reserveId`. |
| `src/app/api/reserves/redeem/route.ts:126` | Pass `reserve.id` to `gatherExistingReserveEntries`. |
| `src/app/api/reserves/redeem/route.ts:147` | Pass `reserve.id` to `computeCumulativeTrackerDebt`. |
| `src/app/api/tracker/deploy/route.ts:48` | Pass `reserve.id` to `computeCumulativeTrackerDebt`. |
| `src/app/api/debt/transfer/route.ts` | The redeemed-floor guardrail operates above the reserve layer (no single reserve in scope). The previous customer-scoped behavior is preserved by inlining the SettlementEvent query directly. |
| `scripts/check-settlement-readiness.ts:305` | Prior-settlements check now scopes by `reserveId` to match the per-reserve R5 AVL semantics. |
| `scripts/validate.sh:43` (V2 discovery) | Settlement count scopes by `reserveId` instead of `obligationState.customerId`. |
| `scripts/validate.sh:51` (V1 discovery) | Same fix. Also excludes `V2_RESERVE.id` from V1 candidates so `V1 != V2` (otherwise scenario 13's PATCH on V1 would overwrite scenario 9's contractVersion restore on V2). |

The `validate.sh` change was approved as part of "the same reserve-scoped settlement-history bugfix" — without it, discovery picks the wrong reserve and substrate scenarios 9 + 12 break.

## Sidecar / contract impact

**None.** The Ergo Basis contract is per-reserve, per-(debtor, creditor)-pair, cumulative-redeemed-nanoERG by design. The sidecar's `/reserve/redeem` already expects per-reserve `existingReserveEntries`. The bug was entirely in the agent-tab side passing the wrong entries.

`/api/reserves/recover-pending` is unaffected — it reads `PendingRedemption.reserveId` directly, never calling the buggy functions.

## Migration & backfill steps

```bash
# 1. Schema baseline
cd agent-tab
npx prisma migrate dev --name add_reserve_id_to_settlement_event --create-only
# Inspect prisma/migrations/<ts>_add_reserve_id_to_settlement_event/migration.sql
# Confirm: ADD COLUMN reserveId, ADD INDEX, FK rebuild on SettlementEvent only.
npx prisma migrate dev   # apply
npx prisma generate

# 2. Backfill
npx tsx scripts/backfill-settlement-event-reserve-id.ts --dry-run               # without flag, will fail v1-stub row
npx tsx scripts/backfill-settlement-event-reserve-id.ts --dry-run --allow-fixture-stub
npx tsx scripts/backfill-settlement-event-reserve-id.ts --execute --allow-fixture-stub
npx tsx scripts/backfill-settlement-event-reserve-id.ts --dry-run --allow-fixture-stub  # confirms 0 rows

# 3. Restart dev server (Next.js dev caches the Prisma client)
#    DEMO_MODE=true npx next dev -p 3000

# 4. Verify prove.sh
bash scripts/prove.sh   # 49/49
```

**Important — Next.js dev server caches the Prisma client.** After `npx prisma generate`, restart the dev server. Otherwise the running server still uses the old client, queries with `reserveId` throw `PrismaClientValidationError: Unknown argument 'reserveId'`, and the redeem route returns 500 with empty body.

## prove.sh 49/49 stability

The first prove.sh run after applying 13d may show 1-2 transitional substrate failures if the prior steady-state of canonical's `contractVersion` was disturbed (e.g., by debugging PATCH calls). validate.sh's scenario 9 restore at line 178 sets `V2_RESERVE.contractVersion='v2'` after each run, so the second run will pass cleanly. If `prove.sh` doesn't return 49/49 within two consecutive runs, stop and investigate.

## Why `reserveId` stayed nullable

`SettlementEvent.method = "manual"` covers off-chain settlements that have no on-chain reserve context. Forcing them to invent a `reserveId` would be wrong. The reserve-scoped query path filters `where: { reserveId, ... }`, which automatically excludes NULL — manual settlements never get pulled into AVL reconstruction. The schema-level invariant ("on-chain redemption settlements always have reserveId") is enforced in code (`reconcileRedemption.SettlementEvent.create` always passes `reserveId`).

## How 13c resumes

The slice-13b demo reserve (`04b807e7`) is still active on-chain and untouched by 13d. After 13d merges:

1. Branch `slice-13c-receipt-to-reserve-settlement-demo` off slice-13d-merged.
2. `git stash pop` to restore the 13c script + doc.
3. Run `npx tsx scripts/repo-lint-to-reserve-settlement-demo.ts --preflight` — should PASS 19/19.
4. Run `--execute` — Stage 6 returns 200/201/202; Stages 7–11 complete; canonical unchanged; exit 0.
5. `bash scripts/prove.sh` — 49/49.
6. Commit slice-13c separately. **Not part of 13d.**

## Slice stack

| Slice | Surface | Mode |
|---|---|---|
| 12a.1 — budgeted_repo_lint | seed-repo-lint-demo, /api/demo-tool/repo-lint, MCP gateway | Off-chain receipts |
| 13a — settlement readiness audit | check-settlement-readiness.ts | Read-only, JSON |
| 13b — dedicated demo reserve | seed-settlement-demo-reserve.ts | Operator-driven on-chain setup |
| **13d — reserve-scoped settlement history** | **schema migration + backfill + reconcile/redeem/transfer/tracker scoping fix** | **Schema change** |
| 13c — receipt-to-reserve settlement demo | repo-lint-to-reserve-settlement-demo.ts | (will commit on its own branch after 13d) |
