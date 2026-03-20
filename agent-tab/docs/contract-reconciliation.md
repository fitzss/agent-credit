# Contract Reconciliation: Redemption Plan vs basis.es

This note checks every claim in the redemption plan against the actual contract
(`contracts/offchain/basis.es`) and test code (`BasisSpec.scala`).

---

## 1. Exact Contract Requirements for Redemption (action == 0)

### Inputs

| Input | Role | Contract reference |
|---|---|---|
| Input containing reserve box | Spent; context vars attached here | basis.es:164-169 — `SELF` is the reserve box, `OUTPUTS(index)` is its recreation |

The reserve box input must carry these **context extension variables**:

| Var | Type | Required | Contract reference | What the contract does with it |
|---|---|---|---|---|
| #0 | Byte | yes | basis.es:164-166 | `action = v / 10` (must be 0), `index = v % 10` (output position of recreated reserve) |
| #1 | GroupElement | yes | basis.es:204 | Receiver pubkey. Also used in `proveDlog(receiver)` at line 292 |
| #2 | Coll[Byte] | yes | basis.es:226 | Reserve owner Schnorr signature (66 bytes). Verified at lines 270-281 |
| #3 | Long | yes | basis.es:216 | Total debt amount. Checked against tracker tree at line 223 |
| #5 | Coll[Byte] | yes | basis.es:286 | AVL insert proof for reserve tree. Used at line 287 |
| #6 | Coll[Byte] | yes | basis.es:250 | Tracker Schnorr signature (66 bytes). Verified at lines 252-263 |
| #7 | Coll[Byte] | **optional** | basis.es:228-234 | Reserve tree lookup proof. If absent, `redeemedDebt = 0L`. Not needed for first redemption. |
| #8 | Coll[Byte] | yes | basis.es:220 | Tracker tree lookup proof. `trackerTree.get(key, proof)` must return `totalDebt` bytes |

**There is NO context var #4.** The contract does not read any timestamp variable.

### Data Inputs

| DataInput | Role | Contract reference |
|---|---|---|
| DataInput[0] | Tracker box | basis.es:194 |

Tracker box must contain:

| Field | Requirement | Contract reference |
|---|---|---|
| `tokens(0)._1` | Must equal `SELF.R6[Coll[Byte]].get` (tracker NFT ID) | basis.es:195, 201 |
| `R4[GroupElement]` | Tracker's public key — used for Schnorr sig verification | basis.es:197, 259, 263 |
| `R5[AvlTree]` | AVL tree containing `hash(ownerPk\|\|receiverPk) → totalDebt` | basis.es:196, 221 |
| `creationInfo._1` | Creation height — used for emergency timing check | basis.es:239-240 |

### Outputs

| Output | Role | Contract reference |
|---|---|---|
| `OUTPUTS(index)` | Recreated reserve box (value reduced) | basis.es:169, 266, 289, 295 |
| Additional outputs | Redemption payout, fees, change — not constrained by contract | N/A |

Recreated reserve box must satisfy `selfPreserved` (basis.es:172-176):

| Check | Requirement |
|---|---|
| `propositionBytes` | Same contract bytes as input |
| `tokens` | Same tokens (singleton reserve token) |
| `R4[GroupElement]` | Same owner pubkey |
| `R6[Coll[Byte]]` | Same tracker NFT ID |
| `R5[AvlTree]` | Updated tree: `SELF.R5.insert(Coll((key, longToByteArray(newRedeemed))), insertProof)` (basis.es:287-289) |
| `value` | Reduced by redeemed amount: `SELF.value - selfOut.value > 0` and `<= debtDelta` (basis.es:266-268) |

### Receiver signature

The contract returns `sigmaProp(... && receiverCondition)` where `receiverCondition = proveDlog(receiver)` (basis.es:292, 301). This means the **receiver must sign the transaction** with the private key corresponding to the GroupElement in context var #1.

---

## 2. Schema Reconciliation

### Tracker tree

| Property | basis.md (docs) | basis.es (contract) | BasisSpec (test) |
|---|---|---|---|
| Key | `hash(A_pubkey \|\| B_pubkey)` | `blake2b256(ownerKeyBytes ++ receiverBytes)` (line 213) | `Blake2b256(ownerKeyBytes.toArray ++ receiverBytes.toArray)` (line 164) |
| Value | "(amount, timestamp)" | `byteArrayToLong(trackerDebtBytes)` — **Long only** (line 222) | `Longs.toByteArray(totalDebt)` — **Long only** (line 1251) |
| Tree flags | not specified | not specified in contract (implicit from tracker box) | `AvlTreeFlags.InsertOnly` (line 1250) |
| Key size | not specified | 32 bytes (blake2b256 output) | `PlasmaParameters(32, None)` (line 33) |

