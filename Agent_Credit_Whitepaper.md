# Agent Credit: A Governed Obligation System for Software Agents

**Author:** Fitz Doud  @Fitz_Doud
**Status:** Working whitepaper draft  
**Project Layer:** Agent Tab + ChainCash / Basis reserve integration  
**Network Context:** Ergo private testnet for current milestone validation

---

## Abstract

Most discussion around “agent commerce” starts from the wrong primitive. The default assumption is that an agent must have money *before* it can act: a prepaid balance, a human approval step, or a custodial platform that abstracts spending on the agent’s behalf. That framing produces useful demos, but it does not produce a serious commercial operating layer for software actors.

This paper argues for a different primitive: **the governed obligation**. In the system described here, an agent may act under **bounded delegated authority** and create an obligation now, while settlement occurs later against an **on-chain reserve**. Debt state is tracked off-chain, witnessed through a tracker layer, and ultimately settled on-chain via real cryptographic proofs. The result is neither a mere payment app nor a generic billing dashboard, but a governed credit system for software agents.

The implementation described in this paper is not hypothetical. It includes a working product layer, a working settlement execution layer, a reserve-backed pool UI, delegation visibility and control, repeated redemption, multi-pair tracker trees, novation, recovery, drift detection, and a packaged automated proof stack. In its current milestone, the system demonstrates that bounded delegated authority can be created, used, enforced, rejected when invalid, and later settled against real on-chain collateral.

---

## 1. Executive Summary

### The core claim

The key commercial primitive for agents is not the payment event. It is the **obligation**.

A useful agent economy should allow software actors to operate inside bounded commercial relationships. That means:

- an operator can define who may incur obligations,
- under what scope,
- up to what cap,
- until what expiry,
- against what reserve-backed commercial relationship,
- and with what later settlement path.

### The system in one sentence

**Agent Credit is a governed obligation system for software agents, where bounded delegated authority allows agents to incur obligations now and settle later against on-chain ERG reserves.**

### What is already true in the current milestone

The current milestone proves:

- off-chain obligations can accumulate,
- bounded delegated authority can be created and revoked,
- delegated authority can be used to incur obligations through the proxy,
- invalid authority usage is rejected without mutating state,
- reserve-backed settlement is real,
- repeated same-pair redemption works,
- multi-pair tracker trees work,
- debt transfer / novation works,
- operator visibility and control exist through a reserve-scoped pool UI,
- and the full proof stack can be run from a single command.

### Why this matters

Today’s agent systems are usually stuck in one of three shallow models:

1. **prepaid balance silos**,
2. **human approval at the moment of spend**, or
3. **custodial platform abstractions**.

Those models are useful but limited. They assume useful agent action must be preceded by immediate payment readiness. This project instead explores an **obligation-first architecture** in which useful action can precede final settlement, provided authority is bounded, state is witnessed, and recourse is real.

---

## 2. The Problem: Why Existing Agent Payment Models Are Not Enough

### 2.1 The prepaid-balance trap

A common way to make agents “safe” is to give them a prepaid budget. That sounds reasonable until the workflow touches multiple providers. One agent might depend on an LLM provider, a browser tool, a search API, a retrieval layer, and a compute provider. A prepaid world fragments capital across those silos. The workflow is now gated not by whether the work is worth doing, but by whether money is trapped in the right account at the right moment.

This creates a brittle commercial environment for agents. The more tools an agent uses, the more fragmented and inefficient the funding model becomes.

### 2.2 The approval-at-spend-time trap

Another common answer is human-in-the-loop approval. The agent proposes a spend; the human approves it. This improves safety but weakens continuity. The agent is no longer operating inside a live bounded authority relationship. It is just queueing requests for manual checkout.

That may be sufficient for simple use cases, but it undermines the point of autonomous software workflows.

### 2.3 The custodial abstraction trap

A third pattern is to hide everything inside a platform. The platform manages credits, balances, and settlement on behalf of the parties. This can produce a smoother user experience, but it eliminates a meaningful commercial object. Instead of a real obligation relationship, there is an opaque platform ledger.

This is efficient in one sense and limiting in another. It centralizes trust, weakens portability, and makes the economic state harder to reason about outside that platform.

### 2.4 The deeper issue

