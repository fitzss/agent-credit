# Receipt-to-Reserve Settlement Demo (slice 13c)

## Why this slice matters

The whitepaper thesis is **work → Work Receipt → obligation → settlement**. Slices 12a.1, 13a, and 13b shipped the work-receipt → obligation → readiness-audit → isolated-reserve pipeline. Slice 13c is the first end-to-end demonstration of the full loop on Ergo testnet.

```
                    +------------------+
   MCP tool call →  | /api/proxy       |  ← repo-lint agent API key
                    | (slice 12a.1)    |  ← x-tool-id repo-lint
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | Work Receipt     |
                    | UsageEvent +     |
                    | ObligationUpdate |
                    | ObligationState  |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | Readiness audit  |  ← slice 13a snapshot
                    | (19/20 pre-redeem)|  ← exposes tracker-entry-missing
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | /api/reserves/   |  ← auto provisions receiver secret
                    | redeem           |  ← auto deploys tracker entry
                    | (atomic txn)     |  ← v1 identity nanoCredits=nanoErg
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | SettlementEvent  |
                    | + Reserve update |
                    | + Obligation = 0 |
                    +------------------+
                             |
                             v
                    +------------------+
                    | Canonical proof  |
                    | reserve untouched|  ← updatedAt verified
                    | byte-for-byte    |     byte-for-byte
                    +------------------+
```

The canonical reserve `e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c` is **never** touched. The demo runs against the dedicated slice-13b demo reserve (`agent-tab/.demo-state/settlement-demo-reserve.json`), with multiple defensive layers to enforce that.

## Prerequisites

The demo relies on infrastructure being up and the slice-13b reserve being live and active. From a cold start:

1. Start the Ergo testnet node and unlock the wallet.
   ```bash
   cd ~/ergo && java -jar ergo-5.0.14.jar --testnet -c ergo.conf
   curl -X POST http://localhost:9052/wallet/unlock \
     -H "api_key: hello" -H "Content-Type: application/json" \
     -d '{"pass":"hello"}'
   ```
2. Start the JVM sidecar.
   ```bash
   cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"
   ```
3. Start the agent-tab dev server in demo mode (the repo-lint demo tool requires `DEMO_MODE=true`).
   ```bash
   cd agent-tab && DEMO_MODE=true npx next dev -p 3000
   ```
4. Make sure ≥ 0.5 ERG is free in the wallet to fund the tracker auto-deploy that the redeem route performs inline.
5. Set up a fresh slice-13b demo reserve. From a clean state this is a three-step operator flow:
   ```bash
   # Pick a fresh reserve token id and tracker NFT id (see docs/settlement-demo-reserve.md)
   npx tsx scripts/seed-settlement-demo-reserve.ts --prepare \
     --tracker-nft-id <hex64> --reserve-token-id <hex64>
   # Submit the deployment tx to the wallet (operator step, see slice-13b doc)
   npx tsx scripts/seed-settlement-demo-reserve.ts --sync
   npx tsx scripts/seed-settlement-demo-reserve.ts --status
   # → expect lifecycle=active, boxId populated, valueNanoErg ≥ 100,000,000
   ```

## Phase 1: `--preflight` (Group A, environment-only)

```bash
npx tsx agent-tab/scripts/repo-lint-to-reserve-settlement-demo.ts --preflight
```

`--preflight` is **read-only and idempotent**. It performs 19 environment-only checks. It does **not** check the repo-lint AgentIdentity / CreditLine state, because Stage 2 of `--execute` resets and re-seeds the lane. Lane checks live in Stage 2b instead — see "Why the preflight/execute split" below.