**Correction**: The docs say `(amount, timestamp)` but the contract reads only a Long (amount). **There is no timestamp in the tracker tree value.** The docs describe a planned/earlier design that was not implemented in basis.es.

### Reserve tree

| Property | basis.md (docs) | basis.es (contract) | BasisSpec (test) |
|---|---|---|---|
| Key | `hash(AB)` | `blake2b256(ownerKeyBytes ++ receiverBytes)` — same key as tracker tree (line 213, 285) | same (line 1213) |
| Value | "timestamp" | `longToByteArray(newRedeemed)` — **cumulative redeemed Long** (line 283-284) | `Longs.toByteArray(redeemedDebt)` — **cumulative redeemed Long** (line 1235) |
| Tree flags | not specified | insert-only (basis.es:287 uses `.insert()`, comment says "todo: insertOrUpdate?") | `AvlTreeFlags.InsertOnly` (line 1232) |

**Correction**: The docs say the reserve tree stores timestamps. The contract stores cumulative redeemed amount (Long). **There is no timestamp in the reserve tree.**

### Important limitation from insert-only tree

The reserve tree uses `InsertOnly` (line 1232, and basis.es:287 uses `.insert()` not `.insertOrUpdate()`). This means:
- First redemption for a (owner, receiver) pair: inserts `key → redeemedAmount` into empty tree. **Works.**
- Second redemption for the same pair: would need `.insertOrUpdate()` or a tree with Update flag. **Will fail** with the current contract because the key already exists and InsertOnly rejects duplicate keys.
- BasisSpec line 1230 acknowledges: "only first redemption per (owner, receiver) pair is supported"

**For our first redemption: this is not a problem.** The reserve R5 starts as an empty tree.

---

## 3. Signature Reconciliation

### Message bytes

| Path | Message | Contract reference | BasisSpec helper |
|---|---|---|---|
| Normal | `blake2b256(ownerPkBytes \|\| receiverPkBytes) \|\| longToByteArray(totalDebt)` | basis.es:246 | `mkMessage` (line 1217): `key ++ Longs.toByteArray(totalDebt)` |
| Emergency (3+ days) | `blake2b256(ownerPkBytes \|\| receiverPkBytes) \|\| longToByteArray(totalDebt) \|\| longToByteArray(0L)` | basis.es:244 | `mkEmergencyMessage` (line 1221): `key ++ Longs.toByteArray(totalDebt) ++ Longs.toByteArray(0L)` |

Note: `key` is 32 bytes (blake2b256 output). `longToByteArray(totalDebt)` is 8 bytes. Normal message is 40 bytes. Emergency message is 48 bytes.

The message does NOT include any timestamp. The previous plan was correct on this point.

### Reserve owner signature

- **Scheme**: Schnorr over secp256k1
- **Signer**: private key corresponding to `SELF.R4[GroupElement]` (reserve owner = customer pubkey)
- **Format**: 66 bytes: `GroupElementSerializer.toBytes(a)` (33 bytes, compressed point) + `z.toByteArray` (up to 33 bytes, BigInt)
- **Verification** (basis.es:276-281):
  ```
  e = blake2b256(reserveABytes ++ message ++ ownerKey.getEncoded)
  g^z == reserveA * ownerKey^e
  ```
- **SigUtils.scala** (line 28-29): `e = Blake2b256(a.getEncoded ++ msg ++ pk.getEncoded)`, `z = (r + secretKey * BigInt(e)) % groupOrder`
- **Retry condition** (SigUtils line 31-34): `z.bitLength <= 255` — if z is too large, re-sign. This is because `byteArrayToBigInt` in ErgoScript reads a signed BigInt, and z must be positive and fit in 255 bits.

### Tracker signature

- **Identical scheme and format** to reserve owner signature
- **Signer**: private key corresponding to `tracker.R4[GroupElement]` (tracker pubkey)
- **Same message** as reserve owner signature
- **Verification** (basis.es:259-263):
  ```
  e = blake2b256(trackerABytes ++ message ++ trackerPubKey.getEncoded)
  g^z == trackerA * trackerPubKey^e
  ```

### Receiver proveDlog

