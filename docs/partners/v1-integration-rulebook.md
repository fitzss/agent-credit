# v1 Core vs Adapter vs Partner Fixture — Integration Rulebook

An internal rulebook for keeping the **current MVP** abstract at the center while making it easy to plug ecosystems in at the edge. Scope: this rulebook governs the current MVP and current partner integrations. It is not an eternal statement of what Agent Credit can never become. A future core protocol phase may explicitly revise any of these constraints; until then, they are the operating discipline.

Not a roadmap. Not an implementation plan. A discipline document for how new integrations should be evaluated and shaped.

---

## Context

The Agent Credit substrate currently proves 39/39 across settlement, agent-bound authority, and negative guardrails. It has a clean three-layer shape: app/control plane (Agent Tab), chain execution (ChainCash sidecar), and blockchain (Ergo). The product center — governed obligations + bounded delegated authority + reserve-backed settlement — is real and proven.

External partner conversations will create pressure to bend the center toward partner-specific semantics. That pressure is dangerous *for the current MVP*. A clean integration treats the partner as a layer the substrate accepts at well-defined edges, not as a redefinition of what the substrate is.

This rulebook fixes the boundary so future partner conversations have a default answer for the v1 phase. The default answer is: "the core does not move in v1; the adapter is narrow; the first integration is a fixture, not a feature." If and when a future protocol phase deliberately revisits any of these boundaries, this rulebook should be revised — not silently violated.

**Important framing:** these are v1 integration constraints chosen to preserve the currently proven substrate. They do not deny broader future protocol directions explored in the Basis / ChainCash materials (multi-asset settlement, federated trackers, broader clearing models). Those directions remain on the table for future protocol phases. v1 is deliberately narrower so that the substrate already proven cannot be diluted by partner pressure before those phases are deliberately opened.

---

## 1. Core Primitives and Verification Boundaries

There are two distinct things that should not bend for partners in v1: **domain primitives** (the commercial concepts the substrate is built around) and **verification boundaries** (the standards that define when something is considered correct). They are different in kind and should be reasoned about separately.

### 1a. Core Domain Primitives

These are the load-bearing commercial concepts. New partners must map themselves into these primitives, not the other way around.

| Primitive | What it is | Defined by |
|---|---|---|
| **Customer** | The debtor of record. Holds a reserve. Authorizes agents. | `Customer` model, `signingMode` field |
| **Provider** | The creditor offering paid services. | `Provider` model |
| **AgentIdentity** | Authenticated actor that can incur obligations on behalf of a Customer. | `AgentIdentity` model, API key |
| **Delegation** | Agent-bound authority grant: scope + cap + expiry + signed. | `Delegation` model, v2 message format |
| **ObligationState** | Cumulative debt between one Customer and one Provider. The core commercial object. | `ObligationState` model |
| **Reserve** | On-chain ERG collateral backing later settlement. | `Reserve` model + Basis contract |
| **Settlement** | On-chain redemption with Schnorr + AVL proofs against the reserve. | `/api/reserves/redeem` + sidecar + Basis |

**Substrate defaults that partners cannot redefine in v1:**
- Settlement asset: ERG.
- Unit of account at storage: credits, with the fixed `NANOERG_PER_CREDIT = 1_000_000_000` constant. Display can vary; storage cannot.
- Redemption path: Agent Tab → sidecar → Basis contract → Ergo node. No partner reroutes this.

These primitives are the answer to "what is Agent Credit?" in v1. If a partner integration would force any of them to change shape, the integration is not a v1 fit.

### 1b. Verification / Acceptance Boundaries

These are not commercial primitives — they are the standards used to decide whether the substrate is working correctly. Partners cannot redefine the standard or substitute their own.

| Boundary | What it is | Defined by |
|---|---|---|
| **Proof stack** | The 39-check regression suite that defines "verified" for v1. | `scripts/prove.sh` (12 + 9 + 18) |
| **Acceptance criterion** | A new partner integration is "accepted" only when it adds proof checks (positive + negative + no-mutation) that pass alongside the existing 39. | First Integration Rule, section 4 |
| **Reversibility criterion** | A v1 partner integration must be removable in one commit without affecting the proof stack baseline. | First Integration Rule, section 4 |

The proof stack is the gate, not a primitive. A partner can satisfy it. A partner cannot lower it, replace it, or substitute their own checks for the existing ones. If a partner integration requires loosening the verification boundary, the integration is not ready.

