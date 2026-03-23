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

The tree stores cumulative redeemed amounts, not individual redemption events. After two redemptions of 200M and 150M for the same pair, the tree value is 350M (not two separate entries).

## Tracker Tree (R5) Semantics

| Property | Value |
|---|---|
| Key | `blake2b256(ownerPkBytes ++ receiverPkBytes)` — 32 bytes |
| Value | `longToByteArray(cumulativeTotalDebt)` — 8 bytes |
| Flags | InsertOnly |
| Key size | 32 bytes |

The tracker tree commits to the total debt. Each `/tracker/deploy` creates a fresh tree with a single entry. The tracker box is only used as a data input (never spent by the redemption tx).

**Current limitation**: each `/tracker/deploy` creates a tree with one entry. For a multi-pair reserve, each pair needs its own tracker deployment. The tracker NFT moves to the new box each time, losing the previous pair's entry.

## Insert vs Update Decision

The contract determines this from context var #7 (`lookupProofOpt`):

| Var #7 present? | Meaning | Tree operation |
|---|---|---|
| No | First redemption for this pair | `.insert()` |
| Yes | Subsequent redemption (key exists) | `.update()` |

The sidecar detects which case applies by checking whether the key exists in the reconstructed PlasmaMap. Agent Tab doesn't need to know — it just passes `existingReserveEntries` and the sidecar figures it out.

## Chain Truth vs App Truth

| Data | Chain truth | App truth | Reconciliation |
|---|---|---|---|
| Reserve value (nanoERG) | Box value on-chain | `reserve.valueNanoErg` | Updated on reconciliation + refresh |
| Reserve R5 digest | On-chain register | `reserve.avlTreeDigest` | Updated on reconciliation + refresh |
| Reserve box ID | Current UTXO | `reserve.boxId` | Updated on reconciliation |
| Cumulative redeemed per pair | In reserve R5 tree | Sum of `SettlementEvent.amount` | Must match; drift detected pre-redemption |
| Cumulative total debt per pair | In tracker R5 tree | `computeCumulativeTrackerDebt()` | Must match tracker deploy value |
| Contract version | Reserve box ErgoTree | `reserve.contractVersion` | Derived from `reserveAddress` on refresh |
| Obligation current amount | N/A (app-only) | `obligation.currentAmount` | Reduced by reconciliation |

**Rule**: chain state is always authoritative. App state is updated to match chain via reconciliation. Pre-redemption checks detect drift before proof generation.

## What Remains Prototype-Grade

### Tracker lifecycle

- No Agent Tab DB model for tracker boxes. Discovery is dynamic (scan chain for NFT).
- Each `/tracker/deploy` creates a fresh single-entry tree, discarding the previous pair's entry.
- Tracker keypair is regenerated each deploy. Old tracker signatures for the same pair become invalid if the tracker box is redeployed.
- No multi-pair tracker tree support.

### Obligation-tracker alignment

- Agent Tab obligations use `currentAmount` (unredeemed balance). The tracker tree uses cumulative `totalDebt`. The mapping between these is computed at redemption time, not maintained as a persistent invariant.
- Increasing debt for a second redemption requires: (1) updating `obligation.currentAmount`, (2) deploying a new tracker with the updated cumulative totalDebt. These are manual steps.

### Secret management

- Owner and receiver private keys must be pre-written to `~/.chaincash-secrets/` as JSON files (mode 600).
- Tracker secret is auto-created by `/tracker/deploy`.
- No key rotation, no HSM integration, no encrypted storage.
- Testnet only — not suitable for production key management.

### Reserve deployment

- V2 reserve deployment requires `MintToken` utility (AppKit-based) because the wallet API can't reliably mint tokens with 500+ boxes.
- `reserveAddress` must be set on the reserve record for version derivation to work. The standard `/api/reserves` POST flow does this automatically, but manually created reserves need backfill.

### Confirmation handling

- 30-second poll window. If block time exceeds this, redemption goes to `pending` status.
- Recovery is automatic on next `/api/reserves/redeem` call or via `/recover-pending`.
- No webhook or event-driven confirmation — relies on polling.

### Denomination

- 1 credit = 1 ERG = 1,000,000,000 nanoERG. Hardcoded constant `NANO_PER_CREDIT`.
- Float arithmetic for credits. No fixed-point or decimal library.
