# Agent Tab -> Basis Compatibility Mapping

Internal specification. Defines exactly how Agent Tab off-chain obligation
state maps to the Basis on-chain reserve contract for redemption.

## Status

Draft. Covers the first minimal redeemable implementation only.

---

## 1. Identity Model

### Root Identity Rule

For a reserve-backed self-custody customer, all three of these MUST be the
same compressed secp256k1 public key:

| Role | Agent Tab Field | Basis On-Chain Location |
|---|---|---|
| **Debtor** | `ObligationState.debtorPubKey` | Reserve R4 (GroupElement) |
| **Reserve Owner** | `Reserve.debtorPubKey` | Reserve R4 (GroupElement) |
| **Customer** | `Customer.publicKey` | (not stored on-chain) |

If these three do not match, the obligation is **not redeemable** under this
model. Agent Tab should mark such obligations explicitly.

### Creditor Identity

| Role | Agent Tab Field | Basis On-Chain Location |
|---|---|---|
| **Creditor** | `ObligationState.creditorPubKey` | Redemption context var #1 (receiver) |

The creditor (provider) public key in Agent Tab is the same key that would
be used as the "receiver" in a Basis redemption transaction.

### Delegated / Session Keys

Delegated session keys are **Agent Tab only**. They do not appear on-chain.

Authority chain:
```
Root debtor key (Customer.publicKey)
  └── signs delegation auth message
        └── session key (Delegation.sessionPubKey)
              └── signs individual obligation updates
```

For redemption purposes, only the root debtor key matters. The Basis
contract requires a Schnorr signature from the reserve owner key (R4),
which must be the root key.

A delegated obligation update is committed by the tracker after verifying:
1. The delegation auth was signed by the root key
2. The session key signature is valid for the canonical message
3. The delegation scope and spend cap are satisfied

The tracker then treats the update as equivalent to a root-signed update
for state tracking purposes. However:

**Delegated updates are signed by session keys, not the root key.**

This means `ObligationUpdate.signature` for a delegated update cannot be
directly used as a Basis redemption proof. Only the tracker's aggregate
commitment (AVL tree entry) is authoritative for redemption. The individual
ECDSA signatures are evidence for the tracker, not for the contract.

### Tracker Identity

| Role | Agent Tab Field | Basis On-Chain Location |
|---|---|---|
| **Tracker** | (implicit — the app itself) | Tracker NFT ID in reserve R6 |
| **Tracker signing key** | (not yet implemented) | Tracker box R4 (GroupElement) |

The tracker must have its own secp256k1 keypair for Schnorr signing
during redemption. This key is identified on-chain by the tracker NFT:
the token whose ID is stored in the reserve's R6 register. The tracker
box holding that NFT has the tracker's signing key in its own R4.

**Current gap:** Agent Tab does not yet have a tracker signing key or
tracker box. This is required for redemption.

---

## 2. Note / Obligation Model

### Agent Tab Obligation

One `ObligationState` per (debtor, creditor) pair:

```
noteId:           UUID
debtorPubKey:     hex string (33 bytes compressed)
creditorPubKey:   hex string (33 bytes compressed)
currentAmount:    Float (cumulative committed debt in credits)
pendingAmount:    Float (proposed but unsigned debt)
version:          Int (monotonically increasing)
```

### Basis AVL Tree Entry

The tracker commits aggregate debt into an on-chain AVL tree:

```
key:   blake2b256(debtorPubKeyBytes ++ creditorPubKeyBytes)
value: longToByteArray(totalDebt)
```

Where `totalDebt` is a Long representing the cumulative debt amount.

### Mapping

| Agent Tab | Basis Tree | Notes |
|---|---|---|
| `debtorPubKey` | first 33 bytes of hash input | Same raw bytes |
| `creditorPubKey` | second 33 bytes of hash input | Same raw bytes |
| `currentAmount` | `totalDebt` (Long) | Requires denomination conversion (see section 5) |
| `pendingAmount` | not represented | Only committed debt is redeemable |
| `version` | not represented | Basis uses cumulative amounts, not versions |

**Only `currentAmount` (committed, signed debt) is redeemable.** Pending
debt has no cryptographic backing and is excluded from the tracker tree.

---

## 3. Canonical Message and Signature

### Agent Tab Canonical Message

```
agentab:v1|<debtorPubKey>|<creditorPubKey>|<amount.toFixed(8)>|<version>|<timestamp>
```

Example:
```
agentab:v1|028235...|0292ff...|0.10000000|1|2026-03-20T15:31:54.353Z
```

- Signed with: ECDSA (secp256k1, SHA-256 prehash, compact 64-byte signature)
- Purpose: off-chain proof of debt acknowledgment between debtor and tracker

### Basis Redemption Message

```
blake2b256(debtorKeyBytes ++ creditorKeyBytes) || longToByteArray(totalDebt)
```

- Signed with: Schnorr (secp256k1, 66-byte signature: 33-byte a + 33-byte z)
- Required signatures: BOTH reserve owner AND tracker
- Purpose: on-chain proof authorizing ERG withdrawal

### Relationship

These are **different messages with different signature schemes**. The Agent
Tab canonical message is NOT directly usable in the Basis contract.