All three approaches share the same hidden assumption: **final payment conditions must already be in place before the agent can do useful work**.

This project rejects that assumption.

In real commerce, useful work often happens before final settlement:

- vendors ship against net terms,
- contractors work before final invoice settlement,
- trade credit supports ongoing relationships,
- and obligations, not immediate payments, mediate the gap between action and settlement.

The problem is not merely “how should an agent pay?”

The deeper problem is:

> **How should an agent operate inside a governed commercial relationship?**

---

## 3. The Conceptual Shift: From Payments to Governed Obligations

### 3.1 The key primitive

The core primitive in this system is the **obligation**.

An obligation is a machine-readable debt state that says, in effect:

- who owes whom,
- how much,
- under what relationship,
- under what authority,
- what has already settled,
- what remains outstanding,
- and what reserve-backed settlement path exists underneath.

This is fundamentally different from modeling commerce as a sequence of isolated successful payment events.

### 3.2 Why obligations matter more than “pay later”

This system is not just “pay later for APIs.” That phrase is too shallow. The real goal is to let agents participate in governed commercial relationships where action and settlement are separated in time, while still preserving control, fairness, and recourse.

A bounded delegated authority system lets a session key do useful work now without requiring that every action be prefunded or manually approved. That is not free-for-all autonomy. It is **governed autonomy**.

### 3.3 Bounded commercial authority

The second key primitive is **delegated authority**.

Instead of giving an agent open-ended spending power, the operator can authorize a bounded session key with explicit limits such as:

- provider scope,
- spend cap,
- expiry,
- and later, possibly more granular policy conditions.

This matters because it gives you a meaningful middle ground between:

- rigid manual approvals, and
- unsafe unrestricted spending.

### 3.4 Reserve-backed later settlement

The third key primitive is **reserve-backed settlement**.

Obligations do not float forever as unaudited promises. They are grounded in a reserve-backed settlement path. ERG collateral is locked in a Basis-style reserve contract, and obligations can later be redeemed against that reserve using real signatures and proofs.

The chain is therefore not the primary interaction loop. It is the recourse and settlement layer that makes the off-chain commercial state credible.

---

## 4. Why ChainCash / Basis Is the Right Intellectual and Technical Foundation

The Basis / ChainCash line of thinking matters because it reframes money and payment systems around the relationship between:

- off-chain debt state,
- on-chain collateral,
- witnessed commitments,
- and later redemption.

### 4.1 The tracker’s real role

The tracker is not merely “where balances are stored.” That would be too shallow.

The tracker’s deeper role is to make shared reserve-backed debt state:

- visible enough to reason about,
- witnessed enough to trust,
- and constrained enough to avoid certain classes of abuse.

Once one reserve backs many live obligations, the real problem is not just issuing debt. The harder problem is ensuring that debt state remains legible, bounded, and fair enough for counterparties to rely on it.

### 4.2 Shared reserve-backed state

The Basis / ChainCash perspective is important because it allows you to think beyond siloed bilateral prefunding. One reserve can support many obligations and many relationships, provided the system can keep credible track of what claims already exist.

That is much deeper than “which balance should this tool deduct from?”

### 4.3 Why this matters for agents

Agents are especially sensitive to workflow interruption. If every useful action requires prefunding, manual approval, or a platform-specific wallet, agent workflows remain brittle. A governed obligation system is much closer to how a serious software commercial substrate should work: bounded, visible, and later settleable.

---

## 5. System Overview

The implementation currently consists of three layers.

### 5.1 Product layer: Agent Tab

Agent Tab is the operator-facing and application-facing layer. It is built with Next.js / TypeScript / Prisma / SQLite and owns:

- pool dashboard UI,
- obligations,
- settlements,
- debt transfer / novation,
- delegation create/revoke,
- authority visibility,
- tracker lifecycle representation,
- reconciliation,
- proof scripts,
- and demo fixtures.

It is the product/control layer.

### 5.2 Settlement execution layer: ChainCash sidecar

The ChainCash sidecar is the JVM / Scala layer that handles:

- reserve deployment,
- tracker deployment / update,
- redemption transaction building,
- Schnorr signing,
- AVL proof generation,
- and chain execution support.

It is the bridge between the app and the chain.

### 5.3 Blockchain layer: Ergo node

