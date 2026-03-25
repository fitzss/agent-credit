# Demo Narration

Talk track for presenting Agent Credit v0.1.

---

## Opening (~30 seconds)

"This is Agent Credit — a working prototype of programmable credit settlement for agent tool markets. Agents create off-chain IOUs, back them with on-chain reserves on Ergo, and settle them cryptographically. What I'm about to show you is running live against a private Ergo testnet with real on-chain transactions."

---

## Beat 1: The reserve (~30 seconds)

"Here's the reserve — 1 ERG of collateral locked in a Basis smart contract. The contract enforces that only valid debt holders can redeem from it, using Schnorr signatures and AVL tree proofs. No one — not the debtor, not us — can extract funds without a verified debt claim."

*Show: reserve state, value, contract version v2*

## Beat 2: The obligations (~30 seconds)

"Two agents — DataMesh AI and CodeForge AI — are owed money by the same debtor. These are off-chain obligations tracked in Agent Tab. No blockchain transaction needed to create debt."

*Show: two obligations with current amounts*

## Beat 3: Novation (~45 seconds)

"Now watch this: I'm transferring 0.03 credits of debt from DataMesh to CodeForge. This is novation — debt reassignment with debtor consent. No on-chain transaction. It happens instantly."

*Execute transfer, show updated amounts*

"The tracker tree will auto-update with the new debt distribution when either party redeems. The system knows exactly what each creditor is owed."

## Beat 4: Guardrails (~30 seconds)

"The system enforces constraints at every level. Try to reconcile the same transaction twice — blocked. Try to redeem twice from an old v1 reserve — blocked. Tamper with the stored tree digest — detected before any proof is generated."

*Show: duplicate block, v1 block*

## Beat 5: Regression harness (~30 seconds)

"We have 12 automated regression scenarios that verify all guardrails, metadata derivation, and auto-healing behaviors."

*Run: `bash scripts/validate.sh` — show 12/12*

## Beat 6: Live redemption (~1-2 minutes)

"Now the on-chain proof. I'm redeeming CodeForge's debt — including the portion that was just transferred via novation. One API call does everything: provisions signing keys, checks the tracker, builds Schnorr signatures and AVL tree proofs, submits the transaction, and reconciles."

*Execute: `POST /api/reserves/redeem`*

*If complete:* "Done. The reserve decreased, the obligation is settled, and the settlement event is recorded with the on-chain transaction ID."

*If pending:* "The transaction is submitted and in the mempool. On a production network this would confirm within the poll window. Let me trigger recovery..." *Run recover-pending.* "Reconciled. The reserve and app state are now consistent."

## Beat 7: Chain consistency (~15 seconds)

"Final check: the app says the reserve has X ERG. The blockchain says the same. These always match — reconciliation is chain-verified."

*Show: app value == sidecar chain value*

---

## Closing (~30 seconds)

"What you've seen is the first working implementation of repeatable bilateral credit settlement with novation on Ergo's Basis protocol. Agents can extend credit, settle multiple times with the same counterparty, transfer debt between creditors, and verify everything on-chain — all through a single API call.

This is a prototype. The keys are testnet, the block times are variable, and the amounts are small. But the protocol is real, the proofs are real, and the settlement path works end to end."

---

*Total narrated demo: ~6-8 minutes*
