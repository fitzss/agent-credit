# V2 Repeatable Settlement Runbook

Operator guide for the repeatable same-pair redemption path.

## V1 vs V2

| | V1 (insert-only) | V2 (insert+update) |
|---|---|---|
| Contract | `basis.es` with `.insert()` only | `basis.es` with conditional `.insert()` / `.update()` |
| Same-pair redemption | One-shot: first redemption per (owner, receiver) pair only | Repeatable: unlimited redemptions for the same pair |
| Reserve tree R5 flags | InsertUpdate (flags=03) | InsertUpdate (flags=03) |
| Contract address | `3ftqKqEaxk3kvrMApvsneJf3M...` | `GTQZ7cQG7r467sRXM5LrgSNNm...` |
| `contractVersion` field | `"v1"` | `"v2"` |

Version is derived from `reserveAddress` vs sidecar's current compiled contract. Not manually assigned.

## Prerequisites

1. **Ergo private testnet node** running on port 9052 with wallet unlocked
2. **ChainCash sidecar** running on port 8081 (compiles the v2 contract at startup)
3. **Agent Tab** running on port 3000
4. **Wallet** with sufficient ERG (>1 ERG for reserve collateral + fees)
5. **Secret files** in `~/.chaincash-secrets/` (mode 600):
   - `owner-{pubkey8}.json` — reserve owner's Schnorr private key
   - `receiver-{pubkey8}.json` — creditor's private key (for proveDlog tx signing)
   - `tracker-{nftId8}.json` — auto-created by `/tracker/deploy`

## Deploy a V2 Reserve

### Step 1: Mint a singleton reserve token

```bash
cd chaincash && sbt "runMain chaincash.sidecar.MintToken"
```

Outputs the token ID. Wait for block confirmation (~1-2 min on private testnet).

### Step 2: Deploy the reserve box

```bash
curl -X POST http://localhost:8081/reserve/build-and-submit \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerAddress": "<wallet-or-customer-P2PK-address>",
    "trackerNftId": "<tracker-NFT-token-ID>",
    "reserveTokenId": "<minted-token-ID>",
    "initialCollateralNanoErg": 1000000000,
    "nodeApiKey": "hello"
  }'
```

### Step 3: Register in Agent Tab

Create the customer, reserve record, and write the owner secret file:

```bash
# Create customer (if new)
# Create reserve via POST /api/reserves with reserveTokenId, trackerNftId, customerId
# Or create directly in DB with reserveAddress set to sidecar's basisAddress
```

The reserve will be auto-classified as v2 because its `reserveAddress` matches the sidecar's current contract.

### Step 4: Verify

```bash
curl -X PATCH http://localhost:3000/api/reserves \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<reserve-id>"}'
```

Check: `contractVersion: "v2"`, `lifecycle: "active"`, correct `valueNanoErg`.

## Obligations

Create an obligation between the reserve owner (debtor) and a provider (creditor):

```bash
curl -X POST http://localhost:3000/api/obligations \
  -H 'Content-Type: application/json' \
  -d '{
    "providerId": "<provider-id>",
    "customerId": "<customer-id>",
    "amount": 0.1
  }'
```

The obligation's `debtorPubKey` must match the reserve's `debtorPubKey`. The `creditorPubKey` must match the provider's `publicKey`.

For repeated redemption: after the first redemption settles the obligation, increase `currentAmount` again (via new usage/spending) and set `settlementStatus` back to `"current"`.

## Tracker Deployment

Each redemption requires a tracker box on-chain with the debt entry committed in an AVL tree.

```bash
curl -X POST http://localhost:8081/tracker/deploy \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerPubKeyHex": "<debtor-compressed-pubkey>",
    "receiverPubKeyHex": "<creditor-compressed-pubkey>",
    "totalDebtNanoErg": <cumulative-debt>,
    "trackerNftId": "<tracker-NFT-ID>",
    "nodeApiKey": "hello"
  }'
```

