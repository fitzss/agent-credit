# Recipe: Claude Desktop + Agent Tab Proxy

> Claude Desktop launches the Agent Tab proxy as a stdio MCP server.
> Claude sees only the budgeted tools — agent calls go through the cap
> check; the upstream MCP server is invoked only on allowed calls.

## Prerequisites

- Claude Desktop installed.
- Node 20+ on `PATH`.
- `@agent-tab/cli` installed in a project (e.g.
  `npm install --save-dev /path/to/agent-tab-cli-0.0.3-rc.1.tgz`),
  **or** installed globally: `npm install -g
  /path/to/agent-tab-cli-0.0.3-rc.1.tgz` (so `agent-tab` is on `PATH`).

## One-time setup

```bash
npx agent-tab init
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
      "command": "npx",
      "args": ["agent-tab", "proxy"]
    }
  }
}
```

If `agent-tab` is not globally installed and `npx` cannot find it,
use the absolute path to the bin in your project:

```json
{
  "mcpServers": {
    "agent-tab": {
      "command": "node",
      "args": [
        "/absolute/path/to/your/project/node_modules/.bin/agent-tab",
        "proxy"
      ]
    }
  }
}
```

If you want to point at a non-default config:

```json
{
  "mcpServers": {
    "agent-tab": {
      "command": "npx",
      "args": [
        "agent-tab",
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
npx agent-tab tabs                           # see current balances
npx agent-tab receipts --limit 50            # see recent Work Receipts
npx agent-tab requests --pending             # see queued authority requests
npx agent-tab grant --request-id <id>        # approve a queued request
npx agent-tab grant --tab tab-default --add 5000000000  # operator-initiated raise
```

The proxy stays running across grants; it re-reads `config.json` on
every cap check. No restart required.

## Validation note

The release-candidate harness (`npm run test:rc`) validates that this
recipe's `claude_desktop_config.json` snippet parses as JSON and
points at the installed `agent-tab` bin. The Claude Desktop GUI
itself is not exercised automatically. Manual smoke test in Claude
Desktop is a recommended human verification step.

## Stopping

Quit Claude Desktop. The proxy subprocess receives the close signal
and exits cleanly.
