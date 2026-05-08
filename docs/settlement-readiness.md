# Settlement Readiness Audit (slice 13a)

`agent-tab/scripts/check-settlement-readiness.ts`

A read-only diagnostic that answers:

> "Given a `reserveId` and an `obligationStateId`, can this obligation
> settle/redeem against this reserve right now? If not, exactly why not?"

The audit performs **no DB writes, no chain transactions, no sidecar
mutations, no tracker deploys**. It mirrors the precondition gates of
`POST /api/reserves/redeem` and `src/lib/reconcile.ts` but reads instead
of acts. Whatever blockers the redeem route would surface, this audit
surfaces in advance.

## Why this audit exists

The whitepaper thesis is `work → Work Receipt → obligation → settlement`.
Slices 12 and 12a.1 shipped the receipt+obligation path. Slice 13b will
ship receipt-to-reserve settlement against a *dedicated demo reserve*.
Before 13b, we need a way to learn "would this settle?" without
attempting a redemption.

Today, that answer is buried inside the redeem route. The only way to
discover a blocker is to call `/api/reserves/redeem` and read the error
back. That's wrong because (1) attempts mutate state and consume time
on-chain, and (2) the failure surface is opaque from outside the route.

## Usage

```
npx tsx scripts/check-settlement-readiness.ts \
  --reserve-id <reserveId> \
  --obligation-state-id <obligationStateId>
```

Convenience flag for the slice 12a.1 fixture:

```
npx tsx scripts/check-settlement-readiness.ts \
  --reserve-id <reserveId> \
  --latest-repo-lint
```

`--latest-repo-lint` resolves the most recent `ObligationState` under
provider `mcp-demo-repo-tools-001`. Mutually exclusive with
`--obligation-state-id`.

Other flags:

- `--json` — emit only JSON to stdout (suppress the human-readable
  stderr summary). Useful for piping.
- `--help`, `-h` — print usage.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | PASS — every check green; obligation can settle against this reserve |
| `1` | FAIL — at least one blocker reported; DB unchanged |
| `2` | MISUSE — missing/conflicting flags, or `--latest-repo-lint` with no matching row |

## Units

v1 settlement uses an identity mapping: **1 nanoCredit == 1 nanoErg**.

- `Reserve.valueNanoErg` is denominated in nanoErg (chain-native).
- `ObligationState.currentAmount` is denominated in nanoCredits.
- Source of truth: `agent-tab/src/lib/credits.ts` —
  `NANOCREDITS_PER_CREDIT` (`1e9`) and `nanoCreditsToNanoErg` (returns
  input unchanged for v1).

