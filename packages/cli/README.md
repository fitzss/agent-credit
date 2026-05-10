# @agent-tab/cli — Usable MCP Proxy CLI (slice 14m.0b)

> First usable Agent Tab MCP Proxy CLI. Wraps **one upstream MCP
> server** with multiple budgeted tools. Closes the earned-autonomy
> loop locally: cap → request → grant → retry, all without restarting
> the proxy. Multi-upstream and hosted sync are deferred to slice
> 14m.0c.

## Commands

| Command | Purpose |
|---|---|
| `agent-tab init` | Write a fresh `config.json` with sensible defaults. Refuses to overwrite without `--force`. |
| `agent-tab proxy` | Run the stdio MCP proxy. Plug into MCP Inspector or Claude Desktop. |
| `agent-tab tabs` | Show `balance / pending / limit / remaining / utilization / alert` per tab. |
| `agent-tab receipts` | Show recent **Work Receipts** (tool-call outcomes only). |
| `agent-tab grant` | Operator action: raise a tab's limit, optionally consuming a pending request. |

The proxy also exposes two built-in MCP tools to its clients:

| Tool | Purpose |
|---|---|
| `agent_tab_status` | Read the current tab snapshot. Read-only. |
| `agent_tab_request_more_authority` | Submit an authority request for the operator to review. **Never auto-approves.** |

## Quick start

```bash
# Build.
npm install
npm run build

# Initialize default config + state dir.
node dist/index.js init

# Run the proxy under MCP Inspector.
npx @modelcontextprotocol/inspector node dist/index.js proxy
```

Default config wraps two upstream tools from
`@modelcontextprotocol/server-everything`:

- `echo` → `budgeted_echo` (1 credit per call)
- `get-sum` → `budgeted_get_sum` (1 credit per call)

Default tab limit: 10 credits.

## The earned-autonomy loop (no restart)

```bash
# 1. The proxy is running in another terminal under MCP Inspector / Claude Desktop.

# 2. Watch state.
node dist/index.js tabs
node dist/index.js receipts --limit 50

# 3. Agent burns through the cap, then asks for more (in the MCP client):
#    agent_tab_request_more_authority({ requestedDelta: "5000000000",
#                                       reason: "needs more headroom" })
#    → "Request submitted (id=…). Human approval is required."

# 4. Operator approves. Same proxy process; do NOT restart.
node dist/index.js grant --request-id <id>

# 5. Agent retries — the proxy re-reads config.json on the cap check
#    and the call now succeeds.
```

Operators can also issue grants without an agent request:

```bash
node dist/index.js grant --tab tab-default --add 5000000000
node dist/index.js grant --tab tab-default --set-limit 20000000000
```

## Files on disk (under `<stateDir>`, default `~/.agent-tab/`)

| File | Role | Mutators |
|---|---|---|
| `config.json` | Tabs, limits, wrapped tools, upstream config. | `init`, `grant` (atomic temp+rename) |
| `balances.json` | Per-tab current/pending balances. | proxy (atomic temp+rename on success) |
| `receipts.jsonl` | **Tool-call ledger only.** Three outcomes: `success` ("Work Receipt"), `denied`, `error` ("Upstream Error"). | proxy (append-only) |
| `requests.jsonl` | **Authority ledger.** Three event types: `type=request`, `type=resolution`, `type=grant` (with `source=operator`). | `grant` and `agent_tab_request_more_authority` (append-only) |

`receipts.jsonl` and `requests.jsonl` are deliberately separate so a
"Work Receipt" stays a tool-call outcome — not an authority event.
Operator and request-resolving grants are auditable via
`requests.jsonl`.

## Cap arithmetic

Mirrors the hosted Agent Tab proxy
(`agent-tab/src/app/api/proxy/route.ts:62`):

> Denied if `currentAmount + pendingAmount + costPerCall > limitAmount`.

A denied call writes a `denied` row to `receipts.jsonl` with
`amountCharged="0"` and **does not invoke upstream**.

## Stdio MCP discipline

- All logs use `console.error` (stderr) inside `proxy`.
- Stdout is reserved for the MCP server transport.
- The upstream subprocess's stdout is consumed by the MCP `Client`;
  it is never proxied to this process's stdout.
- The non-proxy commands (`init`, `tabs`, `receipts`, `grant`) print to
  stdout normally.

## isError convention

| Situation | `isError` |
|---|---|
| Valid `agent_tab_request_more_authority` submission | `false` |
| Invalid `agent_tab_request_more_authority` input (strict-validation reject) | **`true`** |
| `budgeted_*` tool denied by cap | `false` (business outcome) |
| `budgeted_*` upstream call threw | **`true`** |
| `agent_tab_status` | `false` |

## Recipes

- [recipes/mcp-inspector.md](./recipes/mcp-inspector.md)
- [recipes/claude-desktop.md](./recipes/claude-desktop.md)

## What this slice does *not* ship

- Multi-upstream support (one `upstream:` block per config).
- `agent-tab sync` (hosted backend / SaaS endpoint).
- `agent-tab requests` CLI (operators inspect via
  `cat ~/.agent-tab/requests.jsonl` for now).
- Request rejection / partial-approve UX.
- Interactive `init` prompts.
- Cryptographic agent identity, delegation/Schnorr/session pubkeys.
- Settlement, sidecar, Ergo node, on-chain anything.
- npm publish.

These are tracked for slice 14m.0c+.