---

## 2. Integration Surfaces

These are the narrow places where a partner can plug in without touching the core. They are not equal in importance — first-order surfaces are the surfaces every serious partner integration will touch; second-order surfaces are optional refinements.

### First-order surfaces (the real integration shape)

These four are what a meaningful partner integration actually consists of in v1.

#### 2.1 Identity source
A partner-side actor (a node, a wallet, a node operator) maps onto a Customer + AgentIdentity. The mapping happens at registration time. The partner provides the identity material; the substrate stores it in the existing models.

**Allowed:** new nullable fields on AgentIdentity or Customer recording partner-side identifiers (e.g. `partnerRef`, `externalIdentityRef`). Always nullable. Always additive.

**Not allowed:** new Identity-shaped tables, partner-specific Customer subtypes, replacing or shadowing the keypair fields.

#### 2.2 Authority eligibility / partner trust signal
A partner-issued eligibility signal gates whether a delegation can be created for a partner-mapped identity. The signal is opaque to the substrate — it could be any kind of partner-issued credential, and the substrate's job is only to validate it against a known issuer and treat the result as a binary yes/no. The gate is a binary check at the delegation creation API, not a risk model.

**Allowed:** validation functions called from `delegations/route.ts` before `tracker.createDelegation()`. Allowed: a nullable field recording which eligibility signal was used.

**Not allowed:** changing the agent-bound delegation enforcement logic. Not allowed: making the trust signal a continuous spend-cap input. Not allowed: making the trust signal a per-call check at the proxy layer. Not allowed: interpreting the contents of the signal as anything richer than valid/invalid.

#### 2.3 Display denomination
A partner-specific accounting label can be shown in the UI on top of credits, with a fixed conversion constant defined at integration time.

**Allowed:** display helpers that convert credits → partner label using a constant. Allowed: a partner-named UI affordance on `/pool/[id]`.

**Not allowed:** storing values in any unit other than credits. Not allowed: variable conversion. Not allowed: any settlement reference to the partner label. The substrate sees credits and ERG; the user sees whatever the adapter chooses to display.

#### 2.4 Provider scoping and routing context
A partner can constrain which Provider rows are *available* to its identities, and supply routing context for how those providers are *reached* (for example, a partner-specific gateway URL or a partner-scoped subset of the global provider list). This is provider availability and routing, not provider behavior.

**Allowed:** scoping which Provider rows are visible to a partner-mapped Customer (a filter, not a rewrite). Allowed: nullable fields recording routing context such as a gateway hostname or a partner-scoped routing tag.

**Not allowed:** routing context that influences obligation logic, settlement priority, or readiness state. Not allowed: per-partner Provider behavior overrides. The substrate sees the same Provider; the partner sees a filtered list and possibly a different network path.

### Second-order surfaces (optional, lower priority)

These are real integration surfaces, but they are refinements — most v1 partner integrations will not need them.

#### 2.5 Provider metadata enrichment
Additional descriptive metadata about a Provider (provenance, service tier label, partner-issued provider credentials). Allowed as nullable fields or a small linked metadata table. Not allowed if the metadata influences obligation or settlement logic.

#### 2.6 Observability hooks
A partner may register a URL to be notified when settlement events happen. Polling or webhook only — not in-process callbacks. Optional, off by default.

