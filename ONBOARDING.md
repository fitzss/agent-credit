# Agent Credit — Onboarding for a New Contributor

This document is the long-form orientation for someone (human or LLM) who has never touched this repo before. Read it top to bottom on first arrival, then keep it open as a navigational map. It complements — does not replace — `CLAUDE.md` (the project house rules) and `README.md` (the public-facing pitch).

If you only have time for three files: read **this**, then `CLAUDE.md`, then `prisma/schema.prisma`. After that you can navigate by the section "Where to look for X" near the end.

---

## 1. What this project is (in one paragraph)

**Agent Credit is a governed credit layer for AI agents.** An agent is delegated bounded authority by its principal (the customer); when the agent calls a paid tool, the system records an off-chain *obligation* (a signed, witnessed, version-tracked debt of nanoCredits owed by the customer to the provider) instead of debiting a balance. The obligation can later be settled — partially or fully — against on-chain ERG collateral held in a *reserve* contract on Ergo, via the **ChainCash/Basis** sidecar, with Schnorr signatures and AVL-tree proofs. The thesis is "obligation-first, not payment-first." This is **not** a wallet, not a billing dashboard, not a checkout abstraction. The core primitive is the bounded commercial obligation; everything else is plumbing around it.

Concrete vocabulary (also see `docs/glossary.md`):

