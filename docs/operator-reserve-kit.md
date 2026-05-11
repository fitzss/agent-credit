# Agent Tab Operator Reserve Kit — slice 16a-core

> **What this is:** the smallest safe foundation for running Agent
> Tab against a reserve you (the operator) own and sign for, on
> testnet, with no service in the loop taking custody of your funds.
>
> **What this is NOT:** *not* full production self-custody yet, *not*
> mainnet, *not* a settlement path. Settlement against an
> operator-owned reserve is deferred to **slice 16c**; the
> redeem-route guardrails that make operator-mode safe end-to-end
> are deferred to **slice 16b**. This slice (16a-core) only lays the
> identity + manifest foundation and proves it doesn't disturb the
> existing demo / canonical state.

## The shape

```
agent-tab/.demo-state/operator-key.json          (mode 0o600, gitignored)
       │  publicKey + privateKey on your machine
       ▼
agent-tab/scripts/operator-reserve-init.ts
       │
       │  --prepare  → sidecar /reserve/deploy (no broadcast)
       │              → DB Customer "Self-Custody Operator"
       │              → DB Reserve at lifecycle=requested
       │              → operator-reserve.json (manifest)
       │              → operator-reserve-deploy.json (unsigned deploy spec)
       │
       │  --sync     → PATCH /api/reserves (scan from chain)
       │              → DB Reserve lifecycle requested → active (after the
       │                operator submits the deploy tx via their wallet)
       │              → proof-of-control re-verified against on-chain R4
       │              [Implemented in 16a-core. The "requested → active"
       │               transition has NOT been end-to-end validated in this
       │               slice — see "Status of validation" below.]
       │
       │  --status   → READ-ONLY: DB + sidecar + files + proof-of-control
       │
       ▼
Operator submits the deploy tx via THEIR OWN Ergo wallet — Agent
Tab does not move ERG.
```

## Boundary (plain English)

The bullets below describe the **software**, not legal posture.
Operators considering mainnet should consult counsel — this
documentation is *not legal advice*.

1. **Agent Tab does not custody funds.** Every reserve is a UTXO on
   Ergo, controlled by the operator's private key. The key never
   leaves your machine. Agent Tab software (running locally) signs
   redemption transactions later (16c) using a key you placed at
   `~/.chaincash-secrets/`. No service has it.
2. **Agent Tab does not accept third-party deposits.** The reserve
   is funded by you, from your own Ergo wallet, via the standard
   `/wallet/transaction/send` flow. The Agent Tab dev server does
   not intermediate.
3. **Agent Tab does not pool user funds.** Each reserve is
   single-customer, single-operator-owned.
4. **Agent Tab cannot move funds without your action.** Every
   redemption (16c) is triggered by an authenticated request that
   you make. The Basis contract requires your Schnorr signature
   on-chain; no off-chain code path can substitute.
5. **Agent Tab 16a-core is testnet-only.**
   `ERGO_NETWORK=testnet` is required. Mainnet throws.
6. **This is not full production self-custody yet.** 16a-core is
   the foundation. Operator-owned **settlement** is 16c (with 16b
   adding the server-side redeem-route guards). Production
   self-custody — with mainnet, settlement caps, typed
   per-redemption confirmation, separate operator-wallet guidance,
   and operator-key rotation — is a later slice.
7. **You are responsible for your own funds.** Running Agent Tab
   does not transfer that responsibility.

## Prerequisites

- An Ergo **testnet** node running locally at
  `http://localhost:9052` (see `CLAUDE.md` → "Start services").
- The ChainCash sidecar running at `http://localhost:8081`.
- The Agent Tab dev server running at `http://localhost:3000`.
- `ERGO_NETWORK=testnet` set in `agent-tab/.env` (see
  `agent-tab/.env.example`).