The Ergo node handles:

- reserve boxes,
- tracker boxes,
- wallet state,
- mining,
- and blockchain truth.

The current milestone uses an isolated private Ergo testnet for reproducibility and deterministic project control.

---

## 6. Product Model: One Pool = One Reserve

A major product refinement in the current milestone is that the operator surface is now **reserve-scoped**.

Instead of presenting a conceptually muddy mixed dashboard, the system treats:

> **one pool = one reserve**

This means each `/pool/[id]` view corresponds to a real backing pool, with:

- its own reserve health,
- its own obligations,
- its own authority mode,
- its own tracker state,
- and its own settlement history.

This is important because it aligns the UI with the commercial object the system is actually trying to manage.

---

## 7. Authority Model: Delegation as the Bounded Authority Primitive

### 7.1 What a delegation is

A delegation is a root-signed bounded authorization for a session key. It expresses:

- which customer’s authority is being delegated,
- which providers are in scope,
- what the spend cap is,
- when the authority expires,
- and which session public key may act.

### 7.2 What a delegation is *not*

A delegation is not:

- the same thing as a credit line,
- the same thing as a general wallet balance,
- the same thing as a tracker-managed authority path,
- or the same thing as a specific agent binding.

It is specifically a **bounded authority grant** for a session key.

### 7.3 Current authority modes

The product currently surfaces two authority modes:

- **Tracker-Managed** — authority is effectively held through the tracker-managed path
- **Delegated Authority** — bounded session keys are used under self-custody authorization

### 7.4 Current limitation

Delegations are currently **customer-scoped, not agent-scoped**. That means any agent associated with that customer can use a valid delegation. This is one of the most important future refinements.

---

## 8. Settlement Model

### 8.1 Off-chain first

Most commercial activity occurs off-chain:

- obligations are created off-chain,
- debt state is tracked off-chain,
- authority is checked in the app/tracker path,
- and only later does settlement touch the chain.

### 8.2 On-chain recourse

Settlement is enforced through a Basis-style reserve contract on Ergo. The reserve locks ERG collateral and redemption requires real cryptographic proof conditions, including:

- Schnorr signatures,
- AVL tree proofs,
- and correctly aligned reserve / tracker state.

### 8.3 Why this architecture matters

This hybrid architecture keeps the system:

- efficient enough for frequent interactions,
- governable enough for operator control,
- and credible enough for real settlement.

---

## 9. What Is Already Proven

The project’s strongest current asset is that it is not merely conceptual. It has a proof stack.

### 9.1 Settlement substrate proof

The settlement substrate proof demonstrates:

- on-chain redemption,
- repeated same-pair redemption,
- multi-pair tracker tree support,
- novation,
- pending recovery,
- drift detection,
- duplicate reconciliation blocking,
- reserve version derivation,
- and related settlement guardrails.

### 9.2 Positive authority proof

The positive delegated-authority proof demonstrates:

- creating a delegation with a real root-key signature,
- using the session key through the proxy,
- validating scope and spend cap,
- signing the pending update,
- incrementing delegated spend,
- and reflecting the updated authority state in the pool summary.

### 9.3 Negative authority proof

The negative authority proof demonstrates rejection without commercial-state mutation for:

- wrong provider scope,
- expired delegation,
- exceeded cap,
- and revoked delegation.

This is critical. It proves not just that authority works when valid, but that invalid authority is rejected safely.

### 9.4 Unified proof stack

The proof stack is packaged under a single entry point:

```bash
cd agent-tab && bash scripts/prove.sh
```

Interpretation:

- **12/12** = settlement substrate verified
- **28/28** = settlement + delegated authority fully verified

---

## 10. Current Operator Surface

The operator can now do more than inspect state.

The current single-pool view includes:

- reserve health,
- obligation readiness,
- direct redeem action,
- authority mode,
- delegation visibility,
- delegation creation and revocation,
- tracker state,
- and settlement history.

This means the pool page has crossed from pure visibility into actual control.

That matters because this is the beginning of a real operator-grade commercial control surface, not a passive dashboard.

---

## 11. Novation and Debt Transfer

One of the more important non-obvious capabilities already supported is **debt transfer / novation**.

This means debt can move from one creditor relationship to another without touching the reserve contract itself at transfer time. Conceptually:

