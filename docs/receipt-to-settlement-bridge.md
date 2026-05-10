# Slice 15a — MCP Work Receipt → Reserve Settlement Bridge

> **What this is:** the smallest single-lane vertical that walks one
> local MCP Work Receipt all the way to a SettlementEvent against a
> dedicated demo reserve, in one shell command, on testnet.
>
> **What this is not:** not a hosted backend, not a generalized sync
> protocol, not real money, not a production import path, not
> mainnet. It is a demo script that connects two halves of the
> product (the local CLI + the on-chain settlement substrate) so the
> full *work → receipt → obligation → settlement* loop is provable
> end to end.

## The chain

```
packages/cli/receipts.jsonl  (one outcome="success" row)
    │
    ▼
agent-tab/scripts/receipt-to-settlement-demo.ts (slice 15a)
    │
    │  0. preflight: HTTP, cookie, Demo Debtor, demo reserve manifest
    │  1. ensure MCP Bridge Demo Tools fixture (idempotent)
    │  2. select receipt, match by Tool.name (1:1, abort if no match)
    │  3. import (sequential, non-atomic):
    │       a. dedupe pre-check on UsageEvent.requestRef
    │       b. tracker.proposeNoteUpdate(...)  → ObligationUpdate, ObligationState
    │       c. prisma.usageEvent.create(...)   → UsageEvent
    │  4. settlement-readiness audit (subprocess gate)
    │  5. POST /api/reserves/redeem
    │  6. verify: SettlementEvent + reduced obligation + canonical untouched
    │
    ▼
SettlementEvent (id, reserveId=<demo>, obligationStateId, amount,
                 redemptionTxId, status="completed")
+ reduced ObligationState (Demo Debtor ↔ MCP Bridge Demo Tools)
+ untouched canonical reserve
+ untouched repo-lint lane and any other prior fixtures
```

## Reproduction

```bash
# Prereqs (one-time):
cd agent-tab
DEMO_MODE=true npx next dev -p 3000 &
npx tsx scripts/seed-settlement-demo-reserve.ts --prepare
npx tsx scripts/seed-settlement-demo-reserve.ts --sync

# Generate at least one local Work Receipt (in another shell):
cd packages/cli
npm install && npm run build
node dist/index.js init    # writes ~/.agent-tab/config.json
# Drive the proxy through MCP Inspector or any MCP client; call
# budgeted_echo({message:"hello"}) at least once. The success row
# lands in ~/.agent-tab/receipts.jsonl.

# The 15a demo:
cd agent-tab
npx tsx scripts/receipt-to-settlement-demo.ts \
  --receipts-path ~/.agent-tab/receipts.jsonl

# Expected output (abridged):
# [15a] Stage 0 ✓ HTTP reachable …
# [15a] Stage 0 ✓ operator cookie minted
# [15a] Stage 0 ✓ Demo Debtor exists (signingMode=tracker)
# [15a] Stage 0 ✓ demo reserve (NOT canonical)
# [15a] Stage 1 ✓ bridge fixture (provider/tools/agent/credit-line)
# [15a] Stage 2 ✓ selected receipt id=… tool=budgeted_echo amount=…
# [15a] Stage 2 ✓ tool name match
# [15a] Stage 3a ✓ dedupe pre-check
# [15a] Stage 3b ✓ tracker.proposeNoteUpdate (ObligationUpdate …)
# [15a] Stage 3c ✓ prisma.usageEvent.create
# [15a] Stage 4 ✓ readiness audit passed
# [15a] Stage 5 ✓ redeem (txId=…, SettlementEvent …)
# [15a] Stage 6a ✓ SettlementEvent status=completed
# [15a] Stage 6b ✓ bridge ObligationState reduced
# [15a] Stage 6c ✓ canonical reserve untouched
# [15a] OK — receipt → obligation → settlement → reduced obligation in 1 command.
```

## Dry run

```bash
npx tsx scripts/receipt-to-settlement-demo.ts --dry-run
```

Dry-run executes preflight + ensure bridge fixture + receipt
selection + tool-name match, then prints the intended import mapping
and exits without DB mutation. **Dry-run does not run the readiness
audit** — readiness has no meaningful state to audit before the
obligation has been advanced. To exercise the audit gate, run
without `--dry-run`.

## What lives where (the two-halves split)

