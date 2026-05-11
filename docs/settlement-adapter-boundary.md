# Settlement Adapter Boundary — slice 17a

> **What this is:** the design memo that names the seam between
> Agent Tab's chain-agnostic core and a chain-specific settlement
> adapter. It is the doc-only planning slice (17a). Implementation
> of the seam ships in 17b (thin facade only). Mainnet alpha
> safety mode ships in 17c.
>
> **What this is NOT:** a claim of working multi-chain support.

## The one-sentence framing

> The settlement adapter boundary is not a claim that Agent Tab
> works on every blockchain today; it is a design seam that keeps
> the Agent Tab core chain-agnostic while Ergo/ChainCash remains
> the first working reference adapter.

Everything below this line follows from that sentence.

## Why this exists

Through slice 16c (commit `da51ad3`), Agent Tab has proved an
operator-owned reserve settlement vertical end-to-end on Ergo
testnet. The proof is real: receipt → obligation →
SettlementEvent → on-chain redemption tx, with the canonical
reserve, Demo Debtor, and the 15a demo state all byte-equal
untouched and `prove.sh` at 49/49 before and after.

The implementation is correct — and tightly Ergo/ChainCash-shaped.
The thesis the product is built around is not. The whitepaper's
load-bearing claims are about **obligations, bounded delegated
authority, and witnessed settlement**, none of which require Ergo
or any specific chain. Ergo is the *implementation* we picked to
prove the concept on a real ledger.

If the next slices ship more Ergo plumbing without naming this
distinction, every PR will deepen the coupling and make a second
chain (or a second settlement model on the same chain)
progressively harder. If we refactor everything before shipping
mainnet alpha, we delay the actual product proof users care about.

This memo names the seam, freezes the interface, and orders the
slices that follow.

## The two halves

**Agent Tab core is chain-agnostic.** It owns:

- The obligation lifecycle: `ObligationState`, `ObligationUpdate`,
  the tracker bookkeeping, the propose/commit flow with signature
  verification.
- Delegations + agent identities + the trust-signal partner gate.
- The MCP proxy + Work Receipt acceptance.
- The credits domain (BigInt `nanoCredits`, `formatCredits`,
  `parseCredits`).
- Settlement *facts* (`SettlementEvent`: amount, method, status,
  timestamp, obligation reference) — the record of "settlement
  happened," distinct from the chain artifact that produced it.
- Auth, session, debt transfer.

These concepts live in `agent-tab/src/lib/` outside
`adapters/settlement/`. They contain no chain-specific imports
and no chain-specific assumptions.

**Ergo/ChainCash is the first reference settlement adapter.** It
owns:

- Reserve deployment and lifecycle activation (currently in
  `agent-tab/src/lib/sidecar-client.ts`).
- On-chain redemption tx verification (currently
  `reconcile.ts` guardrails 4–8: Ergo node lookup, box
  inputs/outputs, EIP-4 asset matching, `valueNanoErg` outflow,
  sidecar consistency).
- The AVL-tree tracker box, deployment, and alignment.
- Secret-file plumbing for chain-side signing
  (`~/.chaincash-secrets/`).
- Chain-denomination conversion (`nanoCreditsToNanoErg`,
  v1 identity).
- Canonical-fixture identifiers
  (`reserveTokenId`, `trackerNftId`, `reserveId`) supplied by the
  adapter.
- Adapter-specific env vars: `SIDECAR_URL`, `ERGO_NODE_URL`,
  `ERGO_NODE_API_KEY`, `ERGO_NETWORK`,
  `OPERATOR_MAX_REDEEM_NANOERG`.

## Concept table — core vs. adapter

| Concept | Where it lives | Notes |
|---|---|---|
| `ObligationState`, `ObligationUpdate`, `Delegation`, `AgentIdentity`, `WorkReceipt`, `Provider`, `Tool`, `CreditLine`, `UsageEvent` | Core | Whole models are chain-neutral; would survive a chain swap untouched. |
| `SettlementEvent` (the row) | Core | The *fact* of settlement is chain-neutral. The reference field (Ergo tx id) is currently named `redemptionTxId` and stays adapter-tied for now. |
| `nanoCredits` (BigInt unit) | Core | Agnostic billing unit. Conversion to chain units happens at the adapter edge. |
| Delegation message format (`agentab:delegate:v*`) | Core | Off-chain protocol; chain-agnostic signature payload. |
| Operator proof-of-control challenge | Core | Identity binding; the *verifier* (e.g. Schnorr on Ergo R4) is adapter-specific. |
| Trust-signal partner gate | Core | Already adapter-shaped (`src/lib/adapters/trust-signal.ts`); the settlement adapter mirrors its style. |
| Reserve deployment / scan / activation | Adapter | Ergo: `deployReserve`, `getReserveStatus`, PATCH-rescan path. |
| Chain-tx verification | Adapter | Ergo: `reconcile.ts` guardrails 4–8 + `chainVerification` record. |
| Reserve / tracker / box / AVL identifiers | Adapter | `reserveTokenId`, `trackerNftId`, `boxId`, `avlTreeDigest`, `creationHeight`, `contractVersion`, `reserveAddress`. |
| `valueNanoErg`, `nanoErg` denomination | Adapter | Ergo native unit. |
| Schnorr key / secret-file conventions (`~/.chaincash-secrets/`) | Adapter | secp256k1 Schnorr is Ergo-aligned; on-disk path naming is chaincash-specific. |
| Canonical-refusal identifiers (`canonical.ts`) | Adapter (eventually) | Stays in core for 17b; moves onto the adapter in a later slice once a second adapter justifies it. |

