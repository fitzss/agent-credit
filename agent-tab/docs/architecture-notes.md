# Architecture & Assumptions Notes

Current state of the Agent Tab + ChainCash repeatable settlement system.

## Cumulative Debt Semantics

The Basis protocol uses **cumulative ever-increasing debt** between pairs:

```
totalDebt(A→B) = sum of all payments A has ever made to B
```

This value only increases. It is never reduced by redemption. Redemption tracks a separate cumulative counter:

```
redeemedDebt(A→B) = cumulative amount already redeemed from A's reserve for B
```

The redeemable delta at any point: `totalDebt - redeemedDebt`.

**Agent Tab's `obligation.currentAmount`** is NOT the same as `totalDebt`. It represents the current unredeemed balance. The cumulative `totalDebt` is computed as:

```
totalDebt = previouslyRedeemed + currentAmount
```

This computation lives in `computeCumulativeTrackerDebt()` in `reconcile.ts`. All redemption paths must use this function.

## Reserve Tree (R5) Semantics

| Property | Value |
|---|---|
| Key | `blake2b256(ownerPkBytes ++ receiverPkBytes)` — 32 bytes |
| Value | `longToByteArray(cumulativeRedeemedAmount)` — 8 bytes |
| Flags | InsertUpdate (flags=03): insert + update allowed, remove not |
| Key size | 32 bytes (PlasmaParameters(32, None)) |
| Operation on first redemption | `.insert(key → redeemAmount)` |
| Operation on subsequent redemption | `.update(key → newCumulativeRedeemed)` |

The tree stores cumulative redeemed amounts, not individual events. After two redemptions of 200M and 150M for the same pair, the tree value is 350M.

**Proof reconstruction**: Agent Tab sends `existingReserveEntries` (aggregated per pair from settlement history) to the sidecar. The sidecar rebuilds the PlasmaMap, validates its digest against on-chain R5, then generates the insert or update proof.

## Tracker Tree (R5) Semantics

| Property | Value |
|---|---|
| Key | `blake2b256(ownerPkBytes ++ receiverPkBytes)` — 32 bytes |
| Value | `longToByteArray(cumulativeTotalDebt)` — 8 bytes |
| Flags | InsertOnly |
| Key size | 32 bytes |

Each `/tracker/deploy` creates a fresh single-entry tree. The tracker box is only used as a data input (never spent by the redemption tx).

**Tracker lifecycle**: Tracked in `TrackerDeployment` model. Each deploy supersedes the prior one (`isCurrent` flag). The `/api/reserves/redeem` endpoint auto-deploys a new tracker when the current one is stale or missing. Cumulative `totalDebtNanoErg` is auto-computed from settlement history.

## Insert vs Update Decision

The contract determines this from context var #7 (`lookupProofOpt`):

| Var #7 present? | Meaning | Tree operation |
|---|---|---|
| No | First redemption for this pair | `.insert()` |
| Yes | Subsequent redemption (key exists) | `.update()` |

The sidecar detects which case applies by checking whether the key exists in the reconstructed PlasmaMap. Agent Tab doesn't need to know — it passes `existingReserveEntries` and the sidecar figures it out.

## Chain Truth vs App Truth

| Data | Chain truth | App truth | Reconciliation |
|---|---|---|---|
| Reserve value | Box value on-chain | `reserve.valueNanoErg` | Updated on reconciliation + refresh |
| Reserve R5 digest | On-chain register | `reserve.avlTreeDigest` | Updated; drift detected pre-redemption |
| Reserve box ID | Current UTXO | `reserve.boxId` | Updated on reconciliation |
| Cumulative redeemed | Reserve R5 tree | Sum of `SettlementEvent.amount` per pair | Must match; verified via digest |
| Cumulative total debt | Tracker R5 tree | `computeCumulativeTrackerDebt()` | Must match `TrackerDeployment.totalDebtNanoErg` |
| Contract version | Reserve box ErgoTree | `reserve.contractVersion` | Derived from `reserveAddress` on refresh |
| Tracker box | On-chain UTXO | `TrackerDeployment.boxId` | Recorded at deploy time |
| Obligation amount | N/A (app-only) | `obligation.currentAmount` | Reduced by reconciliation |

**Rule**: chain state is always authoritative. App state is updated to match chain via reconciliation. Pre-redemption checks detect drift before proof generation.

## Automation Boundary

### Fully automatic (no manual steps)

- Secret file provisioning: auto-created from DB `customer.privateKey` / `provider.privateKey`
- Tracker deployment: auto-triggered when stale or missing, cumulative debt auto-computed
- Pending redemption recovery: auto-run before each `/api/reserves/redeem` call
- Reserve version derivation: auto-derived from `reserveAddress` vs sidecar contract
- Reserve tree proof reconstruction: auto-built from aggregated settlement history
- Insert vs update decision: auto-detected by sidecar from reconstructed PlasmaMap

### Operator-initiated (one call, rest is automatic)

- Redemption: `POST /api/reserves/redeem { reserveId, obligationId }` → everything else follows
- Reserve deployment: mint token + sidecar deploy + register in Agent Tab
- Obligation creation: standard Agent Tab API call

### Still manual

- Increasing obligation debt after settlement (updating `currentAmount`, resetting `settlementStatus`)
- Initial reserve deployment (token minting, sidecar deploy, DB registration)

## What Remains Prototype-Grade

### Private key storage

- Owner and receiver private keys stored as plaintext in Agent Tab DB (`customer.privateKey`, `provider.privateKey`).
- Written to `~/.chaincash-secrets/` as JSON files (mode 0600) at redemption time.
- No key rotation, no HSM, no encrypted storage.
- **Testnet only** — not suitable for production key management.

### Single-pair tracker trees

- Each `/tracker/deploy` creates a tree with one entry, moving the tracker NFT.
- For a reserve with multiple creditors, each pair needs its own tracker deployment.
- The NFT move means only one pair's tracker is "live" at a time on-chain.
- Auto-deploy handles this transparently for sequential redemptions, but concurrent multi-pair redemption is not supported.

### Confirmation handling

- 30-second poll for redemption tx, 2-minute poll for tracker deploy.
- If block time exceeds this, state goes to `pending` and auto-recovers on next call.
- No webhook or event-driven confirmation — relies on polling.

### Denomination

- 1 credit = 1 ERG = 1,000,000,000 nanoERG. Hardcoded `NANO_PER_CREDIT`.
- Float arithmetic for credits. No fixed-point or decimal library.

### Reserve deployment

- Token minting requires `MintToken` utility (AppKit) due to wallet API limitation with many mining boxes.
- Reserve deployment is a multi-step process (mint → sidecar deploy → DB register).