- A owes B,
- some of that obligation is transferred,
- and now A owes C instead.

This is important because it makes obligations more composable than siloed payment balances. It moves the system further toward a real commercial state machine rather than a set of isolated spend buckets.

---

## 12. What Is Prototype-Grade vs Not Yet Built

### 12.1 Prototype-grade but working

The following are real and working, but still rough or local-development oriented:

- pool dashboard UI,
- inline delegation create/revoke UX,
- authority-demo fixture,
- token index fallback behavior,
- local private testnet workflow,
- local/demo secret handling.

### 12.2 Not yet built

Important things not yet built include:

- delegation-to-agent binding,
- per-agent spend tracking,
- richer delegation editing/history/audit,
- auto-expiry background processing,
- fuller policy engine,
- multi-reserve aggregation,
- mainnet deployment,
- role-based access control,
- real-time updates,
- production-grade secret management,
- more polished UX.

This distinction must remain explicit. It is one of the most important trust-preserving habits around this project.

---

## 13. Why This Is Fundamentally Different from Current Agent Payment Thinking

The fundamental difference is that most current agent payment thinking asks:

> How can an agent spend safely?

This project asks:

> How can an agent operate inside a governed commercial relationship?

That shift matters because it changes the system from:

- balances,
- approvals,
- and wallet abstractions

into:

- obligations,
- bounded authority,
- witnessed debt state,
- reserve-backed recourse,
- and operator-visible commercial state.

That is the deeper innovation.

---

## 14. Why This Matters if It Scales

If this architecture becomes robust and generalized, it could make it easier to build agent systems that:

- do not break when one provider balance runs out,
- do not require constant human approvals,
- do not depend on one custodial platform,
- can reuse one backing pool across many relationships,
- can surface commercial state to operators in one place,
- can prove authority bounds both positively and negatively,
- and can support richer commercial composition like novation and multi-pair tracked debt.

In short, it could move agent commerce closer to real trade credit and governed commercial operation, rather than keeping it trapped inside consumer-style payment abstractions.

---

## 15. What the Current Milestone Really Is

The current milestone should be understood as:

**MVP v3 — governed agent credit with bounded delegated authority**

This means:

- the settlement substrate is real,
- the operator pool UI is real,
- authority visibility is real,
- authority control is real,
- authority works positively,
- authority rejects negatively,
- the proof stack is packaged,
- and the repo is now suitable for external review on its current scope.

That is already significant.

---

## 16. Immediate Strategic Implication

At this point, the highest-leverage next move is often **not more code**.

Because the system now has:

- real proof,
- real packaging,
- real operator surfaces,
- and real reviewer docs,

external feedback is likely to be more valuable than another unbounded feature phase.

The most important questions now are often:

- what do reviewers find novel?
- what do they misunderstand?
- what do they doubt?
- which limitation matters most to real users?
- what is the strongest next deepening step rather than a widening distraction?

---

## 17. Conclusion

This project is trying to do something more fundamental than making agent payments easier.

It is trying to make software agents legible participants in governed commercial relationships.

That requires a different primitive. Not the isolated payment event, but the governed obligation. Not unrestricted autonomy, but bounded delegated authority. Not purely off-chain convenience or purely on-chain rigidity, but an architecture where off-chain commercial state and on-chain settlement reinforce each other.

The current implementation does not solve every problem. It is still prototype-grade in important respects. But it already proves something meaningful:

- obligations can be created off-chain,
- bounded delegated authority can control who may create them,
- invalid authority can be rejected safely,
- debt can be transferred,
- reserves can back later settlement,
- and an operator can see and control the resulting commercial state through a coherent pool surface.

That is enough to take the idea seriously.

---

## Appendix A: Current Reviewer Path

1. Read `README.md`
2. Read `docs/milestone-summary.md`
3. Run:

```bash
cd agent-tab && bash scripts/prove.sh
```

If the authority demo fixture is seeded, expect **28/28**.
If not, expect **12/12** for the canonical settlement substrate.

---

## Appendix B: One-Sentence Project Framing

**Agent Credit is a governed obligation system for software agents, combining bounded delegated authority, tracker-witnessed off-chain debt state, and reserve-backed on-chain settlement on Ergo.**