- A funded testnet wallet (you'll submit the deploy tx with it).

## File layout under `agent-tab/.demo-state/`

All three files are gitignored. Never commit any of them.

### `operator-key.json` — mode `0o600` — sensitive

Contains your private signing key.

```json
{
  "publicKey": "<66-char lowercase hex, compressed secp256k1>",
  "privateKey": "<64-char lowercase hex, 32-byte scalar>",
  "generatedAt": "<ISO 8601, present iff --generate-keypair was used>",
  "generatedBy": "operator-reserve-init.ts --prepare --generate-keypair",
  "note": "DO NOT COMMIT. Testnet operator signing key. For mainnet, replace with a key from a wallet that handles secure entropy and backup."
}
```

If you supplied your own key, use the same `publicKey`/`privateKey`
field names and the same hex shapes; `generatedAt` and
`generatedBy` may be omitted.

### `operator-reserve.json` — mode `0o644` — safe to inspect

The manifest. Contains the **public** key only — no private key
material is ever written here.

```json
{
  "kind": "operator-reserve-manifest",
  "version": "16a-core",
  "reserveId": "<UUID>",
  "reserveTokenId": "<hex64>",
  "trackerNftId": "<hex64>",
  "operatorCustomerId": "<UUID>",
  "operatorPublicKey": "<hex66>",
  "reserveAddress": "<base58 P2S>",
  "network": "testnet",
  "lifecycle": "requested" | "active",
  "initialCollateralNanoErg": "<bigint as string>",
  "preparedAt": "<ISO>",
  "syncedAt": "<ISO> | null",
  "proofOfControl": {
    "message": "agent-tab-operator-reserve-init|<reserveTokenId>|<trackerNftId>",
    "signature": "<hex>",
    "verifiedAt": "<ISO>",
    "verifiedAgainst": "operator-key.json" | "on-chain-R4"
  },
  "deploySpecPath": ".demo-state/operator-reserve-deploy.json",
  "note": "Local self-custodial operator reserve (slice 16a-core)..."
}
```

### `operator-reserve-deploy.json` — mode `0o600` — sensitive-ish

The unsigned deploy spec returned by the sidecar. Submit the
`deploymentRequestJson` via your wallet.

```json
{
  "kind": "operator-reserve-deploy-spec",
  "deploymentRequestJson": { /* unsigned tx; do not commit */ },
  "reserveAddress": "<base58 P2S>",
  "scanRequestJson": { /* node scan request */ },
  "network": "testnet",
  "writtenAt": "<ISO>",
  "writtenBy": "operator-reserve-init.ts --prepare",
  "note": "Submit deploymentRequestJson via your Ergo testnet wallet. Do not commit; .demo-state/ is gitignored."
}
```

## Operator flow (testnet)

### 1. First-time setup

```bash
cd agent-tab
# in your .env: ERGO_NETWORK=testnet
npx tsx scripts/operator-reserve-init.ts --prepare \
  --reserve-token-id <hex64> \
  --tracker-nft-id   <hex64> \
  --initial-collateral-erg 0.5 \
  --generate-keypair
```

What this does, in order, with no broadcast and no DB write until
every check has passed:

1. Asserts `ERGO_NETWORK=testnet`.
2. Asserts the sidecar reports testnet (`/health`).
3. Refuses if any input id collides with a canonical fixture id.
4. Generates a keypair via `@noble/secp256k1` v3 (the same
   primitive `agent-tab/src/lib/crypto.ts` already uses for every
   existing self-custody key — see `seed-authority-demo.ts`).
5. Runs the **keygen self-test**: re-derives pubkey from privkey,
   signs and verifies a known string. Aborts before any DB write
   if either fails.
6. Calls sidecar `/reserve/deploy` (non-broadcasting; returns an
   unsigned deploy spec + `reserveAddress` + `scanRequestJson`).
7. Signs the proof-of-control challenge with your private key.
8. Upserts the **"Self-Custody Operator"** Customer row
   (`signingMode="self-custody"`, `privateKey=""`).
9. Inserts a Reserve row at `lifecycle="requested"` with your
   `operatorPublicKey` as `debtorPubKey`.
10. Writes `operator-reserve-deploy.json` (mode `0o600`).
11. Writes `operator-reserve.json` (mode `0o644`, no private key).
12. Prints next steps. The private key is **never** logged.

### 2. Submit the deploy tx via your wallet

Open `agent-tab/.demo-state/operator-reserve-deploy.json` and submit
the `deploymentRequestJson` payload via your Ergo wallet. For the
testnet dev node:

```bash
curl -sX POST -H "api_key: <your key>" -H "Content-Type: application/json" \
  http://localhost:9052/wallet/transaction/send \
  -d @<(jq '.deploymentRequestJson' agent-tab/.demo-state/operator-reserve-deploy.json)
```

Wait for confirmation — typically 1–2 blocks on testnet.

### 3. Sync

```bash
npx tsx scripts/operator-reserve-init.ts --sync
```

Polls the existing `PATCH /api/reserves` route, transitions the
Reserve to `lifecycle="active"`, and re-verifies the manifest's
proof-of-control against the on-chain R4 owner pubkey returned by
the sidecar. Updates `manifest.syncedAt` and stamps
`proofOfControl.verifiedAgainst = "on-chain-R4"`.

If the box hasn't confirmed yet, the script exits 1 (resumable) —
re-run after another block.

> **Status of validation in 16a-core:** the "not yet on-chain"
> branch of `--sync` (resumable exit 1, no DB mutation) is
> validated. The "requested → active" transition is **implemented
> but not end-to-end validated in 16a-core** — it requires the
> operator to first mint a singleton reserveToken and submit the
> deploy tx via their wallet, which is intentionally operator-
> driven and out of scope for this foundation slice. The
> active-transition response handler is identical to the proven
> `seed-settlement-demo-reserve.ts --sync` path; end-to-end
> validation of an operator-owned reserve's `requested → active`
> is the first concern of the next operator-reserve slice.

### 4. Inspect

```bash
npx tsx scripts/operator-reserve-init.ts --status        # human-readable
npx tsx scripts/operator-reserve-init.ts --status --json # machine-readable
```

Read-only. Never mutates DB or files.

## What 16a-core validated vs. did NOT validate

**Validated in 16a-core (the foundation):**
- `operator-reserve-init.ts --prepare` end-to-end on testnet:
  sidecar `/reserve/deploy` call, Self-Custody Operator Customer
  upsert, Reserve row at `lifecycle="requested"`, manifest +
  deploy-spec written with correct modes.
- Operator key file generated locally at
  `agent-tab/.demo-state/operator-key.json` (mode 0o600) and
  gitignored.
- Keygen self-test (pubkey re-derive + sign-verify roundtrip)
  passes before any DB write.
- Proof-of-control signature persisted in the manifest and
  re-verifiable from disk.
- Canonical ID denylist refusal (`reserveTokenId` and
  `trackerNftId`).
- `ERGO_NETWORK=testnet` requirement: mainnet, unset, and empty
  all refused.
- `--generate-keypair` refuses to overwrite an existing key file.
- `--sync` "not yet on-chain" branch: resumable exit 1, no DB
  mutation.
- `--status` read-only.
- Demo Debtor row untouched. Demo Debtor's existing reserves
  untouched. Canonical reserve untouched.
- `.demo-state/settlement-demo-reserve.json` (the 15a fixture)
  byte-equal before and after.
- `prove.sh` remains 49/49 before and after.

**Not validated in 16a-core (deferred to later slices):**
- `--sync` transitioning a real on-chain operator reserve from
  `lifecycle="requested"` to `lifecycle="active"` after the
  operator submits the deploy tx. The plumbing is implemented
  and mirrors the proven 13b/15a path; what was not exercised
  end-to-end is an operator-owned reserve box actually appearing
  on-chain and being scanned. This is the first thing the next
  operator-reserve slice should close.
- Settlement against an operator-owned reserve. The 15a bridge
  is unchanged and still settles against the demo manifest. An
  explicit `--reserve-manifest <path>` flag for the bridge is
  deferred to **slice 16c**.
- Server-side guards in `/api/reserves/redeem` (canonical refuse,
  operator-mode network assertion, settlement cap) — deferred to
  **slice 16b**.
- Mainnet. 16a-core is hard testnet-only.
- Production self-custody as a finished posture. 16a-core is the
  identity + manifest + deploy-spec **foundation**, not the
  complete operator vertical.

## What 16a-core does NOT do

- **No `--cleanup`.** Cleanup is explicitly demo-destructive and an
  operator-mode cleanup should also offer to sweep the on-chain
  residual. Deferred to 16b/16c.
- **No settlement.** The 15a `receipt-to-settlement-demo.ts` script
  continues to read `.demo-state/settlement-demo-reserve.json`
  exactly as today. There is no silent preference for the operator
  manifest. Slice **16c** will add an explicit
  `--reserve-manifest <path>` flag to the 15a bridge for
  operator-reserve settlement.
- **No server-side canonical or network guard in
  `/api/reserves/redeem`.** Slice **16b** adds those. In 16a-core
  the operator script is the only thing that knows about canonical
  IDs and the `ERGO_NETWORK` assertion.
- **No mainnet path.** Slice 16a-core throws if
  `ERGO_NETWORK !== "testnet"`. A future slice will introduce a
  typed mainnet path with caps + per-redemption confirmation.
- **No CLI surface.** `packages/cli` is unchanged. CLI commands
  (`agent-tab reserve …`) are a candidate for a later slice.
- **No schema changes.** All operator state fits the existing
  Reserve + Customer columns.

## Roadmap (16b → 16c)

### 16b — server-side guards in `/api/reserves/redeem` ✓ implemented

- `src/lib/canonical.ts` (NEW) — `CANONICAL_RESERVE_ID`,
  `CANONICAL_RESERVE_TOKEN_ID`, `CANONICAL_TRACKER_NFT_ID` +
  `refuseIfCanonical()` helper.
- Canonical reserve targeting → **403 `CANONICAL_REFUSE`** (with
  `field` indicating which identifier matched). Refusal is
  pre-load on `reserveId` and post-load on `reserveTokenId` /
  `trackerNftId` for defense in depth.
- Self-custody redemption requires `process.env.ERGO_NETWORK ===
  "testnet"`; anything else (mainnet, unset, empty) returns
  **403 `OPERATOR_NETWORK_REFUSE`**. The guard fires AFTER
  ownership + same-customer to preserve the existing
  collapsed-403 information-leak guarantee for unauthorized
  customer-role callers.
- `OPERATOR_MAX_REDEEM_NANOERG` env-driven cap → **409
  `OPERATOR_CAP`**. Fires only for self-custody reserves. Unset
  / empty = cap disabled. See the `.env.example` block for
  the documented shape.
- `ERGO_NETWORK` centralized in `src/lib/env.ts` (boot-time
  validation in alpha mode); the redeem route reads
  `process.env.ERGO_NETWORK` fresh per request so tests can
  override without restarting the server.
- Tracker-managed (Demo Debtor) paths bypass network + cap
  guards entirely. `prove.sh` remains 49/49.

### 16c — operator-reserve settlement vertical ✓ implemented

- New explicit flag on the 15a bridge:
  `--reserve-manifest .demo-state/operator-reserve.json`. When
  supplied, the bridge settles against the operator's reserve.
  The default (no flag) keeps reading the demo manifest —
  byte-equivalent to 15a behavior.
- Operator-mode lifecycle pre-check: if the manifest is at
  `lifecycle="requested"`, the script exits 1 with concrete
  instructions (mint reserveToken, submit deploy tx, run
  `--sync`). No DB mutation.
- Operator-mode lane provisioning: the script reuses the existing
  MCP Bridge Demo Tools provider + budgeted_echo tool but creates
  a fresh CreditLine + ObligationState + AgentIdentity scoped to
  the operator's Customer. Demo Debtor's lane is untouched.
- Operator-mode sidecar secret-file pre-provisioning: Stage 0
  reads `.demo-state/operator-key.json` and writes
  `~/.chaincash-secrets/owner-<hex8>.json` (mode 0o600) so the
  sidecar can sign the redemption tx. Idempotent: refuses to
  overwrite an existing file whose `pubKeyHex` mismatches.
- The 16b server-side guards (canonical refuse, network refuse,
  operator cap) fire on the redeem route as before.
- `src/lib/reconcile.ts:ensureSecretFile()` was reordered so the
  self-custody path (`Customer.privateKey=""` + pre-provisioned
  file) succeeds without requiring a DB key. Tracker-managed
  behavior is unchanged.

```bash
# After operator setup (mint reserveToken + deploy + --sync to active):
cd agent-tab
npx tsx scripts/receipt-to-settlement-demo.ts \
  --reserve-manifest .demo-state/operator-reserve.json \
  --receipts-path ~/.agent-tab/receipts.jsonl
# → SettlementEvent against operator reserveId, redemptionTxId on testnet
```

**Honesty: tracker reuse.** 16c proves operator-owned **reserve**
settlement. The shared 15a testnet tracker NFT (`b84289dd…`) is
reused; the tracker box advances and gains a new entry under the
operator's `(debtorPubKey, creditorPubKey)` pair when settlement
fires. Existing tracker entries (Demo Debtor's) are not modified —
only added-to. Independent operator-tracker deployment is deferred.

## Honesty footnote

16a-core is the smallest piece of a *self-custodial operator*
posture: identity, manifest, deploy spec, proof-of-control,
testnet boundary, canonical refusal. The "Agent Tab does not
custody funds" claim is **only** as strong as the layers above
keep — full production self-custody requires 16b + 16c plus the
mainnet-readiness work that gates 17+. Until those land, the
*technical* guarantee is "local operator-owned reserve mode on
testnet (identity + manifest foundation)" — a foundation, not the
finished posture.

Specifically, 16a-core proves an operator can produce a verifiable
local identity + manifest + deploy spec that, after the operator
submits the deploy tx via their own wallet, the existing
`PATCH /api/reserves` sync route can transition to
`lifecycle="active"`. Operator-owned settlement against that
reserve is added in 16c (see roadmap above).

This documentation is **not legal advice.** It describes the
technical posture of the software. Operators considering mainnet
deployment should consult counsel.