## The seam — mirrors `trust-signal.ts`

The existing adapter pattern at
`agent-tab/src/lib/adapters/trust-signal.ts` defines the style
the settlement adapter follows:

- Static `Record<string, …>` registry; no register function, no
  lifecycle, no DI.
- Typed error class with a discriminated `code`.
- A single entry point per surface; substrate code calls it,
  not the registry directly.
- Zero Prisma, zero I/O at registry construction, zero startup
  hooks.
- Adding an adapter (or a partner) is a one-line registry
  append.

## The interface — frozen for 17b to implement

This block is documentation, not committed code. 17b implements
it as written (TypeScript types under
`agent-tab/src/lib/adapters/settlement/`).

```ts
// types.ts
export interface ChainSettlementProof {
  txId: string;                            // chain-native tx id
  verifications: Record<string, boolean>;  // adapter-defined verification keys
  raw?: unknown;                            // adapter-specific blob; substrate ignores
}

export interface ReserveStatus {
  found: boolean;
  ownerPubKey?: string;
  valueChainUnits: bigint;     // nanoERG for Ergo
  trackerNftId?: string;
  avlTreeDigest?: string;
  chainSpecific?: unknown;
}

export interface SettlementAdapter {
  readonly chainName: string;             // "ergo"
  readonly network: "testnet" | "mainnet";
  readonly denominationLabel: string;     // "nanoERG"
  readonly denominationPerCredit: bigint; // 1n for v1 Ergo (identity)
  readonly canonicalIds: {
    reserveId: string;
    reserveTokenId: string;
    trackerNftId: string;
  };

  // Reserve lifecycle
  deployReserve(params: {
    ownerPubKeyHex: string;
    reserveTokenId: string;
    trackerNftId: string;
    initialCollateralChainUnits: bigint;
  }): Promise<{ deploymentRequestJson: string; reserveAddress: string }>;

  getReserveStatus(reserveTokenId: string): Promise<ReserveStatus>;

  // Tracker lifecycle (adapter handles AVL / Merkle / N/A internally)
  deployTracker(params: { /* adapter-defined */ }): Promise<{ txId: string }>;

  // Redemption verification — replaces reconcile.ts guardrails 4–8 when 17b
  // is wired in (deferred past 17c per current scope decision).
  verifyRedemptionTx(params: {
    txId: string;
    expectedReserveTokenId: string;
    expectedGrossChainUnits: bigint;
  }): Promise<ChainSettlementProof>;

  // Denomination conversion
  nanoCreditsToChainUnits(nanoCredits: bigint): bigint;
  chainUnitsToNanoCredits(chainUnits: bigint): bigint;
}

// registry.ts
export const SETTLEMENT_ADAPTERS: Record<string, SettlementAdapter> = {
  // 17b: exactly one entry, "ergo-testnet" — a facade over the existing
  // sidecar-client.ts. No new logic, no behavior change.
};
```

## Sequencing — 17a → 17b → 17c

| Slice | Role | Touches |
|---|---|---|
| **17a (this doc)** | Doc-only planning slice. Names the seam, freezes the interface above, lists mainnet alpha blockers, refuses premature multi-chain. | `docs/settlement-adapter-boundary.md` (new), `docs/milestone-summary.md` (small update). **No code, no schema, no `prove.sh` change.** |
| **17b — thin facade only** | Introduce the interface + a single Ergo facade that delegates to `sidecar-client.ts`. No behavior change. The adapter is exported but **not yet called** by `reconcile.ts`, the redeem route, or any substrate code. Lints, type-checks, and proves the seam is legible. | `agent-tab/src/lib/adapters/settlement/types.ts` (new), `agent-tab/src/lib/adapters/settlement/ergo-testnet-adapter.ts` (new), `agent-tab/src/lib/adapters/settlement/registry.ts` (new). `prove.sh` stays 49/49. |
| **17c — Ergo mainnet alpha safety mode** | Land the mainnet alpha blockers on top of the thin seam. Single chain (Ergo), single operator, own funds, tiny cap, typed confirmation, audit log. The adapter from 17b remains the only impl; 17c does not need a second one. | `agent-tab/src/lib/env.ts` (mainnet env additions), `agent-tab/src/app/api/reserves/redeem/route.ts` (mainnet guard + typed confirmation), `agent-tab/scripts/operator-reserve-init.ts` (`--network=mainnet` gate), `.env.example`, audit log writer. `prove.sh` stays testnet-only. |

**17b is thin facade only.** Explicitly deferred from 17b (do
not include even if tempting):