That is the entire list. Four first-order surfaces, two second-order. Anything else is either a core change (which the substrate refuses in v1) or a partner-internal concern (which is the partner's problem, not ours).

---

## 3. Non-Goals (for v1)

These are the things partners cannot redefine in the current MVP phase. A future core protocol phase may explicitly revisit any of these — but until then, partner pressure does not move them.

- **The settlement asset.** ERG in v1. Not any partner token. Settlement happens against ERG locked in the Basis contract.
- **The redemption mechanics.** Schnorr signature + AVL proof + Basis contract verification. No alternate redemption path per partner in v1.
- **The Basis contract.** Off-limits to partners in v1. No partner-specific contract variant.
- **The sidecar.** Off-limits to partners in v1. No partner-specific sidecar logic.
- **The ObligationState shape.** Cumulative debt between one Customer and one Provider, with version and signature. Not partner-extensible at the core in v1.
- **The Delegation shape.** Agent-bound, scope, cap, expiry. Partners can gate creation; they cannot add new authority dimensions in v1.
- **The verification boundary.** The 39-check proof stack defines "verified" for v1. Partners do not get to lower the bar or substitute their own checks.
- **The unit of account at storage.** Credits, with the fixed conversion constant. Display can vary; storage does not in v1.
- **A market between partner tokens and ERG.** Even implicitly. No price feeds. No swaps. No pools. (This one is structural — likely true beyond v1, but explicitly fixed for v1.)
- **Risk scoring on partner signals.** Attestation and identity signals are binary policy gates in v1, not statistical inputs.
- **Multi-asset settlement.** One asset, one path, one set of mechanics in v1.

If a partner conversation requires moving any of these in v1, the integration is not a v1 fit, and the right answer is "this is a future protocol phase, not a current integration."

---

## 4. First Integration Rule

Every new partner integration must satisfy all of these before any core code change is considered:

1. **Fixture before feature.** The first proof of the integration is a standalone fixture script (the shape of `seed-authority-demo.ts`), removable in one commit.
2. **No core schema rewrite.** Only nullable additive fields on existing models. No new core tables.
3. **No settlement, sidecar, or contract changes.** Period for v1. If the integration needs them, it is not a v1 integration.
4. **Proof additions before acceptance.** New checks added to the proof stack (positive, negative, no-mutation) before the fixture is considered done.
5. **Define "proven" before writing code.** The smallest mechanically real outcome must be specified in advance, in writing, in terms of the existing primitives. No "we'll see what works."
6. **Reversibility.** The integration must be removable without affecting the proof stack baseline. If removing it would break things, the coupling is too deep.
7. **Maps to existing primitives or it doesn't fit.** Partner concepts must be expressed in terms of Customer / Provider / AgentIdentity / Delegation / Reserve. No new top-level concepts in v1.

A partner integration that cannot meet all seven is not ready for code. It might be ready for a memo, a clarification round, or a conversation — but not for any change to the substrate.

---

## 5. One-Page Rulebook

> **For v1, the Agent Credit substrate has a fixed center. Partner integrations live at the edge.**
>
> **Core domain primitives (do not move in v1):** Customer, Provider, AgentIdentity, Delegation, ObligationState, Reserve, Settlement (ERG, Schnorr, AVL, Basis). The substrate defaults — settlement asset = ERG, storage unit = credits, fixed conversion constant — also do not move in v1.
>
> **Verification boundary (do not lower in v1):** the 39-check proof stack defines "verified." Partners satisfy it; they do not substitute or weaken it.
>
> **First-order integration surfaces (where partners actually plug in):** identity source, partner trust signal (authority eligibility), display denomination, provider scoping and routing context. Four surfaces.
>
> **Second-order surfaces (optional refinements):** provider metadata enrichment, observability hooks.
>
> **Non-goals for v1:** no alternate settlement assets, no partner-specific redemption, no risk scoring on partner signals, no multi-asset settlement, no markets, no contract variants, no core schema rewrites. A future protocol phase may revisit any of these — until then, they do not move.
>
> **First integration rule:** every partner starts as a fixture, not a feature. Fixture means: nullable fields only, additive only, removable in one commit, with new proof checks before acceptance. The substrate does not commit to a partner until the partner has been proven against the existing primitives.
>
> **Default answer to v1 partner pressure:** "Yes, here is the surface you can plug into. No, the center does not move in v1."
>
> **What this preserves:** the substrate stays clean, the verification boundary stays meaningful, and walking away from any individual partner is a one-commit operation. What this loses: nothing the v1 substrate should care about.

---

## 6. Repo Impact Map

Where each layer lives in the current repo, and what is allowed to change in each location.

### Core (off-limits to partners in v1, except for proven core advances)
- `agent-tab/prisma/schema.prisma` — the core models. Additive nullable fields only.
- `agent-tab/src/lib/tracker/service.ts` — the tracker service. Modified only for proven substrate advances, never per partner.
- `agent-tab/src/lib/tracker/delegation.ts` — delegation logic. Off-limits to partners in v1.
- `agent-tab/src/lib/reconcile.ts` — reconciliation engine. Off-limits in v1.
- `agent-tab/src/app/api/proxy/route.ts` — the proxy. Off-limits to partners in v1 (passthrough only).
- `agent-tab/src/app/api/reserves/*` — settlement orchestration. Off-limits in v1.
- `chaincash/` — entire sidecar + contracts. Off-limits to partners in v1. Period.

### Adapter / integration layer (narrow, well-defined edits per partner)
- `agent-tab/src/app/api/delegations/route.ts` — accepts a partner-issued eligibility signal at delegation creation. Single validation hook against a known issuer.
- `agent-tab/src/lib/adapters/` — proposed location for partner adapter helpers. Each partner gets one small helper file. Pure functions, no DB writes outside the existing models.
- `agent-tab/src/app/api/pool/summary/route.ts` — may include partner-supplied display denomination metadata. Nothing more.
- `agent-tab/src/app/pool/[id]/page.tsx` — may render partner-supplied display labels. No partner-specific UI sections in v1.

### Partner fixture layer (where each partner actually lives)
- `agent-tab/scripts/seed-{partner}-demo.ts` — one fixture script per partner. Self-contained. Reversible.
- `agent-tab/scripts/test-{partner}-loop.ts` — one positive proof script per partner. Mirror of the authority loop pattern.
- `agent-tab/scripts/test-{partner}-guardrails.ts` — one negative proof script per partner. Mirror of the guardrails pattern.
- `agent-tab/.demo-state/{partner}-demo-root.json` — partner-specific root key for fixtures, gitignored, demo-only.
- `docs/partners/{partner}.md` — one short doc per partner explaining what the integration does and what it does not.

### What this means in practice
A new partner integration is at most: a few new files in `scripts/`, an optional helper in `src/lib/adapters/`, two or three nullable schema fields, and small additions to the proof stack. No core file gets rewritten. No contract gets touched. No sidecar logic moves.

---

## 7. MVP Design Judgment

**Should the MVP become adapter-ready now?**

Yes — but adapter-readiness in this rulebook means *discipline*, not *abstraction layers*. The substrate does not need a plugin architecture, an adapter interface, a partner registry, or any new framework. It needs a written rulebook that says "the center does not move in v1; here are the surfaces where partners plug in; here is the first-integration rule." That rulebook is this document.

Concretely, "adapter-ready" for this MVP means:
- No code changes today
- A documented set of integration surfaces (section 2)
- A documented set of v1 non-goals (section 3)
- A documented first-integration rule (section 4)
- A documented repo impact map (section 6)
- A pre-commitment to fixture-first for any partner

This is the right level of investment. Building actual adapter scaffolding (interfaces, plugin hooks, registries) before the second partner exists is the trap. The first real adapter is built when the first real partner integration ships, and it shapes the second adapter's design. Building scaffolding for hypothetical partners is how substrates get diluted before they have any partners at all.

**This rulebook applies to any future partner.** It is partner-shaped, not specific-partner-shaped: a wallet ecosystem, an identity provider, a credential issuer, a tool marketplace would all map onto the same set of integration surfaces.

**What this rulebook is NOT:**
- It is not an architectural redesign
- It is not a new abstraction layer
- It is not an implementation roadmap
- It is not a commitment to any partner
- It is not permission to start writing adapter code
- It is not an eternal statement — it governs v1, and a future protocol phase may revise it

It is a discipline document that says "before any v1 partner integration begins, this is the shape it must take and the rules it must follow."

---

## 8. Partner Integration Template

Every new partner integration must complete the partner integration template at [`docs/partners/_template.md`](_template.md) *before* any code is written. The template forces the integration designer to answer the questions that determine fit:

| Section | What the partner must specify |
|---|---|
| Partner identity | What the integration is, in one sentence |
| Mapping to core primitives | How partner actors map to Customer / Provider / AgentIdentity / Delegation / Reserve |
| Economic / semantic meaning | Unit of account, settlement asset, what is redeemable, role of any partner-side token |
| Integration surfaces used | Which of the four first-order and two second-order surfaces |
| Non-goals confirmation | Explicit statement that the partner does not need any of section 3 |
| Smallest provable milestone | The minimum mechanically real outcome — actor count, flow, what is redeemable, by whom |
| New proof checks | What positive and negative proof checks will be added before acceptance |
| Reversibility plan | How the integration would be removed (which files, which commits) |
| Open semantic questions | What still needs clarification before code begins |

The template is the gate. No partner integration starts coding until the template is filled in and reviewed. If the partner cannot fill in the template, the integration is not ready.

The template's economic / semantic meaning section is critical — it forces every partner conversation to address denomination vs redemption confusion before that confusion can leak into design decisions.

**What the template is NOT:** it is not a partner agreement, not a contract, not a marketing document, not a public-facing spec. It is an internal scoping checklist used before any partner integration becomes code.