For redemption, the tracker must:
1. Read the committed `currentAmount` from its database
2. Convert to the Basis denomination (see section 5)
3. Construct the Basis message format
4. Sign with the tracker's Schnorr key
5. The reserve owner must also Schnorr-sign the same message

The Agent Tab ECDSA signatures serve as the tracker's evidence that the
debtor acknowledged the debt. They are the tracker's authorization to
include that debt in its on-chain commitment tree.

---

## 4. Version and Timestamp

### Agent Tab Versioning

- `version`: monotonically increasing integer per obligation
- `timestamp`: ISO 8601 string, recorded when update is proposed
- Both are included in the canonical message
- Used for optimistic concurrency and ordering

### Basis Versioning

- No explicit version field
- Cumulative amounts are the source of truth
- The tracker's AVL tree stores only the latest cumulative total
- Redemption checks: `redeemAmount <= totalDebt - previouslyRedeemed`

### Mapping

Agent Tab's `version` and `timestamp` have no on-chain equivalent. They
are off-chain ordering guarantees. The Basis contract only cares about:
1. The current cumulative debt (from tracker tree)
2. The cumulative amount already redeemed (from reserve tree)

---

## 5. Denomination

### Current State

**Agent Tab credits are undefined demo units.** There is no defined
exchange rate between Agent Tab credits and ERG.

The collateralization ratio (`totalReserveValue / totalCommittedDebt`) is
currently computed as:

```typescript
totalReserveValue = sum(reserve.valueNanoErg) / 1e9  // converts nanoERG to "ERG"
collateralizationRatio = totalReserveValue / totalDebt  // "ERG per credit"
```

This implicitly treats 1 credit = 1 ERG, but that is an accident of the
demo, not a defined relationship.

### Rule for First Redeemable Implementation

**1 credit = 1 nanoERG** would make amounts too small.
**1 credit = 1 ERG = 1,000,000,000 nanoERG** is the simplest meaningful rule.

For the first implementation:

```
redeemableNanoErg = floor(currentAmount * 1_000_000_000)
```

Where `currentAmount` is the committed debt in credits.

This means:
- 0.10 credits of debt = 100,000,000 nanoERG (0.1 ERG) redeemable
- A 1 ERG reserve with 0.1 credits debt = 10x collateralized
- `longToByteArray(redeemableNanoErg)` is what goes into the Basis tree

**This must be documented explicitly and enforced at the conversion boundary.**

### Basis Tree Value Encoding

```
treeValue = longToByteArray(floor(currentAmount * 1_000_000_000))
```

For 0.10 credits: `longToByteArray(100000000)` = 8 bytes big-endian Long.

---

## 6. Post-Redemption Reconciliation

When a creditor redeems ERG from a reserve:

1. On-chain: reserve's AVL tree (R5) is updated with the new cumulative
   redeemed amount for this (debtor, creditor) pair.
2. The reserve box value decreases by the redeemed amount.
3. Off-chain: Agent Tab must detect and record the redemption.

### Reconciliation Rule

After redemption of X nanoERG:

```
redeemedCredits = X / 1_000_000_000
ObligationState.currentAmount -= redeemedCredits  (create settlement update)
Reserve.valueNanoErg -= X                          (refresh from chain)
```

The tracker should:
1. Monitor the reserve box for changes (via sidecar polling or scan)
2. When `valueNanoErg` decreases, parse the updated R5 tree to determine
   which (debtor, creditor) pair was redeemed
3. Create a settlement-type ObligationUpdate with negative delta
4. Decrease `currentAmount` accordingly

**If the reserve is fully depleted, set `lifecycle = "depleted"`.**

---

## 7. Summary: What Must Match for Redemption

For an obligation to be redeemable against a Basis reserve:

| Check | Condition |
|---|---|
| Same root key | `Customer.publicKey == ObligationState.debtorPubKey == Reserve.debtorPubKey` AND this key matches reserve R4 on-chain |
| Reserve active | `Reserve.lifecycle == "active"` |
| Debt committed | `ObligationState.currentAmount > 0` (not just pending) |
| Signature exists | `ObligationState.latestSignature != null` (evidence for tracker) |
| Denomination defined | Conversion rate explicitly set (1 credit = 1 ERG for v1) |
| Tracker has signing key | Tracker can produce Schnorr signatures (not yet implemented) |
| Sufficient collateral | `Reserve.valueNanoErg >= redeemableNanoErg` |

---

## 8. Current Gaps (Ordered by Blocking Priority)

1. **On-chain R4 key != Agent Tab debtor key** — Reserve was deployed with
   Ergo wallet key, not the customer's signing key. Must redeploy or add
   redeemability check.

2. **Tracker has no Schnorr signing key** — Needed for Basis redemption
   message co-signing. Must generate and persist.

3. **No tracker box on-chain** — The tracker NFT must live in a box with
   the tracker's signing key in R4 and the AVL tree commitment in R5.

4. **Sidecar returns raw typed register values** — Must decode type
   prefixes to extract bare protocol values.

5. **No denomination constant defined** — The 1 credit = 1 ERG rule must
   be codified, not implicit.

6. **No redemption transaction builder** — Must construct Basis action=0
   transactions with correct context variables.

7. **No post-redemption reconciliation** — Must detect on-chain redemptions
   and update off-chain state.
