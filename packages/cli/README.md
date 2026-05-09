# @agent-tab/cli — MCP Proxy Spike (slice 14m.0a)

> First Agent Tab MCP Proxy spike. Wraps **one** upstream MCP server and
> **one** upstream tool with a local cap. Cap-exceeded calls are denied
> without invoking upstream. Receipts and balances live on disk under a
> configured state dir. Generalization (multi-tool, init/grant/receipts
> CLI, recipes, publishing) is deferred to slice 14m.0b.

## What this proves

The protocol stack works end-to-end: MCP client → Agent Tab proxy → one
upstream MCP server → one wrapped tool, with a real cap check and a real
denied path. Stdout stays reserved for MCP protocol; logs go to stderr.
No hosted backend, no Ergo node, no settlement, no real money.

## What this does *not* prove (yet)

- Multi-upstream, multi-tool, or arbitrary MCP wrapping.
- Cryptographic agent identity, Schnorr session pubkeys, or self-custody.
- Settlement, mainnet, or any reserve-backed flow.
- Marketing claims like "wrap any MCP server" — only `server-everything`
  + `echo` is exercised by this spike.

## Try it locally

```bash
# 1. Build (from this directory).
npm install
npm run build

# 2. Make a state dir for this spike (independent of any future ~/.agent-tab/).
mkdir -p ~/.agent-tab-spike
cp sample-config.json ~/.agent-tab-spike/config.json

# 3. Start MCP Inspector pointed at the proxy.
#    The proxy will spawn @modelcontextprotocol/server-everything as a child.
npx @modelcontextprotocol/inspector \
  node dist/index.js proxy --config ~/.agent-tab-spike/config.json

# 4. In the Inspector UI:
#    - tools/list should show exactly: agent_tab_status, budgeted_echo
#    - call agent_tab_status({}) → shows limit/current/pending/remaining
#    - call budgeted_echo({ "message": "hello" }) → success, balance advances
#    - call budgeted_echo({ "message": "again" }) → denied (cap exceeded)

# 5. Inspect on-disk ledger:
cat ~/.agent-tab-spike/balances.json
cat ~/.agent-tab-spike/receipts.jsonl
```

## Files on disk

- `<stateDir>/balances.json` — atomic-write JSON. Single object:
  `{ tabs: { [tabId]: { currentAmount, pendingAmount, version, updatedAt } } }`.
  All amount fields are unsigned-integer **strings** (BigInt nanoCredits).
- `<stateDir>/receipts.jsonl` — append-only JSONL. One receipt per
  budgeted call: `success | denied | error`.

## Cap arithmetic

Mirrors the hosted Agent Tab proxy
(`agent-tab/src/app/api/proxy/route.ts:62`):

> Denied if `currentAmount + pendingAmount + costPerCall > limitAmount`.

A denied call writes a `denied` receipt with `amountCharged="0"` and
**does not invoke upstream**.

## Stdio MCP discipline

- All logs use `console.error` (stderr).
- Stdout is reserved for the MCP server transport.
- Upstream subprocess stdout is consumed by the MCP `Client`; it is
  never proxied to this process's stdout.

## Subcommands

Only `proxy` is implemented in 14m.0a. The names `init`, `grant`,
`receipts`, `tabs`, `sync` exist but exit `2` with a "not implemented in
14m.0a" message — they are reserved for follow-up slices.
