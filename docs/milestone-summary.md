# Milestone Summary — Agent Credit MVP v3

## A. What this is

A working governed agent credit system where:

- A debtor locks ERG as collateral in a Basis smart contract on Ergo
- AI service providers extend credit to that debtor's agents
- Agents operate under bounded delegated authority (scope, spend cap, expiry)
- Settlement happens on-chain with real Schnorr signatures and AVL tree proofs
- An operator manages the full lifecycle from a single pool dashboard

The system runs on an isolated private Ergo testnet. Settlement, authority, and guardrails are all proven with 39 automated regression checks.

## B. What is proven live (39/39 checks)

### Settlement substrate (12 checks)

| What | Status |
|---|---|
| On-chain redemption with Schnorr + AVL proofs | Proven |
| Repeated same-pair redemption | Proven |
| Multi-pair tracker tree preservation | Proven |
| Novation (debt transfer between creditors) | Proven |
| Pending recovery (self-healing from mempool state) | Proven |
| R5 digest drift detection | Proven |
| Duplicate reconciliation blocking | Proven |
| V1/V2 contract version derivation | Proven |
| Transfer guardrails (negative, insufficient, self, cross-debtor) | Proven |
| Secret file auto-provisioning | Proven |

### Positive authority loop (9 checks)

| What | Status |
|---|---|
| Create agent-bound delegation with root-key signature (v2 format) | Proven |
| Proxy call with session key → delegation scope validated | Proven |
| Session-key signing of obligation update | Proven |
| Agent binding persisted on committed ObligationUpdate | Proven |
| Delegation ID persisted on committed ObligationUpdate | Proven |
| Delegation spend cap decrements by exact tool cost | Proven |
| Obligation balance increments by exact delta | Proven |
| Pool dashboard shows bound agent label on delegation | Proven |
| Active delegation count increments correctly | Proven |

### Negative authority guardrails (18 checks)

