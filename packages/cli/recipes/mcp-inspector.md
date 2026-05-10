# Recipe: MCP Inspector + Agent Tab Proxy

> Inspector talks to the proxy on stdio. The proxy spawns the upstream
> MCP server as a child. You see budgeted tools in the Inspector UI and
> a real cap-enforced loop on every call.

## Prerequisites

- Node 20+.
- `@agent-tab/cli` installed (e.g. `npm install --save-dev
  /path/to/agent-tab-cli-0.0.3-rc.1.tgz`).

## One-time setup

```bash
npx agent-tab init
```

Writes `~/.agent-tab/config.json` and creates `~/.agent-tab/`.
Default upstream: `npx -y @modelcontextprotocol/server-everything`.
Default wrapped tools: `budgeted_echo`, `budgeted_get_sum`. Default
tab limit: 10 credits (10 calls at 1 credit each).

## Run the proxy under MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx agent-tab proxy
```

Inspector opens a web UI. In the **Tools** tab you should see four
tools:

| Tool | Source |
|---|---|
| `agent_tab_status` | built-in: read-only budget snapshot |
| `agent_tab_request_more_authority` | built-in: queue an authority request for the operator |
| `budgeted_echo` | wraps upstream `echo` |
| `budgeted_get_sum` | wraps upstream `get-sum` |

## The earned-autonomy loop (no proxy restart needed)

1. Call `budgeted_echo({ "message": "hello" })`. Charge accepted; tab
   advances by 1 credit. After 10 calls the cap is reached.
2. Call `budgeted_echo` once more. Denied: "Credit limit exceeded".
3. Call `agent_tab_request_more_authority({ "requestedDelta": "5000000000", "reason": "needs more headroom" })`.
   You receive: "Request submitted (id=…). Human approval is required."
4. In another terminal, run:
   `npx agent-tab grant --request-id <id>`
5. Without restarting the proxy, call `budgeted_echo` again. Charge
   accepted — the proxy re-reads `config.json` on every cap check.

## Inspecting state from the shell

```bash
npx agent-tab tabs                       # balance / pending / limit / remaining / utilization / alert
npx agent-tab receipts --limit 50        # tool-call ledger (Work Receipt / Denied / Upstream Error)
npx agent-tab requests                   # authority ledger (request / resolution / grant)
npx agent-tab requests --pending         # only requests still awaiting approval
```

## Stopping cleanly

`Ctrl-C` in the Inspector terminal. The proxy receives `SIGINT`,
closes the upstream subprocess, and exits.
