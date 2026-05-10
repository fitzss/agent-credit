# @agent-tab/cli

> **What this is:** A local-first MCP proxy. Wraps one upstream MCP
> server with budgeted tools and a local cap. Closes the cap →
> request → grant → retry loop on disk, no hosted backend.
>
> **What this is not:** Not a hosted SaaS. Not a settlement system.
> Not a production billing tool. Not real money. The full Agent Tab
> Next.js app + on-chain settlement is a separate upgrade path.

Slice 14m.0c — release-candidate `0.0.3-rc.1`. Installable from a
local tarball; npm publish deferred to 14m.0d.

## 10-minute quickstart

```bash
# 1. Install (from a local tarball produced by `npm pack`).
npm install --save-dev /path/to/agent-tab-cli-0.0.3-rc.1.tgz

# 2. Initialize. Writes ~/.agent-tab/config.json with sensible defaults:
#    upstream = npx -y @modelcontextprotocol/server-everything
#    wrapped tools = budgeted_echo, budgeted_get_sum (1 credit per call)
#    tab limit = 10 credits.
npx agent-tab init

# 3. Run the proxy under your MCP client.
#    a) MCP Inspector:
npx @modelcontextprotocol/inspector npx agent-tab proxy
#    b) Claude Desktop: see recipes/claude-desktop.md.

# 4. From the MCP client, call the budgeted tools.
#    budgeted_echo({ message: "hello" })          → Charge accepted
#    budgeted_echo  ... ten times → 11th call → Credit limit exceeded
#
#    Then ask for more headroom:
#    agent_tab_request_more_authority({ requestedDelta: "5000000000",
#                                       reason: "needs more headroom" })
#    → "Request submitted (id=…). Human approval is required."

# 5. From a second terminal: inspect, then approve.
npx agent-tab tabs                       # balance / pending / limit / remaining / utilization / alert
npx agent-tab receipts --limit 50        # tool-call ledger only
npx agent-tab requests --pending         # authority ledger: requests awaiting approval
npx agent-tab grant --request-id <id>    # approve as-is

# 6. Retry the budgeted call. SAME proxy process — no restart needed.
#    The proxy re-reads config.json on every cap check and sees the new limit.
```

That's the entire loop. No hosted backend, no settlement, no on-chain
state, no real money.

## Commands

| Command | Purpose |
|---|---|
| `agent-tab init` | Write a fresh `config.json` with sensible defaults. Refuses to overwrite without `--force`. |
| `agent-tab proxy` | Run the stdio MCP proxy. Plug into MCP Inspector or Claude Desktop. |
| `agent-tab tabs` | Show `balance / pending / limit / remaining / utilization / alert` per tab. |
| `agent-tab receipts` | Show recent **Work Receipts** (tool-call outcomes only). |
| `agent-tab requests` | Show authority-ledger rows: requests, resolutions, operator grants. **Read-only.** |
| `agent-tab grant` | Operator action: raise a tab's limit, optionally consuming a pending request. |

The proxy also exposes two built-in MCP tools to its clients:

| Tool | Purpose |
|---|---|
| `agent_tab_status` | Read the current tab snapshot. Read-only. |
| `agent_tab_request_more_authority` | Submit an authority request for the operator to review. **Never auto-approves.** |

## Two ledgers, deliberately separate

| File | Role | Mutators |
|---|---|---|
| `<stateDir>/config.json` | Tabs, limits, wrapped tools, upstream config. | `init`, `grant` (atomic temp+rename) |
| `<stateDir>/balances.json` | Per-tab current/pending balances. | proxy (atomic temp+rename on success) |
| `<stateDir>/receipts.jsonl` | **Tool-call ledger only.** Three outcomes: `success` ("Work Receipt"), `denied`, `error` ("Upstream Error"). | proxy (append-only) |
| `<stateDir>/requests.jsonl` | **Authority ledger.** Three event types: `type=request`, `type=resolution`, `type=grant` (with `source=operator`). | `grant` and `agent_tab_request_more_authority` (append-only) |

A "Work Receipt" is a *tool-call outcome*, never an authority event.
Requests, resolutions, and operator grants live in `requests.jsonl`,
separate from `receipts.jsonl`. `agent-tab receipts` and
`agent-tab requests` each surface only their own ledger.

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
- Non-proxy commands (`init`, `tabs`, `receipts`, `requests`,
  `grant`) print to stdout normally.

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

## Validation note

The release-candidate harness (`npm run test:rc`) drives the full
`init → proxy → call → over-cap → request → grant → retry` loop
against the **installed bin** in a temp consumer project, using the
MCP SDK's `Client + StdioClientTransport` to speak to the proxy.
This is the same protocol the MCP Inspector uses; the Inspector UI
itself is not driven automatically. Claude Desktop is a closed-source
GUI app; the harness validates that the recipe's
`claude_desktop_config.json` snippet parses as JSON and uses the
correct installed-bin invocation, but the GUI smoke test is a
recommended human verification, not gate-blocking.

## What this slice does *not* ship

- npm publish to a public registry (deferred to 14m.0d).
- `agent-tab sync` (hosted backend / SaaS endpoint).
- Multi-upstream support.
- OpenClaw / Hermes recipe pages.
- Request rejection / partial-approve UX.
- File-watch-based hot-reload of `config.json` (still on-demand
  re-read on every cap check).
- Cryptographic agent identity, delegation/Schnorr/session pubkeys.
- Settlement, sidecar, Ergo node, on-chain anything.
- Per-byte / per-second / metered pricing.
- Dashboard UI / web view.

These are tracked for slice 14m.0d+.

## License

MIT. See [LICENSE](./LICENSE).