| What | Status |
|---|---|
| Wrong provider scope → rejected, no mutation | Proven |
| Expired delegation → rejected, no mutation | Proven |
| Exceeded spend cap → rejected, no mutation | Proven |
| Revoked delegation → rejected, no mutation | Proven |
| Wrong agent (agent-002 uses agent-001's delegation) → rejected, no mutation | Proven |
| Foreign-customer agent delegation creation → rejected | Proven |
| Cross-delegation commit (D1 initiates, commit with D2) → rejected, no mutation | Proven |
| Legacy/unbound delegation backward compatibility → accepted, labeled "Unbound" | Proven |

Each negative test asserts both the rejection AND that no commercial state was advanced.

## C. What is prototype-grade / not yet built

### Prototype-grade (works but has rough edges)

| Item | Status | Notes |
|---|---|---|
| Pool dashboard UI | Functional | Dark-theme operator surface. No mobile responsiveness, no loading skeletons. |
| Delegation create/revoke | Functional | Inline on pool detail page. Agent-bound (v2). Root key re-entry each time (correct security model, not polished UX). |
| Authority-demo fixture | Functional | Standalone script. DB-only reserve (not backed by on-chain collateral). |
| Token index fallback | Functional | Address-based lookup works around broken Ergo 5.0.14 token index. |
| Private testnet | Stable | Isolated, mining, but requires manual restart after reboot. |

### Not yet built

| Item | Notes |
|---|---|
| Overview page pool summary | Pool health is only visible on /pool, not the home page |
| Legacy delegation cleanup | Legacy/unbound delegations remain temporarily valid and labeled. No auto-migration or cleanup flow yet. |
| Per-agent spend tracking | UsageEvents and ObligationUpdates record per-agent, but no per-agent cap enforcement |
| Delegation management UI (edit, history, audit) | Only create and revoke. No edit, no audit log. |
| Auto-expiry background job | Expired delegations are caught at runtime, not proactively transitioned |
| Policy rules engine | No auto-pause thresholds, no mandatory-delegation rules |
| Multi-reserve aggregation | Each pool is one reserve. No cross-pool views. |
| Mainnet deployment | Everything runs on isolated private testnet |
| Role-based access control | Single operator assumed |
| Real-time updates | No WebSocket/polling. Manual refresh. |

## D. Reviewer Quickstart

### Prerequisites

Three services must be running:

```bash
# Terminal 1: Ergo node
cd ~/ergo && java -jar ergo-5.0.14.jar --testnet -c ergo.conf
# Wait 15s, then unlock wallet:
curl -X POST http://localhost:9052/wallet/unlock \
  -H "api_key: hello" -H "Content-Type: application/json" \
  -d '{"pass":"hello"}'

# Terminal 2: ChainCash sidecar
cd ~/agent-credit/chaincash && sbt "runMain chaincash.sidecar.SidecarServer"

# Terminal 3: Agent Tab
cd ~/agent-credit/agent-tab && rm -rf .next && DEMO_MODE=true npx next dev -p 3000
```

### Run the proof stack

```bash
cd ~/agent-credit/agent-tab

# Settlement substrate only (always available):
bash scripts/prove.sh
# Expected: 12/12

# Full suite (seed authority fixture first):
npx tsx scripts/seed-authority-demo.ts
bash scripts/prove.sh
# Expected: 39/39

# Clean up authority fixture when done:
npx tsx scripts/seed-authority-demo.ts --cleanup
```

### What the numbers mean

| Result | Meaning |
|---|---|
| **12/12** | Settlement substrate verified. On-chain redemption, recovery, drift, and transfer guardrails all work. |
| **39/39** | Full system verified. Settlement substrate + agent-bound delegated authority (positive loop + negative guardrails including agent-binding checks) all work. |
| Any failure | Do not demo. Check which suite/test failed. |

### Explore the product

- **Pool dashboard**: Open `http://localhost:3000/pool` in a browser
- With one reserve: auto-redirects to pool detail
- With authority fixture: shows pool selector (Demo Debtor + Bolt Labs)
- Pool detail shows: health banner, obligations with readiness badges, authority section, tracker state, settlement history
- **Redeem**: click "Redeem" on a settlement-ready obligation
- **Create delegation**: click "New Delegation" on a self-custody pool (Bolt Labs)

## E. Top 10 Reviewer Questions

**1. Is the settlement real or mocked?**
Real. Transactions are submitted to an Ergo blockchain node, confirmed in mined blocks, with Schnorr signatures and AVL tree proofs verified by the Basis smart contract on-chain.

**2. Why a private testnet instead of public testnet?**
Reproducibility. A private testnet gives deterministic block times, no external interference, and the ability to rebuild the entire chain from scratch. The protocol works the same on any Ergo network.

**3. What is the Basis contract?**
An ErgoScript smart contract that locks collateral and enforces settlement rules. It verifies that the redeemer has a valid Schnorr signature from the tracker, the amount matches the AVL tree proof, and the remaining collateral is preserved.

**4. What is a delegation?**
A cryptographically signed authorization that lets a specific agent, identified by a specific session key, incur obligations against specific providers, up to a spend cap, until an expiry time. The root key signs the delegation (binding it to a named agent); the session key signs individual obligations. New delegations are agent-bound; legacy unbound delegations remain temporarily valid and are explicitly labeled.

**5. How is this different from just a credit line?**
A credit line governs the relationship (how much a provider trusts a debtor). A delegation governs the agent (which specific agent can spend, against which providers, up to what cap, until when). They are independent constraints at different layers.

**6. What happens if an agent tries to exceed its delegation cap?**
The tracker rejects the proxy call with HTTP 409 and does not advance the obligation balance. Proven by the negative guardrail regression.

**7. Can the operator see all of this?**
Yes. The pool detail page (`/pool/[id]`) shows reserve health, obligation readiness, authority compliance state (including delegation utilization bars), tracker state, and settlement history — all on one screen.

**8. What is novel here?**
The combination: blockchain-backed collateral + bounded agent-level authority + real-time operator visibility + proven guardrails. Most agent credit systems are either fully centralized or fully on-chain. This is a governed hybrid.

**9. How far is this from production?**
The protocol and authority layers work, including agent-bound delegation enforcement. What's missing for production: mainnet deployment, role-based access control, auto-expiry, legacy delegation cleanup, and UX polish. The architecture does not need to change.

**10. What should I look at first?**
Run `bash scripts/prove.sh` (39/39). Then open `/pool` in a browser and click through the pool detail page. Then read this document.

## F. One-Paragraph Framing

Agent Credit is a working governed credit system for autonomous AI agents, built on Ergo blockchain settlement. A debtor locks collateral in a smart contract. Providers extend credit. Agents operate under bounded delegated authority — bound to specific agents, scoped to specific providers, capped at specific amounts, expiring at specific times, all cryptographically signed. Settlement happens on-chain with real Schnorr proofs. The operator manages the full lifecycle from a single pool dashboard that shows reserve health, obligation readiness, agent-bound authority compliance, tracker state, and settlement history. The system is proven with 39 automated regression checks covering positive paths (settlement works, agent-bound authority works), negative paths (invalid authority attempts are rejected without advancing commercial state), and agent-binding enforcement (wrong agent, foreign agent, cross-delegation commit — all rejected). This is not a mockup — the chain is real, the proofs are real, the guardrails are real.