**Critical**: `totalDebtNanoErg` must be the **cumulative** ever-increasing debt for this pair, not just the current obligation amount. For a second redemption: `totalDebtNanoErg = previouslyRedeemed + currentObligation`.

The tracker secret is auto-written to `~/.chaincash-secrets/tracker-{nftId8}.json`.

**Each `/tracker/deploy` call moves the tracker NFT to a new box with a fresh keypair and tree.** The old tracker box is spent.

## Redemption Flow

### One-shot (preferred)

```bash
curl -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{
    "reserveId": "<reserve-id>",
    "obligationId": "<obligation-id>"
  }'
```

Agent Tab orchestrates:
1. Recovers any pending redemptions for this reserve
2. Validates contract version (v1 blocks repeat, v2 allows)
3. Computes cumulative `totalDebtNanoErg` from settlement history
4. Gathers existing reserve tree entries for proof reconstruction
5. Checks R5 digest against live chain (drift detection)
6. Calls sidecar `/reserve/redeem` (builds Schnorr sigs, AVL proofs, submits tx)
7. Polls for confirmation (30s window)
8. If confirmed: runs chain-verified reconciliation
9. If timeout: persists `PendingRedemption` record for later recovery

### Responses

| Phase | HTTP | Meaning |
|---|---|---|
| `"complete"` | 200 | Redeemed and reconciled |
| `"pending"` | 202 | Tx submitted, awaiting confirmation. `PendingRedemption` saved. |
| `"reconciliation-failed"` | 207 | Tx on-chain but reconciliation failed. `PendingRedemption` saved. |
| Error | 4xx/5xx | Pre-check failed or sidecar error. No tx submitted. |

## Reconciliation

### Automatic

Handled by the `/api/reserves/redeem` endpoint on success. Also auto-triggered on next `/redeem` call (recovers pending first).

### Manual recovery

```bash
curl -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<reserve-id>"}'
```

### Standalone (last resort)

```bash
curl -X POST http://localhost:3000/api/reserves/reconcile-redemption \
  -H 'Content-Type: application/json' \
  -d '{
    "reserveId": "...",
    "obligationId": "...",
    "redemptionTxId": "...",
    "grossRedeemNanoErg": ...,
    "feeNanoErg": ...,
    "netPayoutNanoErg": ...
  }'
```

### Reconciliation guardrails

1. Duplicate: `SettlementEvent.redemptionTxId @unique`
2. Context: reserve and obligation must share same `customerId`
3. Debt: obligation must have sufficient `currentAmount`
4. Tx exists: fetched from node blockchain API
5. Tx spent expected box: input boxIds checked
6. Reserve token in output: singleton token verified
7. Outflow matches: `dbValue - grossRedeem == newBoxValue`
8. Sidecar cross-check: live value matches tx output
9. Atomic: all DB writes in `prisma.$transaction`

## Pending Recovery

`PendingRedemption` records are created when:
- Confirmation poll times out (30s)
- Reconciliation fails after successful tx submission

Recovery runs automatically at the start of every `/api/reserves/redeem` call. Or manually via `/api/reserves/recover-pending`.

Lifecycle: `pending` → `reconciled` (or `failed`)

## Drift / Version Guardrails

| Check | Where | What happens on failure |
|---|---|---|
| R5 digest: DB vs chain | Agent Tab pre-check | 409: "drift detected" |
| R5 digest: reconstructed vs on-chain | Sidecar proof-time | Exception before proof generation |
| ErgoTree: reserve box vs compiled contract | Sidecar proof-time | Exception: "contract mismatch" |
| contractVersion: v1 + prior settlement | Agent Tab pre-check | 409: "v1 cannot redeem again for same pair" |
| contractVersion derivation | Agent Tab refresh (PATCH) | Re-derived from `reserveAddress` vs sidecar address |

## Assumptions

See `architecture-notes.md` for the full list.
