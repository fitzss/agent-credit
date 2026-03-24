# V2 Repeatable Settlement Runbook

Operator guide for the repeatable same-pair redemption path.

## V1 vs V2

| | V1 (insert-only) | V2 (insert+update) |
|---|---|---|
| Contract | `basis.es` with `.insert()` only | `basis.es` with conditional `.insert()` / `.update()` |
| Same-pair redemption | One-shot: first redemption per pair only | Repeatable: unlimited for same pair |
| Contract address | `3ftqKqEaxk3kvrMApvsneJf3M...` | `GTQZ7cQG7r467sRXM5LrgSNNm...` |
| `contractVersion` field | `"v1"` | `"v2"` — auto-derived from `reserveAddress` |

## Prerequisites

**Infrastructure:**
1. Ergo private testnet node on port 9052, wallet unlocked
2. ChainCash sidecar on port 8081
3. Agent Tab on port 3000
4. Wallet with >1 ERG

**Data (the only real prerequisite for redemption):**
- Customer record in Agent Tab DB with `privateKey` populated
- Provider record in Agent Tab DB with `privateKey` populated
- Reserve record linked to customer, with `reserveAddress` set
- Obligation record linking customer (debtor) to provider (creditor)

Everything else is automatic:
- Secret files: auto-provisioned from DB private keys
- Tracker deployment: auto-triggered when stale or missing
- Cumulative debt: auto-computed from settlement history
- Pending recovery: auto-run before each redemption attempt

## Deploy a V2 Reserve

### Step 1: Mint a singleton reserve token

```bash
cd chaincash && sbt "runMain chaincash.sidecar.MintToken"
```

Wait for block confirmation.

### Step 2: Deploy the reserve box

```bash
curl -X POST http://localhost:8081/reserve/build-and-submit \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerAddress": "<P2PK-address>",
    "trackerNftId": "<tracker-NFT-ID>",
    "reserveTokenId": "<minted-token-ID>",
    "initialCollateralNanoErg": 1000000000,
    "nodeApiKey": "hello"
  }'
```

### Step 3: Register in Agent Tab

```bash
curl -X POST http://localhost:3000/api/reserves \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "<customer-id>",
    "trackerNftId": "<tracker-NFT-ID>",
    "reserveTokenId": "<minted-token-ID>"
  }'
```

`contractVersion` is auto-derived from the returned `reserveAddress`.

### Step 4: Verify

```bash
curl -X PATCH http://localhost:3000/api/reserves \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<reserve-id>"}'
```

Check: `contractVersion: "v2"`, `lifecycle: "active"`.

## Obligations

Create:

```bash
curl -X POST http://localhost:3000/api/obligations \
  -H 'Content-Type: application/json' \
  -d '{"providerId": "<id>", "customerId": "<id>", "amount": 0.1}'
```

For repeated redemption: after settlement, increase `currentAmount` and set `settlementStatus` to `"current"` (via new usage/spending).

## Redemption

### One call does everything

```bash
curl -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<id>", "obligationId": "<id>"}'
```

The endpoint automatically:
1. Recovers any pending redemptions for this reserve
2. Provisions owner/receiver secret files from DB (if missing)
3. Validates contract version (v1 blocks repeat, v2 allows)
4. Computes cumulative `totalDebtNanoErg` from settlement history
5. Deploys a new tracker if current one is stale or missing (waits for confirmation)
6. Gathers existing reserve tree entries for proof reconstruction
7. Validates R5 digest against live chain (drift detection)
8. Calls sidecar `/reserve/redeem` (Schnorr sigs, AVL proofs, tx submission)
9. Polls for confirmation (30s)
10. If confirmed: runs chain-verified reconciliation (8 guardrails, atomic writes)
11. If timeout: persists `PendingRedemption` for auto-recovery on next call

### Responses

| Phase | HTTP | Meaning |
|---|---|---|
| `"complete"` | 200 | Redeemed and reconciled |
| `"pending"` | 202 | Tx submitted, PendingRedemption saved. Auto-recovers on next call. |
| `"reconciliation-failed"` | 207 | Tx on-chain but reconciliation failed. PendingRedemption saved. |
| Error | 4xx/5xx | Pre-check failed. No tx submitted. |

### What you no longer need to do manually

| Old manual step | Now automatic |
|---|---|
| Create `~/.chaincash-secrets/owner-*.json` | Auto-provisioned from `customer.privateKey` |
| Create `~/.chaincash-secrets/receiver-*.json` | Auto-provisioned from `provider.privateKey` |
| Call `/tracker/deploy` before each redemption | Auto-triggered when tracker is stale/missing |
| Compute cumulative `totalDebtNanoErg` | Auto-computed from settlement history |
| Copy-paste `manualReconcilePayload` after timeout | Auto-recovered on next `/redeem` call |

## Recovery

### Automatic (preferred)

Just call `/api/reserves/redeem` again. It runs `recoverPending()` first.

### Explicit

```bash
curl -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<id>"}'
```

### Last resort (standalone reconciliation)

```bash
curl -X POST http://localhost:3000/api/reserves/reconcile-redemption \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"...","obligationId":"...","redemptionTxId":"...","grossRedeemNanoErg":...}'
```

## Guardrails

### Pre-redemption checks

| Check | Layer | Failure |
|---|---|---|
| Secret files exist / match | Agent Tab | 400/409: auto-creates or rejects mismatch |
| Contract version v1 + prior pair | Agent Tab | 409: "v1 cannot redeem again" |
| Tracker aligned (committed debt = required) | Agent Tab | Auto-deploys new tracker |
| R5 digest: DB vs chain | Agent Tab | 409: "drift detected" |
| R5 digest: reconstructed vs on-chain | Sidecar | Exception before proof generation |
| ErgoTree: reserve box vs compiled contract | Sidecar | Exception: "contract mismatch" |

### Reconciliation checks (8 guardrails)

1. Duplicate: `SettlementEvent.redemptionTxId @unique`
2. Context: reserve.customerId == obligation.customerId
3. Sufficient debt: obligation.currentAmount >= grossRedeemCredits
4. Tx confirmed on-chain
5. Tx spent expected reserve box
6. Reserve token in tx output
7. Outflow matches claimed grossRedeemNanoErg
8. Sidecar live state matches tx output
9. All DB writes atomic (`prisma.$transaction`)

## Smoke Test

See `smoke-test.md` for a scriptable verification checklist.

## Assumptions

See `architecture-notes.md` for semantics, invariants, and prototype-grade items.