The audit verifies the identity at runtime via a probe; if a future
contract version breaks identity, unit-crossing checks (#14, #16) report
**WARN** rather than silently passing. The top-level `unitInvariant`
field in the JSON output declares the assumption explicitly.

Any contract version that breaks the identity must update this audit
before being shipped.

## What it checks (19 read-only checks)

Each check yields `{ id, label, status: "pass" | "fail" | "warn" | "skip", detail }`.
**Every check runs**, regardless of earlier failures, so the report shows
the full set of blockers in one shot.

Checks that depend on the sidecar (#4, #14, #16, #19) report `skip` with
reason `"sidecar unreachable"` when check #1 fails, so the rest of the
audit is still useful.

| # | Check | Source-of-truth mirror |
|---|---|---|
| 1 | Sidecar `/health` reachable | `agent-tab/src/lib/sidecar-client.ts:37` |
| 2 | `Reserve` row exists | `agent-tab/src/app/api/reserves/redeem/route.ts:31` |
| 3 | `Reserve.boxId` non-null | `agent-tab/src/app/api/reserves/redeem/route.ts:33` |
| 4 | Sidecar `/reserve/status` returns `found: true` | `agent-tab/src/lib/reconcile.ts` |
| 5 | `Reserve.debtorPubKey == Customer.publicKey` | `agent-tab/src/app/api/reserves/redeem/route.ts` |
| 6 | `ObligationState` row exists | `agent-tab/src/app/api/reserves/redeem/route.ts:35` |
| 7 | `Obligation.currentAmount > 0` | `agent-tab/src/app/api/reserves/redeem/route.ts:42` |
| 8 | `Reserve.customerId == Obligation.customerId` | `agent-tab/src/app/api/reserves/redeem/route.ts:38` |
| 9 | `Obligation.debtorPubKey == Customer.publicKey` | obligation invariant (`tracker/service.ts`) |
| 10 | `Obligation.creditorPubKey == Provider.publicKey` | obligation invariant |
| 11 | No `PendingRedemption` with `status="pending"` for this obligation | `agent-tab/src/app/api/reserves/redeem/route.ts:59` |
| 12 | Obligation has `latestSignedMessage` and `latestSignature` | redemption requires a signed obligation |
| 13 | `TrackerEntry` exists for `(debtorPubKey, creditorPubKey)` on current `TrackerBox` | `agent-tab/src/lib/reconcile.ts:411` |
| 14 | `TrackerEntry.totalDebtNanoErg` matches `priorSettlements + obligation.currentAmount` | `agent-tab/src/lib/reconcile.ts:275` (`computeCumulativeTrackerDebt`) |
| 15 | Contract-version compatibility (v1 reserves cannot redeem twice for the same pair) | `agent-tab/src/app/api/reserves/redeem/route.ts:92` |
| 16 | Reserve collateral sufficient: sidecar `valueNanoErg ≥ obligation.currentAmount` (1:1 v1 identity) | `agent-tab/src/lib/reconcile.ts` |
| 17 | Owner secret file present (`fs.statSync` only — no read) | `agent-tab/src/lib/reconcile.ts:30` (`ensureSecretFile`) |
| 18 | Receiver secret file present | `agent-tab/src/lib/reconcile.ts:30` (`ensureSecretFile`) |
| 19 | `Reserve.avlTreeDigest` (DB) matches sidecar `avlTreeDigest` | `agent-tab/src/app/api/reserves/redeem/route.ts:138` |

## Reading the output

JSON shape (top-level keys):

```ts
{
  unitInvariant: { version: "v1", note: "..." },
  summary: { result, checksTotal, checksPassed, checksFailed, checksSkipped, checksWarn },
  inputs: { reserveId, obligationStateId, latestRepoLint },
  reserve: { ... } | null,
  obligation: { ... } | null,
  keyAlignment: { reserveDebtorMatchesCustomer, obligationDebtorMatchesCustomer,
                  obligationCreditorMatchesProvider, sameCustomer },
  amountReadyToSettle: string,           // nanoCredits as decimal string
  sidecarHealth: { reachable, status, network, sidecarVersion } | { reachable: false, ... },
  sidecarReserveStatus: ReserveStatus | null,
  trackerReadiness: { currentBoxId, treeDigestHex, entryFound,
                      entryTotalDebtNanoErg, expectedTotalDebtNanoErg, aligned } | null,
  pendingRedemption: { hasInFlight, txId },
  priorSettlements: { countForPair, totalRedeemedNanoErg },
  checks: Check[],
  blockingReasons: string[],            // human sentence per failed/warn check
  nextStep: string                       // PASS or FAIL hint
}
```

`blockingReasons` is the most useful field for humans: each entry names
a check by id, label, and detail. `nextStep` tells you what to do.

The human-readable stderr summary (suppressed by `--json`) shows
reserve, obligation, sidecar, tracker, and final result with blocker
list — useful for one-shot operator runs.

## Common blockers and remediation

Grouped by failure category. Each blocker reads from a real source of
truth in the redeem route — fixing the underlying state, not the audit
script, is the remediation.

### Sidecar (check #1)

| Detail | Remediation |
|---|---|
| `sidecar unreachable` | Start the JVM sidecar: `cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"`. Confirm `SIDECAR_URL` (default `http://localhost:8081`). |

### Reserve state (checks #2, #3, #4, #19)

| Detail | Remediation |
|---|---|
| `no Reserve found with id=...` | Verify `--reserve-id` against `prisma.reserve.findMany`. |
| `reserve has no on-chain boxId` | Reserve was requested but never deployed. Run the deploy flow before auditing for redemption. |
| `sidecar reports reserve not found on-chain` | The reserveTokenId is not visible to the sidecar. Confirm the reserve was deployed and the sidecar is scanning the right network. |
| `Reserve R5 digest drift detected` (#19) | DB and chain disagree on the reserve's AVL tree digest. The redeem route would refuse with HTTP 409. Re-scan the reserve or investigate why the DB is stale. |

### Obligation state (checks #6, #7, #11, #12)

| Detail | Remediation |
|---|---|
| `no ObligationState found with id=...` | Verify `--obligation-state-id`. If using `--latest-repo-lint`, confirm the demo seeder ran and at least one `/api/proxy` call succeeded. |
| `obligation already settled or never charged (currentAmount=0)` | Nothing to redeem. If you expected a balance, check the obligation's update history. |
| `PendingRedemption ... is in flight` | Wait for confirmation, or call `/api/reserves/recover-pending`. Do not start a new redemption. |
| `obligation has no latestSignedMessage and/or latestSignature` | The obligation has not been signed. For tracker-managed obligations the tracker should sign on each charge; for self-custody, the customer must sign. Investigate the tracker/service.ts commit path. |

### Key alignment (checks #5, #8, #9, #10)

| Detail | Remediation |
|---|---|
| `reserve.debtorPubKey ... but customer.publicKey ...` | The reserve was deployed with a key that does not match the current customer record. Either the customer's keys rotated or the reserve was misconfigured. |
| `reserve.customerId=... but obligation.customerId=...` | Reserve and obligation belong to different customers — the redeem route would refuse with HTTP 400. Choose a reserve owned by the obligation's customer. |
| `obligation.debtorPubKey ... but customer.publicKey ...` | The obligation was created with a key that does not match the customer record. Investigate `tracker/service.ts` propose/commit. |
| `obligation.creditorPubKey ... but provider.publicKey ...` | Same problem on the provider side. |

### Tracker mismatch (checks #13, #14)

| Detail | Remediation |
|---|---|
| `no current TrackerBox for trackerNftId=...` | The reserve's tracker has not been deployed. The redeem route would auto-deploy via `ensureTrackerAligned`, but only if the rest of the preconditions hold. For an audit, this is informational. |
| `current TrackerBox has no entry for (debtor, creditor)` | The tracker is deployed but does not yet track this pair. Common when running `--latest-repo-lint` against the canonical reserve — the repo-lint provider isn't in the canonical tracker box. Slice 13b will introduce a dedicated demo reserve+tracker for receipt-to-reserve settlement. |
| `tracker totalDebtNanoErg ≠ expected` | The tracker's recorded debt does not match `priorSettlements + obligation.currentAmount`. Redeploy the tracker with current totals (the redeem route's auto-deploy path handles this; for an audit, it just reports the misalignment). |

### Contract version (check #15)

| Detail | Remediation |
|---|---|
| `reserve.contractVersion=v1 (insert-only) but N prior on-chain settlement(s) exist for this pair` | v1 contracts allow exactly one redemption per `(debtor, creditor)` pair. Deploy a v2 reserve to redeem again for the same pair. |

### Collateral (check #16)

| Detail | Remediation |
|---|---|
| `reserve=X nanoErg but needs=Y nanoErg` | Top up the reserve before redeeming. The redeem route would proceed and the on-chain tx would fail; the audit catches this in advance. |

### Signature secrets (checks #17, #18)

| Detail | Remediation |
|---|---|
| `missing ~/.chaincash-secrets/owner-XXXXXXXX.json` | The Schnorr secret file for the owner is not on disk. The redeem route would auto-provision it from `Customer.privateKey` if set; if `Customer.privateKey` is empty (self-custody mode), the secret cannot be auto-provisioned and redemption would fail. |
| `missing ~/.chaincash-secrets/receiver-XXXXXXXX.json` | Same for the provider side. |

## Connection to slice 13b

When this audit reports **PASS**, slice 13b can attempt a real
receipt-to-reserve settlement against a *dedicated demo reserve* (NOT
the canonical fixture `e7f6f1c2`, per the whitepaper isolation rule —
the canonical reserve must remain stable for the 49/49 proof stack).

The `--latest-repo-lint` flow against the canonical reserve is
**expected** to report FAIL with a tracker-mismatch blocker — that's
useful, honest output, not a script bug. 13b's first task is to set up
a dedicated reserve + tracker that aligns with the repo-lint provider
so the audit can pass against it.

## What this audit does NOT verify

- **Chain finality between read and act.** State at audit time can drift
  before a real redemption runs (TOCTOU). The audit is advisory.
- **Anti-replay under concurrent redemptions.** Two simultaneous
  audit-pass states could collide; the redeem route handles serialization.
- **Network re-org safety.** Off-chain reserves trust the testnet's
  finality model.
- **Sidecar correctness.** The audit trusts the sidecar's `/health` and
  `/reserve/status` responses. It does not verify that the sidecar is
  running the correct contract version against the correct network.

These are 13b's responsibilities, not 13a's.

## Scope notes

- Read-only. No DB writes, no chain transactions, no sidecar mutations.
- Does not modify `/api/reserves/redeem`, `reconcile.ts`, `chaincash/`, or `prisma/schema.prisma`.
- Does not touch the canonical reserve fixture state.
- Not added to `prove.sh`. The 49/49 baseline is intentionally preserved.
- Sidecar fetches are wrapped script-locally with a 5s timeout; no
  changes to `agent-tab/src/lib/sidecar-client.ts`.
