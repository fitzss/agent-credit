# Glossary

Key terms used in Agent Credit, ordered by concept flow.

## Core commercial primitives

**Obligation** — A cumulative debt record between a debtor (customer) and creditor (provider). Created off-chain when agents use tools. The core commercial object in the system.

**Work Receipt** — A signed `ObligationUpdate` row, minted by `/api/proxy` only when a tool call is authorized and successfully executed. It records the prior amount, the delta, the new amount, the canonical message, and the signature, and it advances the matching `ObligationState`. Distinct from `UsageEvent`, which is the audit log of every proxy call (including denied and upstream-error outcomes); a `UsageEvent(denied)` exists, a denied "receipt" does not. The dashboard's "Work Receipt" badge in **Recent Agent Activity** corresponds 1:1 to an `ObligationUpdate`; the "Denied" badge corresponds to a `UsageEvent(denied)` with no `ObligationUpdate`.

**Credit Line** — A trust relationship: how much debt a provider allows a customer to accumulate. Governs the relationship, not the agent.

**Delegation** — A signed authorization from a customer's root key to a session key. Bounds what an agent can do: which providers, what spend cap, until when. Governs the agent, not the relationship.

**Novation** — Transferring debt from one creditor to another. Happens off-chain, instantly, without touching the reserve contract.

## On-chain settlement

**Reserve** — ERG collateral locked in a Basis smart contract on Ergo. Backs later settlement of off-chain obligations.

**Redemption** — The on-chain settlement step. Moves ERG out of the reserve against valid debt, verified by Schnorr signatures and AVL tree proofs.

**Tracker** — An on-chain box that witnesses cumulative debt state per (debtor, creditor) pair. Used as a data input during redemption to prove debt amounts.

**Reconciliation** — Bringing app-layer records into agreement with confirmed on-chain state after a redemption.

**Basis** — The ErgoScript reserve contract that enforces settlement rules: valid signatures, correct proof, collateral preservation.

## Operator concepts

**Pool** — The operator-facing view of one reserve and everything it supports. One pool = one reserve = one customer's obligations, authority grants, and settlement history.

**Settlement-Ready** — An obligation is in a state where redemption is currently possible (has debt, reserve is active, sufficient collateral, no pending tx).

**Authority Mode** — Whether a pool operates under direct tracker-managed signing or delegated authority with session keys and spend caps.

**Coverage Ratio** — Reserve value divided by total outstanding obligations. Shows how well-backed the pool is.

## Authority layer

**Root Key** — The customer's primary secp256k1 keypair. Signs delegation authorizations.

**Session Key** — A temporary keypair authorized by a delegation. Signs individual obligation updates within the delegation's bounds.

**Spend Cap** — The maximum cumulative spend allowed under one delegation.

**Compliance State** — Derived status of a delegation: Active, Approaching Cap, Approaching Expiry, Exhausted, Expired, or Revoked.

## System components

**Agent Tab** — The Next.js application. Owns obligations, settlements, delegations, the pool UI, and the proxy/metering layer.

**Sidecar** — The JVM/Scala service. Owns Ergo transaction construction, Schnorr signing, and AVL proof generation.

**Proxy** — The API route (`/api/proxy`) that agents call to use tools. Authenticates the agent, checks credit and delegation scope, calls the tool, and creates the obligation update.
