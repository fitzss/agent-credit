# Agent Credit

Programmable credit settlement for agent tool markets, built on [ChainCash/Basis](https://www.ergoforum.org/t/basis-a-foundational-on-chain-reserve-approach-to-support-a-variety-of-offchain-protocols/5153) and Ergo.

## What this system does

Agents create off-chain credit obligations (IOU notes), back them with on-chain ERG reserves, and settle them via cryptographically verified on-chain redemption. Debt can be transferred between creditors (novation) without touching the reserve contract.

## Supported capabilities

| Capability | Status | Verified |
|---|---|---|
| Off-chain credit/obligation creation | Live | DB + API |
| On-chain reserve deployment (v2 contract) | Live | Testnet tx confirmed |
| One-shot redemption (first pair) | Live | Testnet tx `d74483eb` |
| Repeated same-pair redemption | Live | Testnet tx `0b9bc813` |
| Multi-pair tracker trees | Live | Testnet tx `d7d72289` |
| Debt transfer / novation | Live | Testnet tx `3af032e7`, `0cece37f` |
| Automatic tracker deployment | Live | Auto-triggered on stale/missing |
| Secret file auto-provisioning | Live | From DB keys at redemption time |
| Pending redemption recovery | Live | Auto-recovered on next call |
| Chain-verified reconciliation (8 guardrails) | Live | Validated by harness |
| R5 digest drift detection (2 layers) | Live | Validated by harness |
| Reserve contract version tracking (v1/v2) | Live | Auto-derived from chain |
| Regression harness (12 scenarios) | Passing | `scripts/validate.sh` |

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Agent Tab     │  HTTP   │  ChainCash       │  Ergo   │  Ergo Private   │
│   (Next.js)     │────────>│  Sidecar (JVM)   │────────>│  Testnet Node   │
│                 │         │                  │         │                 │
│  - Obligations  │         │  - Schnorr sigs  │         │  - Reserve UTXO │
│  - Settlements  │         │  - AVL proofs    │         │  - Tracker UTXO │
│  - Transfers    │         │  - Tx building   │         │  - Blockchain   │
│  - Tracker state│         │  - Contract comp │         │                 │
│  - Reconcile    │         │                  │         │                 │
└─────────────────┘         └──────────────────┘         └─────────────────┘
     Port 3000                   Port 8081                    Port 9052
```

**Agent Tab** owns app state (obligations, settlements, tracker lifecycle, reconciliation).
**Sidecar** owns chain execution (Schnorr signing, AVL tree proofs, tx construction via AppKit).
**Ergo Node** is the blockchain layer (UTXO set, wallet, mining).

## Main entrypoints

### Agent Tab API (port 3000)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/reserves` | GET | List reserves |
| `/api/reserves` | POST | Deploy new reserve |
| `/api/reserves` | PATCH | Refresh reserve from chain |
| `/api/reserves/redeem` | POST | **One-shot: redeem + reconcile** |
| `/api/reserves/recover-pending` | POST | Recover pending redemptions |
| `/api/reserves/reconcile-redemption` | POST | Standalone reconciliation |
| `/api/debt/transfer` | POST | **Novation: transfer debt between creditors** |
| `/api/tracker/deploy` | POST | Deploy tracker for a pair |

### Sidecar API (port 8081)

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Service health + contract address |
| `/reserve/build-and-submit` | POST | Deploy reserve box on-chain |
| `/reserve/redeem` | POST | Build + submit redemption tx |
| `/reserve/status` | GET | Live reserve state from chain |
| `/tracker/deploy` | POST | Single-entry tracker deployment |
| `/tracker/update` | POST | Multi-entry tracker deployment |
| `/nft/mint` | POST | Mint singleton tokens |

## Quick start

```bash
# Prerequisites: Ergo private testnet node on :9052 (wallet unlocked)

# Start sidecar
cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"

# Start Agent Tab (normal mode: 30s redemption poll, 2min tracker poll)
cd agent-tab && npm install && npx next dev -p 3000

# Start Agent Tab (demo mode: 3min redemption poll, 6min tracker poll)
cd agent-tab && DEMO_MODE=true npx next dev -p 3000

# Run validation harness
cd agent-tab && bash scripts/validate.sh
```

### Environment variables

| Variable | Default | Demo mode | Purpose |
|---|---|---|---|
| `DEMO_MODE` | `false` | `true` | Enables longer confirmation polling windows |
| `SIDECAR_URL` | `http://localhost:8081` | — | Sidecar endpoint |
| `ERGO_NODE_API_KEY` | `hello` | — | Ergo node wallet API key |

## Current milestone

**Tag: `milestone-v0.1-settlement`** — Repeatable bilateral credit settlement with novation.

This milestone represents a complete prototype of the off-chain credit → on-chain settlement path:

- **20 commits** from initial reserve setup through novation
- **9+ on-chain redemption transactions** confirmed on Ergo private testnet
- **3 debt transfers** (novation) executed and verified
- **12/12 regression scenarios** passing in automated harness
- **0.66+ ERG total redeemed** across multiple creditor pairs from a single 1.0 ERG reserve

### Recommended demo path

For the smoothest demo experience:

1. Start with `DEMO_MODE=true` for longer confirmation windows
2. Show system state: reserves, obligations, tracker entries
3. Execute a novation (instant — no chain interaction)
4. Show guardrails: duplicate block, v1 repeat block, drift detection
5. Run the regression harness (12/12 in ~2 minutes)
6. Pre-deploy the tracker for the pair you plan to redeem (reduces redemption wait)
7. Execute a redemption — if pending, recover with `/recover-pending`
8. Verify app/chain consistency

Steps 1-5 take ~3 minutes and demonstrate the full feature set without chain waiting. Steps 6-8 add the live on-chain proof (~2-5 minutes depending on block times).

### What is proven live vs tested by harness

| Layer | Proven | Method |
|---|---|---|
| Basis contract (insert + update) | On-chain | BasisSpec (27 tests) + live testnet txs |
| Schnorr signatures + AVL proofs | On-chain | Live redemption txs |
| Multi-entry tracker trees | On-chain | Live multi-pair redemption |
| Novation (debt transfer) | App + chain | Transfer → auto-tracker-update → redemption |
| Reconciliation guardrails | App | Automated harness (12/12) |
| Drift detection | App | Automated harness |
| Contract version derivation | App + sidecar | Automated harness |
| Pending recovery | App + chain | Live testnet sessions |

## Documentation

| Document | Location | Purpose |
|---|---|---|
| **Reviewer Brief** | `agent-tab/docs/reviewer-brief.md` | Concise overview for external reviewers |
| **Demo Checklist** | `agent-tab/docs/demo-checklist.md` | Pre-flight + execution checklist |
| **Demo Narration** | `agent-tab/docs/demo-narration.md` | Talk track with 7 beats (~6-8 min) |
| **Demo Walkthrough** | `agent-tab/docs/demo-walkthrough.md` | Detailed step-by-step commands |
| **V2 Runbook** | `agent-tab/docs/v2-runbook.md` | Operator guide for the repeatable settlement path |
| **Architecture Notes** | `agent-tab/docs/architecture-notes.md` | Semantics, invariants, chain vs app truth |
| **Smoke Test** | `agent-tab/docs/smoke-test.md` | 7-step scriptable verification |
| **Validation Matrix** | `agent-tab/docs/validation-matrix.md` | 13 regression scenarios |
| **Validation Harness** | `agent-tab/scripts/validate.sh` | Executable: 12 automated checks |
| **Contract Reconciliation** | `agent-tab/docs/contract-reconciliation.md` | Line-by-line contract verification |

## Known limitations

### Confirmation latency
The private testnet mines blocks at variable intervals. The redemption flow polls for 30 seconds; tracker deploy polls for 2 minutes. When blocks are slow, the flow returns `phase: "pending"` and the operator must retry or call `/recover-pending`. No data is lost — the `PendingRedemption` record ensures automatic recovery on the next attempt.

### Float credit amounts
Obligation amounts use `Float` (e.g., `0.1` credits). The chain boundary uses `BigInt` nanoERG (e.g., `100000000`). The `NANO_PER_CREDIT = 1,000,000,000` conversion is exact for the current precision range, but extended use with many small transfers could accumulate rounding. The `DebtTransfer` model stores both Float credits and BigInt nanoERG for audit.

### Chain-dependent test automation
The regression harness (`validate.sh`) covers 12 guardrail and metadata scenarios that run instantly. The 7 chain-dependent scenarios (redemption, repeated redemption, multi-pair, novation, pending recovery, auto-deploy) are verified via prior testnet sessions with confirmed tx IDs in the git history. Fully automated chain-dependent testing would require a block-mining trigger or mock infrastructure.

### Private key storage
Owner/receiver keys are stored as plaintext in the Agent Tab SQLite DB and written to `~/.chaincash-secrets/` as JSON files (mode 0600). Tracker secrets are auto-created by the sidecar. This is testnet-only — production would require HSM or encrypted storage.

### Single-tracker-NFT model
All pairs under one reserve share a single tracker NFT. Each tracker update moves the NFT to a new box. Multi-pair trees work correctly but concurrent updates to different pairs would conflict (UTXO contention). Sequential operation is reliable.
