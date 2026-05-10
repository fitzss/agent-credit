# Recipe: Claude Desktop + Agent Tab Proxy

> Claude Desktop launches the Agent Tab proxy as a stdio MCP server.
> Claude sees only the budgeted tools — agent calls go through the cap
> check; the upstream MCP server is invoked only on allowed calls.

## Prerequisites

- Claude Desktop installed.
- Node 20+ on `PATH`.
- `@agent-tab/cli` built (run `npm install && npm run build` in
  `packages/cli/`).

## One-time setup

```bash
agent-tab init
```

Default config is at `~/.agent-tab/config.json`. Default state at
`~/.agent-tab/`.

## Wire Claude Desktop to the proxy

Locate `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`).
Add the `agent-tab` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "agent-tab": {
      "command": "node",
      "args": [
        "/absolute/path/to/agent-credit/packages/cli/dist/index.js",
        "proxy"
      ]
    }
  }
}
```

Replace `/absolute/path/to/agent-credit` with the real absolute path
on your machine (Claude Desktop does not expand `~`).

If you want to point at a non-default config:

```json
{
  "mcpServers": {
    "agent-tab": {
      "command": "node",
      "args": [
        "/absolute/path/to/agent-credit/packages/cli/dist/index.js",
        "proxy",
        "--config",
        "/absolute/path/to/my-config.json"
      ]
    }
  }
}
```

Restart Claude Desktop. Claude will list four tools under the
`agent-tab` server: `agent_tab_status`,
`agent_tab_request_more_authority`, `budgeted_echo`,
`budgeted_get_sum`.

## What Claude can do

- Use `budgeted_echo` and `budgeted_get_sum` until the tab is
  exhausted. Each call advances the balance.
- Once denied, call `agent_tab_request_more_authority` to ask for
  more. The request is *queued for your review*; nothing auto-approves.
- Use `agent_tab_status` to read the current tab snapshot.

## What you do (the human)

```bash
agent-tab tabs                           # see current balances
agent-tab receipts --limit 50            # see recent Work Receipts
cat ~/.agent-tab/requests.jsonl          # see the authority ledger
agent-tab grant --request-id <id>        # approve a queued request
agent-tab grant --tab tab-default --add 5000000000  # operator-initiated raise
```

The proxy stays running across grants; it re-reads `config.json` on
every cap check. No restart required.

## Stopping

Quit Claude Desktop. The proxy subprocess receives the close signal
and exits cleanly.