| # | Check | What it confirms |
|---|---|---|
| A1 | Sidecar `/health` reachable | JVM sidecar at port 8081 is up. |
| A2 | Ergo node `/info` reachable | Testnet node at port 9052 is up. |
| A3 | Dev server reachable | `localhost:3000` responds (any HTTP status — only network errors fail). |
| A4 | Slice-13b manifest exists | `agent-tab/.demo-state/settlement-demo-reserve.json` is present and parses. |
| A5 | Manifest reserveId not canonical | Defensive denylist — exit 2 PANIC on any hit. |
| A6 | Manifest reserveTokenId not canonical | Defensive denylist. |
| A7 | Manifest trackerNftId not canonical | Defensive denylist. |
| A8 | Demo reserve at `lifecycle="active"` | DB row matches manifest, lifecycle is active. |
| A9 | Demo reserve `boxId` non-null | On-chain UTXO discovered. |
| A10 | `valueNanoErg ≥ 100,000,000` | Enough collateral for one settlement (v1 identity). |
| A11 | Sidecar `/reserve/status` reports `found:true` | The reserve box is currently spendable on-chain. |
| A12 | Sidecar `valueNanoErg` matches DB | No drift between sidecar view and DB view. |
| A13 | `Reserve.avlTreeDigest` matches sidecar | No R5 drift (mirrors the redeem route's pre-check). |
| A14 | Demo Debtor `signingMode="tracker"` + `privateKey` set | Tracker-mode signing will work. |
| A15 | Repo-lint provider has `privateKey` | Receiver secret will be auto-provisioned by `ensureSecretFile`. |
| A16 | Repo-lint Tool exists | The proxy can call the tool. |
| A17 | Owner secret file `~/.chaincash-secrets/owner-{first8hex}.json` exists | Sidecar can sign as the reserve owner. |
| A18 | No in-flight `PendingRedemption` for demo reserve | Lane is clean; previous run isn't stuck mid-flight. |
| A19 | Canonical reserve row exists at `lifecycle="active"` | Stage 1 can snapshot it for byte-for-byte comparison. |

Output: structured JSON to stdout, human-readable summary to stderr.

Exit codes:
- **0** — environment ready; run `--execute`.
- **1** — one or more checks failed; resolve blockers, re-run `--preflight`.
- **2** — canonical denylist hit (A5/A6/A7) or misuse (unknown flag).

## Phase 2: `--execute` (full demo)

```bash
npx tsx agent-tab/scripts/repo-lint-to-reserve-settlement-demo.ts --execute
```

12 stages. Each stage announces itself on stderr, accumulates a structured entry into the final JSON report on stdout, and halts the demo on failure.

### Stage 0 — Environment preflight gate
Re-runs Group A. If any check fails, the demo refuses to start. This guarantees that the destructive flow only runs in a known-good environment.

### Stage 1 — Snapshot canonical + counts
Snapshots canonical reserve fields (`valueNanoErg`, `boxId`, `avlTreeDigest`, `lifecycle`, `contractVersion`, `updatedAt`, plus `settlementCountForCanonicalReserveId` — the count of `SettlementEvent` rows scoped to canonical's `reserveId` with `method="on-chain-redemption"`) to `/tmp/13c-canonical-before.json`. Snapshots Prisma row counts to `/tmp/13c-counts-before.json`.

**Why reserveId-scoped, not customerId-scoped**: canonical and the slice-13b demo reserve share Demo Debtor's customerId. A correct settlement on the demo reserve will increase the customer-level count, but it must NOT increase canonical's reserveId-scoped count. Slice 13d added `SettlementEvent.reserveId`, making this distinction precise. An earlier version of this stage counted by customerId, which produced a false-positive PANIC at Stage 9 the first time the demo redemption committed cleanly. The reserveId-scoped count is the load-bearing canonical-mutation indicator.

### Stage 2 — Reset + re-seed repo-lint lane
Runs `seed-repo-lint-demo.ts --reset` (deletes UsageEvent / ObligationUpdate / ObligationState / AgentIdentity / CreditLine for the lane), then `seed-repo-lint-demo.ts` (creates a fresh lane and prints a new agent API key). The fresh API key is captured from stdout.

**Failure mode**: if a previous successful 13c run left a `SettlementEvent` row for the obligation, `--reset` will refuse to delete the obligation and exit nonzero. Recovery requires the operator to manually clear the SettlementEvent rows for that obligation, or to set up a different demo reserve and re-run from scratch.

### Stage 2b — Group B post-seed lane validation
This is the new stage that resolves the preflight/execute ordering bug. Group B runs **after** the lane is re-seeded.

| # | Check |
|---|---|
| B1 | Repo-lint Provider `status="active"` |
| B2 | Repo-lint Tool `status="active"` |
| B3 | Repo-lint AgentIdentity `status="active"` |
| B4 | Agent has `apiKeyHash` |
| B5 | Captured raw API key non-empty |
| B6 | CreditLine row exists |
| B7 | CreditLine `limitAmount ≥ 100,000,000` |
| B8 | No pre-existing ObligationState for the lane |
| B9 | No pre-existing UsageEvent for the agent |

If any B-check fails, the demo halts. The seeder didn't produce the expected lane state — investigate before retrying.

### Stage 3 — Create one Work Receipt via `/api/proxy`
POST `/api/proxy` with `x-agent-api-key: <freshly-minted>` and `x-tool-id: mcp-demo-tool-repo-lint-001`. The repo-lint demo tool ignores the body and runs `npm run lint` in the agent-tab repo. Verifies post-conditions: `ObligationState.currentAmount === 100,000,000`.

### Stage 4 — Run slice-13a readiness audit
Invokes `check-settlement-readiness.ts --reserve-id <demo> --obligation-state-id <lane>`. **Expected: useful FAIL on `[#13] tracker-entry-missing`.** The redeem route auto-deploys the tracker entry inline; slice 13a is a pre-redeem snapshot and doesn't auto-deploy itself. The demo logs the audit JSON for evidence and continues.

### Stage 5 — Defensive denylist
Reloads the manifest and the obligation, asserts:
- manifest does not match canonical (any field) — exit 2 PANIC on hit;
- obligation provider is the repo-lint provider — exit 2 PANIC on mismatch.

This is unreachable from script flow alone; defense in depth.

### Stage 6 — POST `/api/reserves/redeem`
Mints an operator session cookie via `operatorCookieHeader()`, POSTs `{ reserveId, obligationId }` to the redeem route, reads the response.

The redeem route's possible outcomes:
- **200/201 (`phase: "complete"`)** — synchronous reconciliation. Settlement is in DB. Continue to Stage 8.
- **202 (`phase: "pending"`)** — tx submitted but not yet confirmed; PendingRedemption persisted. Continue to Stage 7.
- **207 (`phase: "reconciliation-failed"`)** — tx confirmed but reconciliation threw; PendingRedemption persisted. Continue to Stage 7.
- **Any 4xx/5xx** — print body and exit 1.

### Stage 7 — Recovery loop
If Stage 6 returned 202 or 207, wait 30 seconds and POST `/api/reserves/recover-pending` with `{ reserveId }`. Up to 2 attempts. If a recovered record reports `status: "reconciled"` or `"already-reconciled"` for the obligation, continue to Stage 8. Otherwise exit 1 with manual remediation hints (re-run `recover-pending`, or check the Ergo block explorer for the redemption tx).

### Stage 8 — Verify settlement post-conditions
- `SettlementEvent` for the obligation has `method="on-chain-redemption"`, `status="completed"`, `redemptionTxId` non-null;
- `ObligationState.currentAmount === 0`;
- Demo reserve `boxId` rotated (new UTXO replaces the old one);
- `TrackerEntry` for the (Demo Debtor, repo-lint provider) pair now exists in the current TrackerBox;
- Receiver secret file at `~/.chaincash-secrets/receiver-{first8hex-of-provider-pubkey}.json` exists.

### Stage 9 — Verify canonical reserve untouched
Reloads canonical fields, compares to `/tmp/13c-canonical-before.json`. Every field must match exactly, **including `updatedAt`**. The `settlementCountForCanonicalReserveId` must be unchanged — the new SettlementEvent has `reserveId=<demo>`, not `reserveId=<canonical>`, so canonical's reserveId-scoped count stays put. Any mismatch → exit 2 PANIC, dump the diff. This stage is the byte-for-byte proof that no script flow path ever mutated canonical, and the diff would surface any concurrent external mutation.

(Customer-level settlement counts SHOULD increase by 1 — that's the new demo settlement under Demo Debtor — but customer-level counts are not part of Stage 9's check; they're a normal consequence of the demo running.)

### Stage 10 — Re-run slice-13a readiness audit
Same invocation as Stage 4. **Expected: FAIL on `[#7] Obligation.currentAmount > 0`** (it's now 0). This is the documented post-settlement state — useful FAIL.

### Stage 11 — Final report
Prints structured JSON to stdout: `{ result, redemptionTxId, settlementEventId, canonicalBefore, canonicalAfter, demoReserveBefore, demoReserveAfter, auditBeforeRedeem, auditAfterRedeem, stages, prove_sh_recommendation }`. Exit 0.

## Why the preflight/execute split

A previous version of the plan put repo-lint AgentIdentity and CreditLine checks inside `--preflight`. That created a contradiction: `--execute` Stage 0 re-runs preflight as a gate, but `--execute` Stage 2 resets and re-seeds the repo-lint lane. So whenever the lane was depleted past its cap (the typical state at the start of a demo) or freshly cleaned, preflight would refuse to start before the demo even had a chance to set up the lane it needs.

Resolution:
- **Group A** (`--preflight` and `--execute` Stage 0) checks infrastructure + slice-13b reserve + secrets + canonical existence. None of these change as a function of the repo-lint lane's lifecycle.
- **Group B** (`--execute` Stage 2b only) checks the repo-lint lane's freshly-reseeded state. Group B never runs from `--preflight`.

This keeps `--preflight` strictly idempotent — it can be run any number of times, with or without a current repo-lint lane, without changing state — while still letting `--execute` enforce that the lane is in the exact state needed before the Work Receipt is created.

## Verification of canonical safety

Multiple defensive layers, each independently sufficient to refuse a canonical-targeted call:

1. **Manifest denylist** (Stage 0 / preflight checks A5–A7, and again in Stage 5). Any of `reserveId`, `reserveTokenId`, `trackerNftId` matching the canonical values → exit 2 PANIC before any side effect.
2. **`reserveId` scoping in the redeem route**. Every Reserve write in the codebase scopes to a specific `reserveId` from input. The script only ever passes `manifest.reserveId`.
3. **Provider denylist** (Stage 5). Confirms the obligation lives under the repo-lint provider; otherwise exit 2 PANIC.
4. **Stage 9 byte-for-byte snapshot diff**. Any drift in canonical fields, including `updatedAt`, is caught after the fact and exits 2 PANIC.

Note: the canonical reserve and the slice-13b demo reserve both belong to Demo Debtor's customerId. The cross-customer guard inside the redeem route does **not** trigger here. The reserveId denylist is therefore the load-bearing layer; do not weaken it.

This shared-customer fact is also why Stage 9's Stage-1 snapshot scopes settlement counts by canonical's `reserveId`, not by Demo Debtor's `customerId`. A correct demo settlement will increase customer-level settlement counts by 1 (the new SettlementEvent for the demo reserve); that is expected and is not canonical mutation. Slice 13d's `SettlementEvent.reserveId` column makes this distinction load-bearing rather than circumstantial.

## Verification of `prove.sh` 49/49 baseline

After a successful `--execute`, the script prints:
```
[13c-execute] Next: bash agent-tab/scripts/prove.sh — must return 49/49.
```

The operator runs prove.sh manually. **If prove.sh does not return 49/49, STOP and report. Do not patch `validate.sh` without explicit approval.**

Why this matters: `validate.sh:40-46` uses `updatedAt desc` to discover the active reserve for the substrate suite. After `--execute`, the demo reserve's row is more recently updated than the canonical row, so discovery picks the demo reserve. The substrate tests are reserve-id-agnostic per audit (they query by `redemptionTxId` or operate on whichever row is discovered), but **audit is not proof**. We rely on the post-execute prove.sh run for the actual verification. If discovery breaks substrate, that is a real defect that requires explicit decision-making before any code change.

## Recovery scenarios

| Scenario | Behavior | Recovery |
|---|---|---|
| Sidecar disconnects mid-Stage-6 | redeem route returns 502, script exits 1 | Re-run `--execute` after sidecar is up; if a tx was submitted on-chain, `recover-pending` reconciles it. Stage 9 still verifies canonical untouched. |
| Stage 6 → 202 + Stage 7 timeout | Script exits 1 with manual remediation hint | Operator runs `POST /api/reserves/recover-pending` with the demo reserve id; if confirmed, settlement reconciles. |
| Confirmation slow (block production) | Stage 7 retries twice (30s each) | Increase wait or run `recover-pending` manually after a few minutes. |
| Tracker auto-deploy fails | redeem route returns 502 from the tracker-deploy phase, script exits 1 | Investigate sidecar `/tracker/update` logs; canonical untouched. |
| Operator hits Ctrl-C mid-execute | `reconcileRedemption` is atomic, so partial settlement state cannot persist | If a tx was submitted, run `recover-pending`. |
| `--reset` refuses due to prior SettlementEvent | Stage 2 fails | Manually clear the SettlementEvent rows for the obligation, or set up a different demo reserve. |

## What this script does NOT do

- Does **not** modify `prisma/schema.prisma`, `chaincash/`, `src/lib/sidecar-client.ts`, `src/lib/reconcile.ts`, or `src/app/api/reserves/redeem/route.ts`.
- Does **not** patch `validate.sh` or `prove.sh`. If post-execute prove.sh fails, it stops and reports — patching is a separate change requiring explicit approval.
- Does **not** generate any keypairs.
- Does **not** auto-deploy the slice-13b demo reserve (operator's job; see `docs/settlement-demo-reserve.md`).
- Does **not** call `/api/reserves/redeem` against the canonical reserve (denylist before any side effect).
- Does **not** run `prove.sh` itself (multi-minute; operator runs it manually before and after).
- Does **not** support multiple Work Receipts per run (single proxy call → single settlement).
- Does **not** implement a `--cleanup` (settlement is irreversible on-chain). Cleanup primitives live in `seed-repo-lint-demo.ts --reset` and `seed-settlement-demo-reserve.ts --cleanup`.

## What 13c proves and what remains

**Proven by 13c**:
- A real MCP Work Receipt rolls into an `ObligationState`, settles atomically against an on-chain reserve, leaves a `SettlementEvent` and a `redemptionTxId`, and the canonical reserve is bit-for-bit unchanged.
- The slice-13a audit is meaningful in two regimes (pre-redeem useful FAIL, post-redeem useful FAIL).
- The slice-13b dedicated demo reserve isolates settlement risk from canonical.

**Not proven by 13c**:
- Multi-receipt settlement batching (Phase 6 of the whitepaper roadmap).
- Multi-pair tracker support (the redeem route uses `/tracker/update` already; 13c uses one pair).
- A web UI for triggering the demo (CLI only).
- Re-run-after-cleanup ergonomics (currently the operator must clear the SettlementEvent or the demo reserve to re-run).

## Slice stack

| Slice | Surface | Mode |
|---|---|---|
| 12a.1 — budgeted_repo_lint | `seed-repo-lint-demo.ts`, `/api/demo-tool/repo-lint`, MCP gateway | Off-chain receipts |
| 13a — settlement readiness audit | `check-settlement-readiness.ts` | Read-only, JSON |
| 13b — dedicated demo reserve | `seed-settlement-demo-reserve.ts`, `.demo-state/` manifest | Operator-driven setup |
| **13c — receipt-to-reserve settlement demo** | **`repo-lint-to-reserve-settlement-demo.ts`, `/tmp/13c-*.json`** | **End-to-end on-chain** |

All four slices share the same canonical-protection invariants: no schema changes, no chaincash changes, no sidecar-client/reconcile/redeem changes, and the canonical reserve `e7f6f1c2` remains untouched.