- The receiver's GroupElement is passed as context var #1
- The contract evaluates `proveDlog(receiver)` (basis.es:292)
- This means the **transaction itself** must be signed by the receiver's private key
- In BasisSpec line 251: `Array[String](receiverSecret.toString())` is passed to `createTx` as the dLog secret
- The receiver is ToolSmith AI (creditor). Its private key (`aff29ad7...`) must be used to sign the **transaction**, not a message.

### Current ECDSA signatures vs required Schnorr signatures

| Property | Agent Tab ECDSA | Basis contract Schnorr |
|---|---|---|
| Curve | secp256k1 | secp256k1 (same) |
| Signature size | 64 bytes (compact r,s) | 66 bytes (33-byte point a + up to 33-byte scalar z) |
| Message | UTF-8 canonical string, hashed by library | Raw bytes: `key \|\| longToByteArray(totalDebt)` |
| Hash function | SHA-256 (internal to ECDSA) | Blake2b256 (explicit Fiat-Shamir challenge) |
| Verification | `r,s` against public key | `g^z == a * pk^e` |
| On-chain usable | **No** | **Yes** |

**Verdict**: Agent Tab ECDSA signatures are purely tracker-layer evidence. They cannot be used for on-chain redemption. New Schnorr signatures must be generated for each redemption attempt.

---

## 4. Fee and Payout Reconciliation

### Contract enforcement

The contract at basis.es:266-268:
```ergo
val redeemed = SELF.value - selfOut.value
val debtDelta = (totalDebt - redeemedDebt)
val properlyRedeemed = (redeemed > 0) && (redeemed <= debtDelta) && properTrackerSignature
```

**The contract enforces NO fee.** It only checks `redeemed > 0` and `redeemed <= debtDelta`. You can redeem any amount from 1 nanoERG up to `totalDebt - redeemedDebt`.

### Where does the 2% fee come from?

- `BasisDeployer.scala:181`: `REDEMPTION_FEE_PERCENTAGE = 2` — this is an **app-layer constant**, not enforced by the contract
- `contracts/onchain/reserve.es:53-54`: The **on-chain ChainCash reserve** (gold-backed) has a 2% fee **in its contract**. This is a **different contract** from `basis.es`.
- The **Basis offchain reserve** (`basis.es`) has no fee.

### For our first redemption (0.1 credit = 100,000,000 nanoERG)

| Item | Value |
|---|---|
| Gross debt (totalDebt in tracker tree) | 100,000,000 nanoERG |
| Contract-enforced fee | **0** |
| App-layer fee (optional, BasisDeployer convention) | 2,000,000 nanoERG (2%) |
| Net payout to receiver | 100,000,000 nanoERG (if no app-layer fee) or 98,000,000 nanoERG (if fee applied) |
| Reserve value before | 1,000,000,000 nanoERG |
| Reserve value after (no fee) | 900,000,000 nanoERG |
| Reserve value after (with 2% fee kept in reserve) | 902,000,000 nanoERG |

**Recommendation for first test**: Skip the 2% fee. Redeem the full 100,000,000 nanoERG. The contract permits it. The fee is an app-layer convention we can add later.

---

## 5. Timing Reconciliation

### One-week note rule

basis.md line 48-49:
> "A note may be redeemed only one week after creation (timestamp of last block is one week ahead of timestamp in the note, at least)"

**This rule does NOT exist in basis.es.** The contract has no timestamp checking, no note age verification, and no context var for timestamps. The docs describe a planned feature that was not implemented.

### Emergency redemption timing

basis.es:239-240:
```ergo
val trackerUpdateTime = tracker.creationInfo._1
val enoughTimeSpent = (HEIGHT - trackerUpdateTime) > 3 * 720 // 3 days passed
```

- This checks the **tracker box creation height**, not a note timestamp
- If `enoughTimeSpent` is true: message format changes to include `|| 0L` suffix
- The README says "7 days" but the contract says `3 * 720` blocks = **3 days** (at ~2 min/block)
- **Both signatures are still required** even in emergency mode (BasisSpec line 408-410 confirms this — invalid tracker sig still fails even with old tracker)

### Is our 0.1 obligation immediately redeemable?

**Yes.** The contract has no waiting period for normal redemption. The only timing-related logic is the emergency message format change after 3 days, which affects how signatures are constructed (normal vs emergency message). Since our tracker box will be freshly created (well within 3 days), we use the **normal message format**.

### What determines normal vs emergency?

The tracker box's `creationInfo._1` (creation height). If the current blockchain HEIGHT minus the tracker box creation height exceeds 2160 blocks (~3 days), the emergency message format is used. Since we'll deploy the tracker box right before attempting redemption, this will be the normal path.

---

## 6. Verdict