- **Provider** — the seller of tools (e.g. "ToolSmith AI"). Has a keypair.
- **Customer** — the buyer / debt-bearer. Has a keypair. Owns agents, credit lines, obligations, reserves, delegations. Can be `signingMode = "tracker"` (server signs on customer's behalf using stored private key) or `"self-custody"` (customer signs offline; server only holds the public key).
- **AgentIdentity** — a single agent acting on behalf of one customer. Authenticated by `x-agent-api-key` (HMAC-hashed in DB; raw key returned exactly once at create).
- **Tool** — a paid endpoint exposed by a provider, with a `costPerCall` in nanoCredits.
- **CreditLine** — the spend ceiling between (provider, customer). Initialises an `ObligationState` row with currentAmount=0.
- **ObligationState** — the cumulative committed debt for one (provider, customer) pair. Has `version`, `currentAmount`, `pendingAmount`, `latestSignedMessage`, `latestSignature`. Versioned for optimistic concurrency.
- **ObligationUpdate** — every charge or settlement is an immutable update row carrying `previousAmount`, `newAmount`, `delta`, `canonicalMessage`, `signature`, `type` ("charge" | "settlement"), `nonce`.
- **Delegation** — a customer's signed authorisation for a *session keypair* to act on behalf of an agent within a scope (`scopeProviderIds`, `scopeToolIds`, `spendCap`, `expiresAt`). Bound to a specific `AgentIdentity`.
- **Reserve** — an on-chain UTXO holding ERG collateral, owned by the customer's pubkey, trusted to redeem against a specific tracker NFT. Has `lifecycle` (requested → submitted → active → depleted), `boxId`, `valueNanoErg`, `avlTreeDigest`, `contractVersion` (v1 insert-only or v2 insert+update).
- **TrackerBox** — an on-chain UTXO whose AVL tree records cumulative committed debt per `(debtor, creditor)` pair. The NFT id is stable across rotations; the box id rotates each update.
- **TrackerEntry** — one (debtor, creditor) row inside a tracker box's AVL tree.
- **PendingRedemption** — a redemption tx broadcast but not yet confirmed/reconciled. Lifecycle: pending → reconciled | failed.
- **SettlementEvent** — what happened when the obligation was reduced. Either on-chain (with `redemptionTxId`) or "manual".
- **DebtTransfer** — novation: move X nanoCredits from obligation(A→B) to obligation(A→C). Same debtor required. Atomic.
- **Trust signal** — a v0 partner-issued eligibility check on delegation creation (`src/lib/adapters/trust-signal.ts`). Static dispatch; binary valid/invalid; no DB writes.

---

## 2. Three-process runtime

```
┌────────────────────┐  HTTP  ┌──────────────────┐   Ergo    ┌─────────────────┐
│ Agent Tab (Next)   │ ─────> │ ChainCash sidecar │ ──────>  │ Ergo node        │
│  Port 3000         │        │  Port 8081 (JVM)  │          │  Port 9052       │
└────────────────────┘        └──────────────────┘          └─────────────────┘
  product layer                  chain execution             private testnet
```

- **Agent Tab** (`agent-tab/`, Next.js 16.1.6 / React 19 / Prisma 6 / SQLite) — owns ALL product state, route handlers, UI, proof scripts, fixtures. Listens on `:3000`.
- **ChainCash sidecar** (`chaincash/`, JVM/Scala, sbt) — owns Schnorr signing, AVL proofs, Ergo transaction building, contract compilation. **Off-limits to app-layer work** (do not edit unless the user explicitly says so). Listens on `:8081`.
- **Ergo node** — Ergo 5.0.14 in private testnet mode. Wallet password `hello`, API key `hello`. Listens on `:9052`.

Start order matters:

```bash
# Terminal 1 — Ergo node (must be unlocked once after start)
cd ~/ergo && java -jar ergo-5.0.14.jar --testnet -c ergo.conf
sleep 15
curl -X POST http://localhost:9052/wallet/unlock \
  -H "api_key: hello" -H "Content-Type: application/json" -d '{"pass":"hello"}'

# Terminal 2 — Sidecar
cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"

# Terminal 3 — Agent Tab in dev mode (DEMO_MODE extends polling windows)
cd agent-tab && DEMO_MODE=true npx next dev -p 3000

# Verify everything wired
cd agent-tab && bash scripts/prove.sh    # must print 49/49
```

---

## 3. Repository layout

```
agent-credit/
├── Agent_Credit_Whitepaper.md     ← obligation-first thesis (read for theory)
├── CLAUDE.md                       ← project house rules (READ ALWAYS)
├── README.md                       ← public pitch
├── docs/
│   ├── milestone-summary.md       ← reviewer quickstart, what is/isn't proven
│   ├── operator-demo-plan.md      ← demo sequence + troubleshooting
│   ├── glossary.md                ← domain terms
│   ├── repo-map.md                ← granular file guide
│   └── partners/v1-integration-rulebook.md   ← integration discipline
├── chaincash/                      ← OFF-LIMITS to app work
│   ├── src/.../sidecar/SidecarServer.scala   ← :8081 HTTP endpoints
│   ├── contracts/                            ← Basis ErgoScript
│   └── build.sbt
└── agent-tab/                      ← MOST WORK HAPPENS HERE
    ├── prisma/schema.prisma        ← 16 models, all money fields BigInt
    ├── package.json                ← deps + minimal scripts (dev, build, lint, backfill:operator)
    ├── next.config.ts
    ├── src/
    │   ├── middleware.ts           ← withAuth on all non-API, non-login pages
    │   ├── lib/                    ← business logic (see §6)
    │   │   ├── auth.ts             ← requireSession / requireOperator / requireCustomerOwned / ownedCustomerIds / authErrorResponse / HttpError
    │   │   ├── credits.ts          ← NANOCREDITS_PER_CREDIT, parseCredits, formatCredits, nanoCreditsToNanoErg
    │   │   ├── prisma.ts           ← singleton client
    │   │   ├── crypto.ts           ← Schnorr keypair, sign/verify, canonicalMessage builder
    │   │   ├── agent-key-hash.ts   ← HMAC-SHA256 with AGENT_API_KEY_PEPPER (dev fallback present, prod throws)
    │   │   ├── agent-sdk.ts        ← convenience client used by demo scripts
    │   │   ├── json-safe.ts        ← BigInt → string serialiser for JSON responses
    │   │   ├── sidecar-client.ts   ← HTTP client for the JVM sidecar
    │   │   ├── reconcile.ts        ← settlement reconciliation; ensureSecretFile; recoverPending; cumulative-debt math
    │   │   ├── tracker/
    │   │   │   ├── service.ts      ← THE off-chain note service — propose/commit, key status, history, proof
    │   │   │   ├── delegation.ts   ← buildDelegationMessageV1/V2, scope check, session sig verify
    │   │   ├── adapters/
    │   │   │   └── trust-signal.ts ← v0 partner eligibility gate (static dispatch)
    │   ├── app/                    ← Next.js App Router
    │   │   ├── api/                ← all HTTP routes (see §7)
    │   │   ├── pool/[id]/page.tsx  ← primary operator dashboard
    │   │   ├── customer/[id]/page.tsx
    │   │   ├── provider/[id]/page.tsx
    │   │   ├── obligation/[id]/page.tsx
    │   │   ├── login/, verify/    ← NextAuth pages
    │   │   ├── page.tsx           ← home
    │   │   └── layout.tsx
    │   └── components/
    │       ├── ReserveCard.tsx, ObligationTable.tsx, DelegationTable.tsx,
    │       │  ActivityFeed.tsx, DemoQuickstart.tsx, badges.tsx
    │       └── *.stories.tsx       ← Storybook seeds (run with `npm run storybook`)
    └── scripts/
        ├── prove.sh                ← UNIFIED proof runner — must always print 49/49
        ├── validate.sh             ← settlement substrate suite (12 scenarios; called from prove.sh)
        ├── demo-bounded-buyer.sh   ← end-to-end "agent charges + denied call" walkthrough
        ├── seed-authority-demo.ts  ← seeds Bolt Labs (self-custody) + auth-demo agent fixtures
        ├── test-authority-loop.ts  ← 9 positive checks (delegation → proxy → spend cap)
        ├── test-authority-guardrails.ts  ← 18 negative checks (revoked, expired, scope violations, replay)
        ├── test-trust-signal-gate.ts     ← 10 trust-signal adapter checks
        ├── openclaw-caller.ts             ← reference agent client
        ├── backfill-default-operator.ts   ← creates the operator User row
        ├── check-agent-key-readiness.ts   ← migration helper
        └── lib/
            ├── test-session.ts      ← mints an operator NextAuth JWT cookie (CLI: --print-cookie)
            └── check-auth-demo-fixture.ts
```

`agent-tab/.demo-state/authority-demo-root.json` holds the auth-demo's customer root key (mode 0600). `~/.chaincash-secrets/` holds Schnorr secret files used at redemption time (mode 0600); `reconcile.ts:ensureSecretFile` provisions them lazily from the DB and refuses to overwrite a pubkey-mismatched file.

---

## 4. The data model (Prisma)

`prisma/schema.prisma` defines **16 models** plus the four NextAuth tables. SQLite as the dev datastore. Every monetary field is **`BigInt` nanoCredits** (or nanoERG for chain-side amounts). Use the helpers in `src/lib/credits.ts` — never `parseFloat`, never `Number()` on a money field.

| Model | Role |
|---|---|
| `Provider` | Seller. Has tools, credit lines, obligations. `publicKey`/`privateKey` Schnorr pair. |
| `Customer` | Debt-bearer. `signingMode` ∈ {`tracker`, `self-custody`}. **`ownerUserId`** is the canonical link to a NextAuth `User` — this is the ownership root every guarded route checks. |
| `AgentIdentity` | One agent acting for one customer. `apiKeyHash` (HMAC) + `apiKeyPreview` (last 4 chars). **Raw `apiKey` is returned exactly once at POST creation and never stored.** `allowedToolIds` ("*" or comma-separated). |
| `Tool` | Provider's paid endpoint with `endpoint` URL and `costPerCall` (BigInt nanoCredits). |
| `CreditLine` | (provider, customer) spend ceiling. Unique pair. POST also upserts an `ObligationState` row. |
| `Delegation` | Bounded authority for a session keypair. Bound to one `AgentIdentity` (`agentIdentityId`; nullable for legacy unbound). Has `scopeProviderIds`, `scopeToolIds`, `spendCap`, `spentSoFar`, `expiresAt`, `authMessage`, `authSignature` (root-key signature). Status ∈ {active, expired, revoked, exhausted}. |
| `ObligationState` | THE current debt for (provider, customer). `version` is the optimistic-concurrency token. `latestSignedMessage`/`latestSignature` is the most recent committed update. `pendingAmount` lives between propose and commit. |
| `ObligationUpdate` | Append-only audit log of every charge/settlement. Carries the canonical message, signature, delta, type, nonce, and the delegation/agent that authorised it. |
| `Reserve` | On-chain ERG collateral UTXO. Has `reserveTokenId` (singleton), `trackerNftId` (which tracker it trusts), `boxId`, `valueNanoErg`, `avlTreeDigest`, `contractVersion`, `lifecycle`. |
| `UsageEvent` | One row per metered tool call. Includes `outcome` ("success", error codes). Drives the `/api/usage` view. |
| `SettlementEvent` | One row per obligation reduction. `redemptionTxId` is unique (dedup on-chain redemptions). `method` ∈ {manual, on-chain, ...}. |
| `PendingRedemption` | Redemption tx broadcast, not yet confirmed. Polled and reconciled by `recoverPending` and the operator-only recovery routes. |
| `TrackerBox` | The current on-chain tracker UTXO (NFT-stable). `treeDigestHex` is the AVL root. |
| `TrackerEntry` | One (debtor, creditor) entry in a tracker box's AVL tree. Unique per (trackerBoxId, debtor, creditor). |
| `TrackerDeployment` | **Legacy.** Kept for migration reference; new code uses `TrackerBox` + `TrackerEntry`. |
| `DebtTransfer` | Audit row for novation. Atomic: $transaction updates two obligations + creates the row. |
| `User`, `Account`, `Session`, `VerificationToken` | NextAuth (Prisma adapter). `User.role` ∈ {operator, customer}. **Session strategy is JWT** (see §6) so the `Session` table is empty at runtime. |

Money fields that predate the BigInt migration are flagged in `CLAUDE.md`'s "do not change without explicit approval" list: `Reserve`, `PendingRedemption`, `TrackerEntry` BigInt fields stay as-is.

---

## 5. Money convention (locked)

The single canonical constant is in `src/lib/credits.ts`:

```ts
export const NANOCREDITS_PER_CREDIT = BigInt(1_000_000_000);
```

- `1.00 credits` = `BigInt(1_000_000_000)` nanoCredits.
- `parseCredits("0.10")` → `BigInt(100_000_000)`. Strict regex `/^\d+(\.\d{1,9})?$/`. **Never** uses `parseFloat`. Rejects negatives (sign/zero are route-level concerns).
- `formatCredits(BigInt(100_000_000))` → `"0.10"`.
- `nanoCreditsToNanoErg(n)` → `n` in v1 (identity). The function exists so the conversion boundary is named and locatable for a future protocol phase.

Routes serialise BigInt to JSON with either `toJsonSafe` (`src/lib/json-safe.ts`) or manual `.toString()`. Error-detail bodies sometimes use a one-off `serializeBigInts` helper (e.g. `/api/reserves/reconcile-redemption`).

---

## 6. Auth model (the foundation)

NextAuth v4 with the Prisma adapter, **JWT session strategy** (intentional, see comment at `src/lib/auth.ts:13–37`). Email magic-link sign-in. In dev with no `EMAIL_SERVER`, the magic link prints to the dev server's stdout. In production with `EMAIL_SERVER` unset, sign-in **fail-closes**.

Middleware (`src/middleware.ts`) gates every page that is not under `/login`, `/api`, `/_next/*`, `/auth`, or `favicon.ico`. **`/api/*` is excluded from middleware** — every API route enforces its own auth via the helpers below.

### Auth helpers (`src/lib/auth.ts`)

| Helper | Returns | Throws |
|---|---|---|
| `requireSession()` | `SessionUser` (`{id, email?, name?, image?, role}`) | `HttpError(401, "unauthenticated")` if no session |
| `requireOperator()` | `SessionUser` | 401 then `HttpError(403, "operator role required")` |
| `requireCustomerOwned(customerId)` | `SessionUser` | 401 then 403 if missing OR foreign (operators bypass without DB lookup) |
| `ownedCustomerIds(user)` | `string[]` for customer-role, `null` for operator (= no scope filter) | n/a |
| `authErrorResponse(e)` | `NextResponse` JSON for `HttpError`; re-throws otherwise | n/a |

The cardinal rule established by the auth-foundation slices (7→11a):

> **`requireSession()` (or `requireOperator()`) is the FIRST statement inside every guarded handler — before any body parse, body-shape 400, or DB read.** Unauthenticated callers always receive 401, never a 400/404/409 leaked from body shape or resource state.

For two-resource routes (`/api/reserves/redeem`, `/api/debt/transfer`, `/api/delegations`), the pattern is **three-phase resolution**:

1. Phase 1 — load both rows (no role-aware decisions).
2. Phase 2 — role/ownership decision: operator → 404 differential; customer-role → **403 collapse** with body `{ error: "customer not owned by current user" }` for missing / foreign / one-foreign-one-owned variants. This is the "leak-surface rule" — a customer cannot enumerate ids by observing 400/404 vs 403.
3. Phase 3 — same-customer / same-debtor / equality checks (only reached after ownership confirmed).

`/api/reserves/redeem` additionally locks: `recoverPending(reserveId)` runs **after** phase 3, never before. A customer-role caller cannot trigger reconciliation on a foreign reserve.

### Agent API key auth (separate stack)

`/api/proxy` does NOT use sessions. It authenticates via `x-agent-api-key` header → `hashAgentApiKey(rawKey)` (HMAC-SHA256 with `AGENT_API_KEY_PEPPER`, env-required in prod with dev fallback) → `prisma.agentIdentity.findUnique({ apiKeyHash })`. Then checks `agentIdentity.status === "active"` and `customer.status === "active"`. Optional headers: `x-tool-id`, `x-session-pubkey`.

The raw `apiKey` is **never persisted**. It is generated in-memory by `POST /api/agent-identities`, hashed for `apiKeyHash`, previewed (last 4 chars) for `apiKeyPreview`, and returned exactly once in the 201 response. If the caller does not capture the response, the key is unrecoverable.

### Ownership topology

`Customer.ownerUserId` is the canonical ownership root. Every guarded customer-role route asks "does this `User.id` own the `Customer.id` in question, transitively through the row I'm about to touch?" — using `requireCustomerOwned(customerId)` for single-resource routes or inline `ownedCustomerIds(user).includes(customerId)` for routes that load rows first or need to check two ids in one lookup.

Reserves, obligations, delegations, agent identities, credit lines, settlements — none have a direct `ownerUserId` column. Ownership routes through `customer.ownerUserId`. This is intentional and consistent across all slices. **Do not add `ownerUserId` to a non-Customer model** without explicit approval — it would create a second source of truth.

---

## 7. Route surface (every `/api`)

26 route files. Classified by intended exposure (verified after Slice 11a):

### Public by design (auth infra)
- `GET/POST /api/auth/[...nextauth]` — NextAuth handler.

### Operator-only
- `POST /api/seed` — `NODE_ENV !== "production"` block + `requireOperator`. Wipes and re-seeds demo fixtures. Returns hardcoded `agent-key-demo-001/002/003` plus Bolt Labs `privateKey` and a `sessionPrivateKey`. Dev-only.
- `POST /api/customers` — `requireOperator`. Generates keypair; stores `privateKey`; assigns `ownerUserId = operator.id`. Strips `privateKey` from response.
- `POST /api/providers` — `requireOperator`. Same pattern.
- `POST /api/tools` — `requireOperator`.
- `POST /api/credit-lines` — `requireOperator`. $transaction creates credit line + upserts obligation row.
- `PATCH /api/credit-lines` — `requireOperator`. Edits limit/threshold/dueDays.
- `POST /api/reserves` — `requireOperator`. Calls sidecar `deployReserve`; stores reserve in `lifecycle="requested"`.
- `POST /api/reserves/reconcile-redemption` — `requireOperator`. Manual reconciliation of an on-chain redemption tx.
- `POST /api/reserves/recover-pending` — `requireOperator`. Polls Ergo node for confirmation on every `PendingRedemption` for a reserve; reconciles the confirmed ones.
- `POST /api/tracker/deploy` — `requireOperator`. Deploys a tracker box for a (reserve, obligation) pair. Calls sidecar `/tracker/deploy`. Records in `TrackerBox`/`TrackerEntry`.
- `GET /api/tracker/notes?debtorPubKey=…` — `requireOperator`. Returns all tracker notes for a debtor pubkey.
- `GET /api/tracker/keys/[pubkey]/status` — `requireOperator`. Aggregate key status: total debt, delegations, reserve placeholders.

### Owner-or-operator (customer-scoped)
- `GET /api/customers` — `requireSession`; customer-role scoped via `ownedCustomerIds`.
- `GET /api/credit-lines` — `requireSession`; customer-role scoped.
- `GET /api/usage` — `requireSession`; customer-role scoped to owned customers via optional `?customerId=`.
- `GET /api/pool/summary` — `requireSession`. Selector mode lists active reserves filtered by ownership; detail mode (`?reserveId=`) returns the full pool view (reserve + obligations + credit lines + delegations + tracker state + recent settlement & usage events).
- `GET /api/agent-identities` — `requireSession` first; then `requireCustomerOwned` if `?customerId=` provided. `apiKeyHash` always stripped on read.
- `POST /api/agent-identities` — body parsed first (minor stylistic deviation), then `requireCustomerOwned(body.customerId)`. Returns raw `apiKey` once.
- `GET /api/obligations/[id]/history` — `requireSession` first; `requireCustomerOwned(obligation.customerId)`.
- `GET /api/obligations/[id]/proof` — same.
- `GET, PATCH /api/reserves` — `requireSession` first + inline ownership scoping (slice 10b).
- `POST /api/reserves/redeem` — `requireSession`, three-phase ownership, `recoverPending` runs after phase 3, then sidecar `/reserve/redeem` + Ergo poll + reconcile.
- `POST /api/settle` — `requireSession`, inline ownership. Tracker-managed customers settle server-side; self-custody return a `canonicalMessage` for offline signing.
- `POST /api/debt/transfer` — `requireSession`, three-phase ownership before same-debtor check.
- `GET, POST, DELETE /api/delegations` — `requireSession`, two-phase customer resolution (slice 9). Self-custody only on POST. `agentIdentityId` mandatory.

### Agent-key authenticated
- `POST /api/proxy` — `x-agent-api-key`. Validates agent + customer + tool allowlist + credit line + obligation; calls `tracker.proposeNoteUpdate`; for tracker-managed customers signs server-side; for self-custody returns `pendingSignature: true` plus `canonicalMessage` + `obligationId` + `updateId` + `delegationId` for the agent to sign and POST back to `/api/obligations/[id]/sign`. Logs `UsageEvent`. Forwards to upstream tool URL.

### Defense-in-depth gap (Slice 11b candidate)
- `POST /api/obligations/[id]/sign` — **NO app-layer auth.** Validates the signature cryptographically inside `tracker.commitNoteUpdate` (so unauthorised forgery is impossible), but anyone with a valid signature could replay/race a submission. UI (`customer/[id]/page.tsx`), TS scripts (`test-authority-loop`, `test-authority-guardrails`, `openclaw-caller`).

### Dev/test only (Slice 11a)
- `POST /api/demo-tool/analyze` — `NODE_ENV === "production"` → 403 first; else returns text metrics.
- `POST /api/demo-tool/completion` — same guard FIRST, then `UPSTREAM_LLM_API_KEY` read, then Anthropic Messages API call. Production-disabled.
- `POST /api/demo-tool/summarize` — same guard pattern.

These are stand-in "external tools" used by the seed fixtures so the proxy has something to forward to. In production, real provider services should be the `tool.endpoint` value — these dev fixtures fail closed.

### Outstanding audit findings (deferred slices, see Slice 11 audit plan)
- **Slice 11b** — Gate `/api/obligations/[id]/sign` (session OR agent-key).
- **Slice 11c** — Gate `GET /api/providers` and `GET /api/tools` (currently unauth catalog reads; expose customer↔provider↔debt graph).
- **Slice 11d** — Add `PATCH /api/agent-identities/[id]` (revoke) and/or `POST /api/agent-identities/[id]/rotate`. Status column already exists.
- **Slice 11e** (optional cleanup) — Move `requireSession` ahead of body parse in `POST /api/agent-identities`.

---

## 8. Core libraries (the off-chain substrate)

### `src/lib/tracker/service.ts` (762 lines)

The off-chain note service. Owns: obligation state, propose/commit transitions, delegation verification, proof generation, key status, note history. Does NOT own: agent auth, UI, tool proxying, usage logging, credit line management — those are app-layer.

Key APIs:
- `tracker.proposeNoteUpdate({debtorPubKey, creditorPubKey, delta, expectedVersion, requestId, sessionPubKey?, agentIdentityId?, customerId?, toolId?, …}, signingKeyOrUndefined)` — main metering entrypoint. Verifies delegation scope when sessionPubKey is supplied. For tracker-managed (server-signed) flow, signs the canonical message and persists a committed `ObligationUpdate`. For self-custody, persists pending and returns the canonical message + updateId. 15-minute TTL on pending updates.
- `tracker.commitNoteUpdate({noteId, updateId, signature, delegationId})` — accepts a session or root signature, verifies, advances pending → committed. **Called by `/api/obligations/[id]/sign`.**
- `tracker.createDelegation({…})` / `tracker.revokeDelegation(id)` — delegation lifecycle.
- `tracker.getNotesForKey(pubkey)`, `tracker.getKeyStatus(pubkey)`, `tracker.getNoteHistory(noteId)`, `tracker.getNoteProof(noteId)` — read APIs used by tracker routes and obligation history/proof routes.

Errors throw `TrackerError` with a `code` (e.g. `SIGNATURE_INVALID`, `UPDATE_EXPIRED`, `DELEGATION_EXPIRED`, `DELEGATION_INVALID`, `DELEGATION_SCOPE_VIOLATED`). Consumers convert to HTTP 400/403/409/410 by code.

### `src/lib/tracker/delegation.ts` (114 lines)

`buildDelegationMessageV1`/`V2` build the canonical bytes. `verifyDelegationAuth` checks the root-key signature on `Delegation.authMessage`. `checkDelegationScope({delegation, providerId, toolId, deltaNanoCredits})` enforces scope (provider/tool match) AND `spentSoFar + delta <= spendCap` AND not-expired/revoked/exhausted. `verifySessionSignature` verifies a session keypair signed an obligation update.

### `src/lib/reconcile.ts` (586 lines)

The most complex business logic file. Public surface:
- `reconcileRedemption({reserveId, obligationId, redemptionTxId, grossRedeemNanoErg, feeNanoErg?, netPayoutNanoErg?})` — idempotent. Looks up SettlementEvent by `redemptionTxId` first; if exists, returns it (dedup). Otherwise creates SettlementEvent, decrements obligation, marks PendingRedemption reconciled.
- `recoverPending(reserveId)` — iterates `prisma.pendingRedemption` for the reserve; polls Ergo node for confirmation on each via sidecar; reconciles confirmed.
- `computeCumulativeTrackerDebt(customerId, debtorPubKey, creditorPubKey, hypotheticalCurrentNanoErg)` — computes `previouslyRedeemedNanoErg` and `totalDebtNanoErg` based on tracker entries + outstanding obligation. Used by redeem and debt-transfer guardrails (the redeemed-floor constraint).
- `ensureTrackerAligned(reserveId, debtorPubKey, creditorPubKey)` — checks if a tracker box exists for the pair; if not, deploys one via the sidecar (auto-deploy from the redeem path).
- `recordTrackerDeployment({…})` — persists a `TrackerBox` + `TrackerEntry` row after a sidecar deploy.
- `gatherExistingReserveEntries(reserveTokenId)` — gets the current tracker AVL entries for a reserve.
- `ensureSecretFile("owner"|"receiver", pubKeyHex, secretHex)` — provisions `~/.chaincash-secrets/{role}-{first8hex}.json` lazily from the DB. Refuses to overwrite a pubkey-mismatched file.

Polling windows: `REDEEM_POLL_*` and `TRACKER_POLL_*` constants — extended in `DEMO_MODE=true`.

Errors throw `ReconcileError(message, statusCode)`.

### `src/lib/sidecar-client.ts` (113 lines)

Thin HTTP wrapper around the JVM sidecar. Methods: `getSidecarHealth`, `getNetworkHeight`, `deployReserve`, `getReserveStatus`, `redeemFromReserve`, `deriveContractVersion`, etc. Base URL from `SIDECAR_URL` env (default `http://localhost:8081`).

### `src/lib/crypto.ts`

Schnorr keypair generation, `signMessage`, `verifySignature`, `buildCanonicalMessage(debtorPubKey, creditorPubKey, cumulativeAmount, version, timestamp)`. Uses `@noble/secp256k1`.

### `src/lib/agent-key-hash.ts`

`hashAgentApiKey(rawKey)` → `HMAC-SHA256(pepper, rawKey).hex()`. Pepper from `AGENT_API_KEY_PEPPER` env. **In production, throws if unset.** In dev, falls back to `agent-credit-dev-pepper-not-for-prod` and emits a one-time console warning (visible in prove.sh output). `previewAgentApiKey(rawKey)` → `"…XXXX"` (last 4 chars).

### `src/lib/json-safe.ts`

`toJsonSafe(value)` recursively converts `BigInt` → string for JSON serialisation. Use it on any response that contains BigInt fields. The alternative is manual `.toString()` on each field.

### `src/lib/adapters/trust-signal.ts`

The "partner trust-signal gate" v0. Static dispatch only — `KNOWN_ISSUERS = { ... }` map; one entry per partner. Throws `TrustSignalError` with code `UNKNOWN_ISSUER`, `INVALID_SIGNAL`, or `MALFORMED_REQUEST`. Pure in-process; no DB writes; no IO. Adding a partner means appending to the map.

`test-issuer-v0` is a v0 fixture issuer used by the proof stack; only accepts the literal signal `"valid-test-signal"`.

---

## 9. The critical end-to-end flow (proxy → tracker → reserve → reconcile)

Walk through one tool call end-to-end. This is the spine of the system.

1. **Agent** calls `POST /api/proxy` with `x-agent-api-key`, `x-tool-id`, `x-session-pubkey?`, body forwarded to upstream.
2. `/api/proxy` looks up `AgentIdentity` by hash; checks status; loads tool, credit line, current obligation. Verifies the tool is allowed.
3. Computes `delta = tool.costPerCall`. Checks credit line capacity (`obligation.currentAmount + delta ≤ creditLine.limitAmount`). 402 if over.
4. Calls `tracker.proposeNoteUpdate({delta, expectedVersion: obligation.version, sessionPubKey?, agentIdentityId, customerId, toolId, ...}, signingKey)`.
   - **Tracker-managed customer** (`signingMode = "tracker"`): server signs with stored `customer.privateKey`. Update goes straight to committed; obligation's `currentAmount`, `version`, `latestSignedMessage`, `latestSignature` advance. Returns committed amounts.
   - **Self-custody customer**: server uses delegation's session pubkey (if `sessionPubKey` provided). Persists the update as **pending** with a 15-min TTL. Returns `pendingSignature: true`, `canonicalMessage`, `updateId`, `obligationId`, `delegationId`.
5. `/api/proxy` writes a `UsageEvent` with `outcome` ("success", error code, etc.).
6. `/api/proxy` forwards the body to `tool.endpoint` and returns `{toolResponse, toolStatus, tab: {balance, pending, limit, remaining, ...}, pendingSignature?, canonicalMessage?, …}`.
7. **If self-custody**: the agent (or customer's offline signer) signs the canonical message with the session private key and POSTs `{updateId, signature, delegationId}` to `/api/obligations/[id]/sign`. `tracker.commitNoteUpdate` verifies the signature against the session pubkey, checks the delegation, advances pending → committed.
8. Eventually the customer wants to settle. They call `POST /api/settle` (manual) or initiate a redemption via `POST /api/reserves/redeem`.
9. **Redemption flow** (`/api/reserves/redeem`):
   - Phase 1 — load reserve + obligation.
   - Phase 2 — auth/ownership.
   - Phase 3 — same-customer equality.
   - `recoverPending(reserveId)` first (now safely after auth/ownership/equality).
   - Reserve precondition (`boxId` present, contract version, R5 digest pre-check via sidecar `getReserveStatus`).
   - `ensureTrackerAligned` — if no tracker box or stale, deploys one via sidecar (auto-deploy).
   - `ensureSecretFile` for owner + receiver.
   - Sidecar `/reserve/redeem` → returns redemption tx; submitted to Ergo.
   - Poll Ergo node for confirmation (windows from `REDEEM_POLL_*`).
   - On confirmation: `reconcileRedemption` writes SettlementEvent, decrements obligation, updates reserve.
   - On timeout: persist `PendingRedemption`; later operator runs `/api/reserves/recover-pending` to drain.

---

## 10. Proof stack (49/49)

**Always run before AND after any change:** `cd agent-tab && bash scripts/prove.sh`.

The runner mints an operator NextAuth cookie via `scripts/lib/test-session.ts --print-cookie` (fail-loud if `NEXTAUTH_SECRET` missing or no operator user — run `npm run backfill:operator` to seed the operator). Then it runs four suites and aggregates:

| Suite | Driver | Checks | What it proves |
|---|---|---|---|
| Settlement substrate | `validate.sh` | 12 | On-chain redemption (v1, v2), R5 drift, recovery, contract version derivation, debt transfer (cross-debtor, self, negative, insufficient) |
| Authority loop (positive) | `test-authority-loop.ts` | 9 | Delegation create → proxy call with `x-session-pubkey` → server signs → `/sign` commits → spend cap decrements; agent binding persisted |
| Authority guardrails (negative) | `test-authority-guardrails.ts` | 18 | Wrong scope / expired / exceeded cap / revoked / wrong agent / cross-delegation — all rejected without mutation; counter-checked against DB |
| Trust-signal gate (v0) | `test-trust-signal-gate.ts` | 10 | Static dispatch: valid signal accepted; invalid rejected; unknown issuer; malformed (issuer-without-signal, signal-without-issuer); no DB mutation on rejection |

49/49 is the floor. Slices may **add** checks but must never lower the bar. The README still claims 39/39; the trust-signal suite was added later (slice 9 era) — the live count is 49. The authority suites require the auth-demo fixture (`npx tsx scripts/seed-authority-demo.ts`); if absent, prove.sh skips them and prints "22/22 (authority not tested)".

`validate.sh` threads the operator cookie into every cookie-required curl (10 in slice 10b's wave, more elsewhere). New work that adds a guarded route called from `validate.sh` MUST thread the cookie too — silent unauthenticated curls are a regression.

---

## 11. Scripts and demos

| Script | Purpose |
|---|---|
| `scripts/prove.sh` | Unified runner. **Always run before reporting work done.** |
| `scripts/validate.sh` | Settlement substrate (12 scenarios). Called from prove.sh. Mints operator cookie at the top; threads into every curl. |
| `scripts/demo-bounded-buyer.sh` | End-to-end "agent charges bound-by-cap → denied call after exhaustion" walkthrough. UI evidence on `/pool/auth-demo-reserve-001`. |
| `scripts/seed-authority-demo.ts` | Seeds Bolt Labs (self-custody) + auth-demo agent fixtures. `--cleanup` removes them. Root key file in `agent-tab/.demo-state/`. |
| `scripts/test-authority-loop.ts` | Authority positive checks. |
| `scripts/test-authority-guardrails.ts` | Authority negative checks. |
| `scripts/test-trust-signal-gate.ts` | Trust-signal adapter checks. |
| `scripts/openclaw-caller.ts` | Reference agent client used by demos. Useful as a template for "how does an agent call the API". |
| `scripts/backfill-default-operator.ts` | Creates the default operator User row if absent. Run once after a fresh DB. (`npm run backfill:operator`) |
| `scripts/check-agent-key-readiness.ts` | Migration helper from slices 7/8 era. |
| `scripts/lib/test-session.ts` | Mints an operator JWT cookie. CLI: `--print-cookie` (used by validate.sh / prove.sh). |
| `scripts/lib/check-auth-demo-fixture.ts` | Predicate: returns 0 if the auth-demo fixture is present. |

`package.json` is intentionally minimal — only `dev`, `build`, `lint`, `backfill:operator`, `storybook`, `build-storybook`. Everything heavy goes through bash/tsx scripts so it can be auditable and shell-callable.

---

## 12. UI pages

- **`/`** (`src/app/page.tsx`) — home; lists providers and customers; can trigger `/api/seed`.
- **`/login`**, **`/verify`** — NextAuth pages.
- **`/pool`** (`src/app/pool/page.tsx`) — pool selector. Lists active reserves filtered to ownership.
- **`/pool/[id]`** (`src/app/pool/[id]/page.tsx`) — **the primary operator dashboard.** Reserve health, obligation readiness, tracker state, settlement history, recent agent activity, delegations with utilisation. Calls `/api/pool/summary?reserveId=`, `/api/reserves` PATCH (Refresh), `/api/reserves/redeem` (Redeem).
- **`/customer/[id]`** (`src/app/customer/[id]/page.tsx`) — customer detail. Calls `/api/customers`, `/api/usage?customerId=`, `/api/tools`, `/api/settle`, `/api/agent-identities`, `/api/obligations/[id]/sign`.
- **`/provider/[id]`** (`src/app/provider/[id]/page.tsx`) — provider detail. Lists tools, credit lines, customers; can create credit lines and tools.
- **`/obligation/[id]`** (`src/app/obligation/[id]/page.tsx`) — obligation drilldown. Calls `/api/obligations/[id]/proof`, `/api/obligations/[id]/history`.

Components live in `src/components/`. Storybook is wired (`npm run storybook`) — `*.stories.tsx` files seed components. There is also a `frontend/mission-control` branch with active component extraction work and a stated UI design intent: **mission control for agent commerce, not fintech/wallet/crypto**.

Browser fetches are same-origin and rely on the NextAuth cookie travelling automatically. UI code does NOT need `credentials: "include"`.

---

## 13. Environment variables and secrets

| Var | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | SQLite file path for Prisma | yes |
| `NEXTAUTH_SECRET` | JWT signing | yes |
| `NEXTAUTH_URL` | Base URL for NextAuth callbacks | yes |
| `EMAIL_SERVER`, `EMAIL_FROM` | Magic-link SMTP (prod fail-closed if unset in NODE_ENV=production) | dev: optional (logs to stdout); prod: required |
| `AGENT_API_KEY_PEPPER` | HMAC pepper for agent-key hashing. Prod throws if unset; dev falls back with a warning. | prod: required |
| `SIDECAR_URL` | Sidecar HTTP base. Default `http://localhost:8081`. | no (default) |
| `ERGO_NODE_API_KEY` | Ergo node API key. Default `hello`. | no (default) |
| `UPSTREAM_LLM_API_KEY` | Anthropic key forwarded by `/api/demo-tool/completion`. **Demo only — Slice 11a now production-disables the route, so this key cannot be burned via the public surface in production.** | dev: optional (route returns 503 without it) |
| `DEMO_MODE` | Extends sidecar polling windows for slow demo block times. | dev: recommended |

Secrets on disk:
- `agent-tab/.demo-state/authority-demo-root.json` — auth-demo customer root key, mode 0600.
- `~/.chaincash-secrets/{owner|receiver}-{first8hex}.json` — Schnorr secret files for redemption signing, mode 0600. Provisioned lazily from the DB by `reconcile.ts:ensureSecretFile`. Refuses to overwrite a pubkey-mismatched file.

In SQLite: customer `privateKey`, provider `privateKey`, delegation session pubkeys are plaintext (testnet acceptable; production needs HSM/encryption). The agent **`apiKeyHash`** is HMAC-hashed; the raw key is never persisted.

---

## 14. Conventions, do's, and don'ts

### Hard floors (from `CLAUDE.md` and locked-decision history)
- `chaincash/` is **off-limits** to app-layer work. Do not edit unless explicitly told.
- `NANOCREDITS_PER_CREDIT` and the nanoCredits storage convention do not change.
- The 49/49 proof stack is the floor. Add checks; never lower the bar.
- `Reserve`, `PendingRedemption`, `TrackerEntry` BigInt fields are pre-migration and stay as-is.

### Auth-foundation convention (slices 7 → 11a)
- `requireSession()` (or `requireOperator()`) is the **first** statement inside every guarded handler. Body parse comes after.
- For two-resource routes, three-phase resolution: **load → ownership → equality**. Never reverse.
- Customer-role users get **403 collapse** on missing/foreign/ownership-not-yet-established. Operators get 404 differential. Same body for the customer collapse: `{ error: "customer not owned by current user" }`.
- `recoverPending` (and any side-effect-producing helper) only runs after auth+ownership.
- Side-effect counter validation (Reserve, SettlementEvent, DebtTransfer, TrackerBox, PendingRedemption, ObligationUpdate) is scoped to **phase 2 (custom no-op auth probes)** of any new slice's validation. Phase 3 (regression) may legitimately mutate state.

### Money handling
- All monetary fields are `BigInt` nanoCredits. Use `parseCredits` / `formatCredits` / `nanoCreditsToNanoErg`. **Never** `parseFloat`. Sign and zero are route-level concerns.
- BigInt JSON serialisation: `toJsonSafe()` or manual `.toString()`. Do not `JSON.stringify(bigInt)` without conversion — it throws.

### Agent keys
- The raw `apiKey` is generated by `crypto.randomUUID()` inside `POST /api/agent-identities`, hashed and previewed for storage, returned exactly once. Never persisted.
- Do not add an endpoint that returns `apiKeyHash`. Do not add an endpoint that returns the raw `apiKey` outside the one-time create flow.

### Delegations
- Always agent-bound (`agentIdentityId` mandatory on POST since slice 9). Self-custody only.
- Trust signal: both issuer and signal must be present together or both absent. Mismatch is `MALFORMED_REQUEST`.

### Validation discipline
- `npm run build` exits 0 (Next.js typecheck).
- New cookie-requiring scripts thread the operator cookie via `scripts/lib/test-session.ts`.
- New auth changes that affect `validate.sh` curls must update the cookie threading.
- Custom phase-2 probes are no-op only — no successful mutation. Use bogus ids, foreign ids, mismatched ids, or pre-existing 409 preconditions.
- Probes that go through the sidecar must be read-only (e.g. `getReserveStatus`) or they violate "no value-moving operation."

### What you should NOT do
- Do not add `ownerUserId` columns to non-`Customer` models.
- Do not bypass `requireSession` with a query-param flag or env switch (`?dev_bypass=…` is forbidden).
- Do not mock the database in tests — integration tests must hit a real DB (CLAUDE.md memory rule).
- Do not `--no-verify` or skip hooks unless explicitly requested.
- Do not refactor unrelated code in a slice. Each slice has a tight scope; keep the diff small and reviewable.
- Do not add documentation files (`*.md`, README*) unless the user explicitly asks. (You are reading one because the user asked.)

### Don't worry about
- The README's "39/39" claim — current floor is 49/49. The README is slightly stale.
- The legacy `TrackerDeployment` model — keep it for migration reference; new code uses `TrackerBox`/`TrackerEntry`.

---

## 15. Auth-foundation slice progression (recent history)

The current branch is `auth/foundation`. Recent commits (newest first):

| Commit | Slice | What it did |
|---|---|---|
| `91d8aed` | **11a** | Production-disable `/api/demo-tool/{analyze,completion,summarize}`. Guard is the FIRST statement; in `completion` it precedes the env-key read. |
| `dca4952` | **10b** | Owner-or-operator guard on `GET/PATCH /api/reserves`, `POST /api/reserves/redeem`, `POST /api/settle`, `POST /api/debt/transfer`. `recoverPending` moved past auth/ownership/equality. |
| `1950a6b` | **10** | Operator-gate the money-adjacent admin routes (`POST /api/reserves`, `POST /api/reserves/reconcile-redemption`, `POST /api/reserves/recover-pending`, `POST /api/tracker/deploy`, `GET /api/tracker/notes`, `GET /api/tracker/keys/[pubkey]/status`). |
| `1d3def9` | **9** | Gate `/api/delegations` GET/POST/DELETE behind session + ownership. Two-phase customer resolution. Trust-signal adapter integrated. Agent binding on POST mandatory. |
| `770974b` | **8B-2** | Drop the raw `apiKey` column entirely; route now generates raw → hash → preview → return-once. |
| `8ae4491` | **8B-1** | Add `apiKeyPreview` ("…XXXX") column. |

The Slice 11 audit (current plan file `/home/fitz/.claude/plans/plan-mode-only-do-joyful-squid.md`) inventories all 26 routes, classifies their target exposure, and ranks remaining work by blast radius. Outstanding slices (deferred): 11b (`/sign` defense in depth), 11c (catalog reads), 11d (agent revoke/rotate).

---

## 16. Where to look for X

| If you need to … | Look at … |
|---|---|
| Understand the thesis | `Agent_Credit_Whitepaper.md`, `README.md`, `docs/milestone-summary.md` |
| Read the data model | `agent-tab/prisma/schema.prisma` |
| Find/edit a money helper | `agent-tab/src/lib/credits.ts` |
| Add an auth guard to a route | `agent-tab/src/lib/auth.ts` (helpers) + an existing slice-9/10b route as template |
| Trace metering | `agent-tab/src/app/api/proxy/route.ts` → `agent-tab/src/lib/tracker/service.ts` (`proposeNoteUpdate`) |
| Trace settlement / on-chain redemption | `agent-tab/src/app/api/reserves/redeem/route.ts` → `agent-tab/src/lib/reconcile.ts` |
| Add a tracker behaviour | `agent-tab/src/lib/tracker/service.ts` and `delegation.ts` |
| Add a partner trust signal | `agent-tab/src/lib/adapters/trust-signal.ts` (append to `KNOWN_ISSUERS`) |
| Run all proofs | `cd agent-tab && bash scripts/prove.sh` |
| See what's tested in settlement | `agent-tab/scripts/validate.sh` |
| Mint a test cookie for a script | `npx tsx scripts/lib/test-session.ts --print-cookie` |
| Reset the demo fixture | `POST /api/seed` (operator session) or `npx tsx scripts/seed-authority-demo.ts [--cleanup]` |
| Write a new agent client | Use `agent-tab/scripts/openclaw-caller.ts` as a template |
| Find a UI page | `agent-tab/src/app/<route>/page.tsx` (App Router) |
| Add a UI component | `agent-tab/src/components/`; if visual, add a `*.stories.tsx` |
| Understand the chain side | Read the sidecar HTTP API surface from `agent-tab/src/lib/sidecar-client.ts`; do not edit `chaincash/` |
| See the active plan | `/home/fitz/.claude/plans/plan-mode-only-do-joyful-squid.md` |

---

## 17. Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `prove.sh` health-check 401 on `/api/reserves` | `NEXTAUTH_SECRET` unset or operator user missing | Set `NEXTAUTH_SECRET`; `npm run backfill:operator` |
| Sidecar 502 "could not reach Anthropic" via `/api/demo-tool/completion` | `UPSTREAM_LLM_API_KEY` unset (dev) | Set the env var or accept the existing 503 path |
| Redeem returns 202 `pending` | Block confirmation slow on testnet | Operator runs `/api/reserves/recover-pending` later, or it auto-recovers on the next redeem call's `recoverPending` |
| `ensureSecretFile` throws "exists but pubKeyHex mismatches" | Stale secret from a previous fixture | Manually `rm ~/.chaincash-secrets/{file}` (review first; do not auto-delete) |
| `[agent-key-hash] AGENT_API_KEY_PEPPER not set; using dev fallback` warning | Expected in dev | Ignore in dev. In prod, the helper THROWS instead. |
| Customer-role user gets 403 on a route they "should" access | Verify `Customer.ownerUserId === User.id`. Possibly the operator-seeded fixture didn't link them. | Re-seed via `/api/seed` (it sets `ownerUserId = operator.id`) or fix manually in DB. |
| `/api/proxy` returns 402 Payment Required | Credit line full | Operator raises `creditLine.limitAmount` via PATCH or settle the obligation |
| `/api/proxy` returns 409 `DELEGATION_SCOPE_VIOLATED` | Delegation scope mismatch or spend cap exhausted | Inspect the delegation; create a new one with the right scope/cap |
| Test scripts can't resolve `next-auth/jwt` | Helper script placed outside `agent-tab/scripts/` | Move helpers under `agent-tab/scripts/` so node_modules resolves |
| `tsx -e` "Top-level await is currently not supported with the cjs output format" | Inline tsx evaluator complaint | Wrap in `async function main(){...} main();` |

---

## 18. When you encounter something unfamiliar

The codebase is opinionated. If a piece of code looks "wrong":

- **Read `CLAUDE.md` first.** Most surprises are intentional locked decisions.
- **Read the relevant slice's commit message.** Each commit has a body explaining what it locks down.
- **Read the active plan file** (`/home/fitz/.claude/plans/plan-mode-only-do-joyful-squid.md`). It documents the latest decisions, leak-surface rules, and validation discipline in detail.
- **Search for the locked rule.** The codebase often has comments like "Locked rule: …", "Order-of-checks rationale", "do not move recoverPending back to the top."
- **Ask before changing.** Especially for: `/api/proxy`, agent-key hashing, delegation v1/v2 message layout, `recoverPending` ordering, the `ownerUserId` ownership root, the BigInt money convention, the proof stack baseline. These are floors, not ceilings.

When you must touch the chain layer (`chaincash/`), the sidecar protocol, or the Basis contract — **stop and ask.** That layer is owned by separate work and changing it without alignment will break invariants the proof stack does not currently catch.

---

## TL;DR (one-screen orientation)

- Three processes: Next.js app `:3000`, JVM sidecar `:8081`, Ergo node `:9052`. App-layer work happens in `agent-tab/`; never edit `chaincash/` without explicit go-ahead.
- All money is `BigInt` nanoCredits via `src/lib/credits.ts`. `1.00 credits = 1e9 nanoCredits`. Use `parseCredits`/`formatCredits`/`toJsonSafe`.
- Auth: NextAuth JWT sessions, `requireSession`/`requireOperator`/`requireCustomerOwned`/`ownedCustomerIds` from `src/lib/auth.ts`. Every guarded handler calls `requireSession()` FIRST. `Customer.ownerUserId` is the canonical ownership root.
- Two-resource routes use three-phase resolution: load → ownership → equality. Customer-role 403 collapse for missing/foreign. Operator 404 differential.
- Agent calls `/api/proxy` with `x-agent-api-key` (HMAC-hashed). Self-custody flow returns a `canonicalMessage` to be signed offline and POSTed to `/api/obligations/[id]/sign` (currently the only known unauth defense-in-depth gap, slice 11b candidate).
- Settlement = on-chain ERG redemption against a reserve UTXO via the sidecar; reconciliation in `lib/reconcile.ts`. `recoverPending` runs only after auth/ownership.
- **Always run `cd agent-tab && bash scripts/prove.sh` — must print `49/49` — before AND after any change.** Add checks; never lower the bar.
- The active plan file is the source of truth for in-flight slice work.