| Concept | Local (CLI) | Backend (this slice) |
|---|---|---|
| Work Receipt | `~/.agent-tab/receipts.jsonl` (append-only JSONL) | `UsageEvent` row (audit) + `ObligationUpdate` row (signed, tracker-managed) |
| Tool | `Tool.name = "budgeted_echo"` in `config.json` | `Tool.name = "budgeted_echo"` under `Provider.name = "MCP Bridge Demo Tools"` (1:1 by name) |
| Cap / limit | `config.tabs[].limitAmount` | `CreditLine.limitAmount` |
| Customer | (implicit single user) | `Customer.name = "Demo Debtor"` (canonical, signingMode=tracker) |
| Agent identity | (none in 14m.0c) | `AgentIdentity.label = "mcp-bridge-demo-agent"` |
| Settlement | (none in CLI) | `SettlementEvent` against the slice-13b dedicated demo reserve (NOT canonical) |

## Honest framing

15a is a **demo**, not a product. It writes to a *new dedicated
bridge lane* — never to canonical fixtures referenced by `prove.sh`.
Re-runs accumulate audit history; the same receipt id is deduped via
`UsageEvent.requestRef`. There is no `--cleanup` flag in 15a; cleanup
of the bridge lane is deferred to 15b and would be explicitly
demo-destructive (delete rows, not "reset state but keep audit").
The on-chain settlement is testnet, not mainnet. The reserve is the
slice-13b dedicated demo reserve, not the canonical reserve.

## Troubleshooting

If `/api/reserves/redeem` fails in `phase: tracker-deploy` with
`Tracker update failed: Transaction generation failed (400)` /
`NotEnoughTokensError`, the Ergo node's wallet UTXO selector may
have lost track of the tracker NFT box even though
`/wallet/balances` and `/scan/unspentBoxes/<id>` still see it. A
targeted rescan from a few blocks before the tracker box's
inclusion height usually clears it:

```bash
# Find the tracker box's inclusion height via /wallet/transactions
# (look for the output that emitted the trackerNftId), then rescan
# from a few blocks earlier:

curl -sX POST -H "api_key: <key>" -H "Content-Type: application/json" \
  http://localhost:9052/wallet/rescan \
  -d '{"fromHeight": <inclusionHeight - 10>}'

# Wait until walletHeight catches up to fullHeight, then retry.
```

A partial rescan from a height above other tokens' mint heights
drops the wallet's view of those earlier tokens until a wider
rescan is performed. On-chain reserves and tokens are not
affected — only the wallet's local index.

## Substrate references

- `docs/settlement-readiness.md` — slice 13a's audit (the gate 15a
  invokes via `spawnSync`).
- (slice 13b's manifest pattern is in
  `agent-tab/.demo-state/settlement-demo-reserve.json` plus the
  `seed-settlement-demo-reserve.ts` source.)
- `docs/receipt-to-reserve-settlement-demo.md` — slice 13c's
  full repo-lint demo (the orchestration pattern 15a borrows; the
  only meaningful difference is the obligation-advance step reads
  a row from a JSONL file instead of calling `/api/proxy`).
- (slice 13d's reserve-scoped settlement history surfaces the
  resulting `SettlementEvent` rows in the dashboard.)

## What this proves

After the script exits 0, the database contains:

1. A `UsageEvent` sourced from a real local MCP tool call.
2. An `ObligationUpdate` that signed the corresponding debt delta
   in tracker-managed mode — the same signing path the hosted
   `/api/proxy` route uses.
3. An `ObligationState` that advanced by the receipt's amount, then
   was reduced by an on-chain settlement.
4. A `SettlementEvent` referencing the on-chain `redemptionTxId`
   and the `Reserve.id` of the dedicated demo reserve.
5. **Zero mutation** of the canonical reserve, the `agent-tab/`
   schema, the `chaincash/` sidecar, the `prove.sh` proof stack, or
   the Repo-lint lane.

That is the entire *work → receipt → obligation → settlement* loop
of the whitepaper, reduced to a single command.

## Deferred to 15b+

- Multi-receipt batch import.
- An `agent-tab sync` CLI command that POSTs to a (yet-to-exist)
  `/api/receipts/import` endpoint.
- Flag-driven identity mapping for non-bridge lanes
  (`--customer-id`, `--provider-id`, `--tool-id`, etc.).
- Optional Schnorr signatures on local receipts.
- Explicitly demo-destructive `--cleanup` that tears down the
  bridge lane.
- Mainnet, real money, public SaaS, hosted backend.