### Confirmed from the redemption plan

- Transaction structure: reserve input + tracker data input + recreated reserve output + redemption payout output ✓
- Context vars #0, #1, #2, #3, #5, #6, #8 required ✓ (var #7 optional for first redemption ✓)
- Schnorr signatures required from both reserve owner and tracker ✓
- Receiver must sign the transaction (proveDlog) ✓
- Tracker box must contain NFT matching R6, pubkey in R4, AVL tree in R5 ✓
- Reserve tree starts empty, first redemption inserts key→redeemedAmount ✓
- ECDSA obligation signatures are NOT usable on-chain ✓
- Tracker box can use `sigmaProp(true)` contract (it's only a data input) ✓
- `/tracker/deploy` is the correct first implementation step ✓

### Corrections needed

| Claim in plan | Actual | Source |
|---|---|---|
| "docs describe hash(A++B) → (amount, timestamp)" | Contract uses amount only (Long). No timestamp in either tree. | basis.es:222, 284; BasisSpec:1251, 1235 |
| "README says 2% fee" | The 2% fee is in `onchain/reserve.es` (different contract) and `BasisDeployer.scala` (app convention). `basis.es` enforces no fee. | basis.es:266-268; reserve.es:53-54 |
| "one-week redemption timing rule" | Not in the contract. No note age check exists. | basis.es has no timestamp logic |
| Plan didn't mention: insert-only tree limitation | Reserve tree is InsertOnly. Only one redemption per (owner, receiver) pair is supported. Second redemption for same pair will fail. | basis.es:287 comment; BasisSpec:1230 |
| Plan didn't mention: z.bitLength ≤ 255 retry | SigUtils.sign retries if z is too large for ErgoScript's byteArrayToBigInt. Must implement same retry logic. | SigUtils.scala:31-34 |
| Plan didn't mention: receiver signs the TX | Receiver private key is needed to sign the actual Ergo transaction (proveDlog), not just provide a context var. | basis.es:292; BasisSpec:251 |

### Is /tracker/deploy still the best first step?

**Yes.** The dependency chain is strict:

1. **Tracker box must exist on-chain first** — the redemption tx reads it as `CONTEXT.dataInputs(0)`
2. The tracker box must contain a valid AVL tree with the debt entry
3. The tracker's Schnorr keypair must be generated before the tree can be built (tracker signs the message)
4. Only after the tracker box is deployed can we construct the redemption tx

The tracker box is the single blocking dependency. Everything else (signatures, proofs, tx construction) can be built after it exists.

### Strict build order (corrected)

1. Generate tracker Schnorr keypair (BigInt secret on secp256k1)
2. Build tracker AVL tree: insert `blake2b256(ownerPk || receiverPk) → longToByteArray(100000000)` — extract tree ErgoValue + lookup proof bytes
3. Deploy tracker box on-chain: tracker NFT + R4=trackerPk(GroupElement) + R5=tree(AvlTree), contract=`sigmaProp(true)`, min value
4. Generate Schnorr signatures: both reserve owner and tracker sign `key || longToByteArray(100000000)` with z.bitLength ≤ 255 retry
5. Build reserve insertion proof: insert `key → longToByteArray(100000000)` into empty PlasmaMap
6. Construct redemption tx: reserve input (with all context vars) + tracker data input + recreated reserve output (updated R5, reduced value) + payout output (100,000,000 nanoERG to receiver address)
7. Sign tx with receiver's private key (ToolSmith AI: `aff29ad7...`)
8. Submit

---

## Source Index

| Reference | Location |
|---|---|
| Basis contract (authoritative) | `chaincash/contracts/offchain/basis.es` |
| Basis docs (partially outdated) | `chaincash/contracts/offchain/basis.md` |
| First passing redemption test | `BasisSpec.scala:153-256` |
| Emergency redemption test | `BasisSpec.scala:314-421` |
| Schnorr signing | `SigUtils.scala:21-36` |
| Schnorr verification | `SigUtils.scala:46-53` |
| Helper: mkMessage (normal) | `BasisSpec.scala:1217-1218` |
| Helper: mkEmergencyMessage | `BasisSpec.scala:1221-1222` |
| Helper: mkTrackerTreeAndProof | `BasisSpec.scala:1249-1254` |
| Helper: mkTreeAndProof (reserve) | `BasisSpec.scala:1231-1237` |
| 2% fee constant (app-layer only) | `BasisDeployer.scala:180-181` |
| On-chain ChainCash 2% fee (different contract) | `contracts/onchain/reserve.es:53-54` |
