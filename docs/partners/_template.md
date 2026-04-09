# Partner Integration Scoping — {Partner Name}

> Internal scoping checklist. Fill in every section before any code work begins.
> If a section cannot be filled in, the integration is not ready for v1.
> Governed by [`v1-integration-rulebook.md`](v1-integration-rulebook.md).

---

## 1. Partner identity

- **Partner name:**
- **One-line scope:** (one sentence — what this integration is)
- **Date:**
- **Author:**

---

## 2. Mapping to core primitives

How partner-side concepts map onto Agent Credit's existing domain primitives. If a mapping is forced or ambiguous, say so explicitly. Do not paper over gaps.

| Core primitive | Partner-side concept | Notes / ambiguity |
|---|---|---|
| Customer | | |
| Provider | | |
| AgentIdentity | | |
| Delegation | | |
| Reserve | | |
| Debtor (role) | | |
| Creditor (role) | | |
| Operator (role) | | |
| Redeemer (role) | | |

If any cell cannot be filled in cleanly, name the gap. An ambiguous mapping is a finding, not a failure — but it must be visible.

---

## 3. Economic / semantic meaning

The most important section. Denomination vs redemption confusion is the largest integration risk — this section forces clarity before design begins.

- **Unit of account:** (what prices are quoted in for this integration)
- **Settlement asset:** (what actually moves at settlement — should be ERG for v1)
- **What is redeemable, by whom:** (the precise statement of who can claim against what reserve)
- **Role of any partner-side token (if any):**
  - Is it a unit of account, an internal balance counter, a redeemable claim, a reserve asset, or none of the above?
  - Does the partner-side token have any value or transferability outside the partner's environment?
  - Is there any defined relationship (ratio, peg, swap) between the partner token and ERG? If so, is it fixed or variable?
- **Confirmation:** the partner-side token does NOT enter the redemption path in v1.
  - [ ] Confirmed
  - If this cannot be confirmed, the integration is not a v1 fit.

---

## 4. Integration surfaces used

Which of the rulebook's integration surfaces does this integration touch? Mark each as Used / Not used.

**First-order surfaces:**
- [ ] Identity source
- [ ] Partner trust signal (authority eligibility)
- [ ] Display denomination
- [ ] Provider scoping and routing context

**Second-order surfaces:**
- [ ] Provider metadata enrichment
- [ ] Observability hooks

For each surface marked Used, write one sentence describing exactly what the partner provides at that surface.

---

## 5. Non-goals confirmation

Explicit statement that this integration does NOT require any of the following in v1. Check each box only if it is genuinely true.

- [ ] No alternate settlement asset
- [ ] No alternate redemption mechanics
- [ ] No Basis contract changes
- [ ] No sidecar changes
- [ ] No ObligationState shape changes
- [ ] No Delegation shape changes
- [ ] No lowered verification boundary
- [ ] No markets, swaps, or price feeds between partner tokens and ERG
- [ ] No risk scoring on partner signals
- [ ] No multi-asset settlement
- [ ] No core schema rewrites (only nullable additive fields)

If any box cannot be checked, the integration is not a v1 fit. State which one and why.

---

## 6. Smallest provable milestone

The minimum mechanically real outcome that would prove this integration works.

- **Actor count:** (how many partner-side actors, mapped to which core primitives)
- **Flow:** (what sequence of operations is exercised, from registration through settlement)
- **What is redeemable by whom in this milestone:** (one sentence)
- **What is explicitly out of scope for this milestone:**
- **Pass / fail criterion:** (what specific observable outcome means "proven")

If the milestone cannot be stated in terms of existing primitives and existing flows, the integration is not ready.

---

## 7. New proof checks

What positive and negative proof checks will be added before this integration is accepted? These extend the existing proof stack — they do not replace it.

**Positive checks (the integration works as designed):**
1.
2.
3.

**Negative checks (invalid attempts are rejected without commercial state mutation):**
1.
2.
3.

**No-mutation assertions:** for each negative check, what stored value is verified unchanged after the rejection?

---

## 8. Reversibility plan

How would this integration be removed in one commit if the partner relationship ends?

- **Files to delete:** (list each)
- **Schema fields to drop:** (list each — should be only nullable additive fields)
- **Proof checks to remove:** (list each)
- **What in the substrate baseline would be affected by removal:** (should be: nothing)

If removal would affect the substrate baseline, the integration is too deeply coupled and must be redesigned before it ships.

---

## 9. Open semantic questions

What still needs clarification with the partner before code begins? List each as a numbered question, not a vague topic.

1.
2.
3.

If this list is empty, the integration is ready for code (after review). If this list is non-empty, the next step is async clarification with the partner — not code.

---

## 10. Review status

- [ ] Sections 1–9 complete
- [ ] Mapped onto existing core primitives without forcing
- [ ] No non-goals violated
- [ ] Smallest milestone is mechanically specific
- [ ] Reversibility plan affects no core baseline
- [ ] Open questions resolved or explicitly accepted as risk

**Reviewer:**
**Decision (pick one):**
- [ ] Proceed to fixture
- [ ] Clarify with partner
- [ ] Decline as not a v1 fit
- [ ] Defer to future protocol phase

**Date:**
