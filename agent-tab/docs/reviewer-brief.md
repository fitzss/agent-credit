# Reviewer Brief: Agent Credit v0.1

## What this is

A working prototype of programmable credit settlement for agent economies, built on Ergo's Basis protocol. Agents create off-chain debt (IOU notes), back them with on-chain ERG reserves, and settle via cryptographically verified on-chain redemption. Debt can be transferred between creditors (novation) without touching the blockchain.

## What is proven live

All of the following have been executed on a private Ergo testnet with confirmed on-chain transactions:

- **On-chain redemption**: Schnorr signatures and AVL tree proofs verified by the Basis smart contract. 11+ transactions confirmed.
- **Repeated same-pair redemption**: The same debtor-creditor pair can settle multiple times. The reserve contract uses `.update()` on the AVL tree for subsequent redemptions.
- **Multi-pair tracker trees**: A single tracker box holds debt entries for multiple creditor pairs simultaneously. Redeeming one pair preserves the other's entry.
- **Novation**: Debt transferred from creditor B to creditor C, then both pairs redeemed successfully. 3 transfers executed.
- **Automatic tracker management**: When the tracker tree is stale or missing, the system auto-deploys a new tracker with the correct cumulative debt entries, waits for confirmation, and proceeds.
- **Pending recovery**: When block confirmation is slow, the system persists a recovery record and auto-reconciles on the next call. No data is ever lost.

## What is harness-validated (not requiring chain interaction)

12 regression scenarios run in ~2 minutes via `scripts/validate.sh`:

- Duplicate reconciliation prevention (unique constraint on tx ID)
- V1 contract repeat-redemption block
- R5 digest drift detection (tampered DB vs live chain)
- Secret file auto-provisioning from DB keys
- Transfer guardrails (same debtor, positive amount, sufficient balance, no pending)
- Contract version auto-derivation (v1 vs v2 from on-chain address)

## Why it matters

This is the first working implementation of the Basis off-chain credit protocol with:
1. **Repeatable settlement** — not just one-shot redemption, but unlimited same-pair settlements
2. **Novation** — debt can circulate between creditors without on-chain transactions
3. **Full automation** — one API call (`POST /api/reserves/redeem`) handles secret provisioning, tracker deployment, proof generation, transaction submission, and reconciliation
4. **Chain-verified integrity** — 8 guardrails verify every reconciliation against on-chain state

For agent economies, this means: agents can extend credit, settle repeatedly, and transfer obligations — all backed by cryptographic proof on a real blockchain, with no manual steps beyond the initial API call.

## Top 2 limitations

**1. Block confirmation latency.** The private testnet mines blocks at variable intervals. A full redemption cycle (tracker deploy + confirmation + tx + confirmation) can take 3-8 minutes. The system handles this safely via pending recovery, but a live demo may require patience. The recommended demo path front-loads instant features (novation, guardrails, harness) and defers the chain proof to the end.

**2. Prototype key management.** Private keys are stored in plaintext in the SQLite database and written to local files at redemption time. This is appropriate for testnet but would require HSM or encrypted storage for production.

## Where to start

- **README.md** — system overview, architecture, endpoints
- **agent-tab/docs/demo-walkthrough.md** — step-by-step demo script
- **agent-tab/scripts/validate.sh** — run the regression harness (12/12 in ~2 min)
- **agent-tab/docs/architecture-notes.md** — cumulative debt semantics, chain vs app truth
- **chaincash/contracts/offchain/basis.es** — the Basis smart contract (312 lines of ErgoScript)
