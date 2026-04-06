# Agent Credit

**Agent Credit is a governed commercial operating layer for software agents.**

It allows agents to **incur obligations now under bounded delegated authority**, while operators manage authority, visibility, and settlement from a reserve-scoped product surface. Debt accumulates **off-chain**; settlement happens later against **on-chain reserve-backed collateral** on [Ergo](https://ergoplatform.org) via [ChainCash/Basis](https://www.ergoforum.org/t/basis-a-foundational-on-chain-reserve-approach-to-support-a-variety-of-offchain-protocols/5153).

This project is **obligation-first, not payment-first**. It is not a bot wallet, not a checkout abstraction, and not a generic billing dashboard. The core primitive is a governed commercial obligation: an agent is allowed to act within explicit bounds, tracker state witnesses the resulting debt, and the system settles later with real cryptographic recourse.

**Reviewer start here: [`docs/milestone-summary.md`](docs/milestone-summary.md)** | **Whitepaper: [`Agent_Credit_Whitepaper.md`](Agent_Credit_Whitepaper.md)**

---

## Why this exists

Most agent payment systems force one of three models:

1. **Prepaid balance** — capital parked in advance, balances fragment across providers, workflows fail when one silo runs dry
2. **Approval at spend time** — a human approves each action, autonomy breaks exactly where useful work begins
3. **Custodial platform ledger** — a platform smooths the UX, but the commercial object collapses into its internal ledger

Agent Credit takes a different approach:

- Agents create **obligations**, not just payments
- Authority is **delegated with explicit bounds** (scope, cap, expiry)
- Debt is tracked **off-chain** with witnessed tracker state
- Settlement happens later against **reserve-backed on-chain collateral**

---

## What is live today

- Reserve-backed settlement is live
- Bounded delegated authority is live
- Single-pool operator control surface is live
- Positive and negative authority behavior is proof-backed
- Settlement substrate is proof-backed (28 automated checks)

## Proof stack

```bash
cd agent-tab && bash scripts/prove.sh
```

| Suite | Checks | What it proves |
|---|---|---|
| Settlement substrate | 12 | On-chain redemption, recovery, drift, transfers, duplicates |
| Authority loop (positive) | 9 | Agent-bound delegation → proxy call → agent binding persisted → spend cap decrements |
| Authority guardrails (negative) | 18 | Wrong scope / expired / exceeded cap / revoked / wrong agent / cross-delegation — all rejected without mutation |

**39/39 = system verified.**

## Repository map

```
agent-tab/          Product layer: UI, APIs, obligations, delegations, proof scripts
  src/app/pool/     Single-pool operator dashboard
  src/app/api/      App-layer routes (reserves, proxy, delegations, debt transfer)
  src/lib/          Business logic, crypto, tracker/reconcile utilities
  scripts/          Proof stack, validation harness, demo fixtures
  prisma/           SQLite schema

chaincash/          Chain execution layer: Ergo tx building, Schnorr/AVL proofs
  src/.../sidecar/  HTTP sidecar server (JVM/Scala)
  contracts/        Basis reserve contract (ErgoScript)

docs/               Reviewer and operator documentation
  milestone-summary.md    What is proven, what is not, quickstart
  operator-demo-plan.md   Demo day sequence, proof stack, troubleshooting
  fixture-reuse-note.md   What persists, what drifts, when to restore
  glossary.md             Key terms defined
  repo-map.md             Detailed repository guide
```

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Agent Tab     │  HTTP   │  ChainCash       │  Ergo   │  Ergo Private   │
│   (Next.js)     │────────>│  Sidecar (JVM)   │────────>│  Testnet Node   │
│                 │         │                  │         │                 │
│  - Pool UI      │         │  - Schnorr sigs  │         │  - Reserve UTXO │
│  - Obligations  │         │  - AVL proofs    │         │  - Tracker UTXO │
│  - Delegations  │         │  - Tx building   │         │  - Blockchain   │
│  - Settlements  │         │  - Contract comp │         │                 │
│  - Reconcile    │         │                  │         │                 │
└─────────────────┘         └──────────────────┘         └─────────────────┘
     Port 3000                   Port 8081                    Port 9052
```

**Agent Tab** — app state, operator UI, authority management, reconciliation.
**Sidecar** — chain execution: Schnorr signing, AVL proofs, tx construction.
**Ergo Node** — blockchain: UTXO set, wallet, mining.

## What is built

- On-chain settlement with Schnorr + AVL proofs
- Single-pool operator dashboard (`/pool/[id]`): reserve health, obligation readiness, tracker state, settlement history
- Agent-bound delegated authority: delegations bind to specific agents with scope, spend cap, expiry
- Authority visibility: compliance badges, utilization bars, agent labels, authority mode
- Novation (debt transfer between creditors)
- Pending recovery, drift detection, contract versioning
- Isolated private testnet with reproducible demo fixture
- 39-check proof stack covering positive paths, negative paths, and agent-binding enforcement

## Quick start

```bash
# Terminal 1: Ergo node
cd ~/ergo && java -jar ergo-5.0.14.jar --testnet -c ergo.conf
# Unlock wallet after ~15s:
curl -X POST http://localhost:9052/wallet/unlock \
  -H "api_key: hello" -H "Content-Type: application/json" -d '{"pass":"hello"}'

# Terminal 2: Sidecar
cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"

# Terminal 3: Agent Tab
cd agent-tab && DEMO_MODE=true npx next dev -p 3000

# Verify
cd agent-tab && bash scripts/prove.sh
```

Open `http://localhost:3000/pool` for the operator dashboard.

## Documentation

| Document | Purpose |
|---|---|
| [`Agent_Credit_Whitepaper.md`](Agent_Credit_Whitepaper.md) | **Whitepaper.** Obligation-first thesis, authority model, settlement architecture. |
| [`docs/milestone-summary.md`](docs/milestone-summary.md) | **Start here.** What is proven, what is not, reviewer quickstart. |
| [`docs/operator-demo-plan.md`](docs/operator-demo-plan.md) | Demo sequence, proof stack, troubleshooting |
| [`docs/glossary.md`](docs/glossary.md) | Key terms: delegation, obligation, reserve, pool, novation, etc. |
| [`docs/repo-map.md`](docs/repo-map.md) | Detailed repository structure guide |
| [`docs/fixture-reuse-note.md`](docs/fixture-reuse-note.md) | What persists across reboots, when to restore |

## Known limitations

| Area | Limitation |
|---|---|
| Confirmation latency | Private testnet block times vary. Redemption may return `pending` — auto-recoverable. |
| Credit precision | Obligations use Float; chain uses BigInt nanoERG. Exact at current scale, not infinite precision. |
| Key storage | Plaintext in SQLite + `~/.chaincash-secrets/`. Testnet-only; production needs HSM/encryption. |
| Concurrency | Single-tracker-NFT model. Sequential operation reliable; concurrent updates would conflict (UTXO contention). |
| Deployment | Isolated private testnet only. Not deployed to public testnet or mainnet. |