- Rewiring `reconcile.ts` guardrails 4–8 to dispatch through the
  adapter registry — deferred past 17c.
- Moving `canonical.ts` identifiers onto the adapter — deferred
  past 17c.
- Any second-chain implementation (EVM, Cardano, Cosmos, …).
- Any mainnet-related code.

**17c is mainnet alpha safety mode.** Explicitly deferred from
17c:

- Mainnet pool UI.
- Mainnet path in `packages/cli`.
- Multi-tenant operator routing.
- Public deposits, third-party funds, custody of any kind.
- A second settlement adapter.

## Ergo mainnet alpha blockers (17c checklist)

These gate the first mainnet alpha redemption. None of them are
in 17a's scope; this section records them so 17c starts with a
known target.

- [ ] Typed mainnet env (`ERGO_NETWORK="mainnet"` +
      explicit `ERGO_ALLOW_MAINNET=true` opt-in). Refuse by default.
- [ ] `OPERATOR_MAINNET_MAX_REDEEM_NANOERG` env var, no default →
      refuse if unset on mainnet. Tiny cap (e.g. 0.01 ERG = 10M
      nanoERG).
- [ ] Typed confirmation token at `/api/reserves/redeem` on
      mainnet (replay-resistant via the redemption tx).
- [ ] Mainnet canonical-refusal identifiers (separate from testnet
      ones). Defense-in-depth: existing testnet `CANONICAL_REFUSE`
      still fires on mainnet callers if they reference testnet
      IDs.
- [ ] Append-only audit log on every mainnet redeem call
      (timestamp, operatorPubKey, reserveId, grossNanoErg,
      redemptionTxId, outcome). Default destination
      `~/.agent-tab/mainnet-alpha-audit.jsonl`.
- [ ] Secret-file directory remains `~/.chaincash-secrets/`;
      manifest + scripts label `network: "mainnet"` and refuse
      cross-network pre-provisioning.
- [ ] `operator-reserve-init.ts --network=mainnet` flag, requires
      `ERGO_ALLOW_MAINNET=true`. Refuse otherwise.
- [ ] `.env.example` mainnet block with prominent warnings.
- [ ] Proof-of-control re-verification at redeem time on mainnet
      (read R4 fresh, verify the canonical challenge).
- [ ] `prove.sh` stays testnet-only. Mainnet is operator-validated,
      manual, and small.

## Premature-multi-chain refusal

The following changes are **not** in 17a, 17b, or 17c. They are
recorded here as the explicit refusal so a reviewer can see the
boundary clearly.

- **No EVM / Cardano / Cosmos / other-chain scaffolding** of any
  kind. The settlement adapter registry has one entry through 17c.
- **No schema refactor before a real second adapter.** Schema
  changes (renaming Ergo-specific columns, adding
  `settlementAdapter: String`, splitting per-chain tables,
  JSON-blob `chainSpecificMetadata`) wait until a credible
  second-chain operator exists. Schema migrations are the most
  expensive thing to undo.
- **No moving canonical IDs onto the adapter** until there is a
  second canonical to compare against. Today's `canonical.ts`
  hard-codes one Ergo fixture; that's fine until it isn't.
- **No multi-chain UI.** The pool dashboard remains
  one-chain-aware.
- **No multi-tenant operator routing.** One operator per
  deployment, period.

The interface in this doc is *forward-compatible* with multiple
adapters — but until a second adapter is actively being built,
the registry stays at one entry and no plumbing assumes
multiplicity.

## Honesty footnote

This memo describes a **design intent**, not a deployed
multi-chain product. As of slice 17a:

- Agent Tab core is chain-agnostic *in principle* — the
  obligation / delegation / MCP / accounting layers contain no
  Ergo-specific imports.
- Agent Tab in practice has exactly **one settlement adapter**:
  Ergo testnet via ChainCash. It is also the *reference* adapter
  — the one whose behavior the interface above must continue
  to admit.
- There is **no working second adapter.** Not for EVM, not for
  Cardano, not for any other chain. None has been written or
  pilot-deployed.
- There is **no schema refactor** for multi-chain. The Prisma
  models still carry Ergo-named fields (`reserveTokenId`,
  `trackerNftId`, `boxId`, `avlTreeDigest`, `valueNanoErg`,
  `redemptionTxId`, etc.). Those names stay until a second
  adapter forces them to generalize.
- Mainnet alpha is **one operator, own funds, tiny cap, typed
  confirmation, no custody, no third-party deposits, no public
  deposits.** That posture holds through 17c and beyond until
  it is explicitly revisited.
- Slice 17b is **thin facade only.** Not a substrate refactor.
- Slice 17c is **mainnet alpha safety mode.** Not a launch.

The technical guarantee 17a/17b/17c land toward is *one chain,
one operator, one reserve, settlement-adapter-shaped at the
core* — a posture that survives a future second adapter without
forcing a schema migration to ship. Anything beyond that is
explicitly deferred.

This documentation is **not legal advice.** It describes the
technical posture of the software. Operators considering mainnet
deployment should consult counsel.
