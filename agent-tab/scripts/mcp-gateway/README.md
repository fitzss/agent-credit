# Agent Tab MCP Gateway — Slice 12a

A thin **stdio MCP server** that wraps a single Agent Tab tool call. Demonstrates the *budget-wall* product wedge:

> *"I gave my AI agent a tab. It tried to overspend. Agent Tab stopped it."*

## What this slice proves (and what it does not)

This is **Slice 12a — tracker-managed budget-wall demo**:

- one stdio MCP server
- one concrete wrapped tool: `analyze_text`
- one tracker-managed agent key
- one credit-line cap
- one allowed call
- one denied call
- one activity feed
- one work receipt / obligation update

It does **not** prove self-custody signing, session-bound delegation, or the pending-signature MCP flow. Those are deferred to **Slice 12b**.

## How it works

The gateway holds an Agent Tab API key in its environment. When an MCP client calls `analyze_text({ text })`, the gateway POSTs to Agent Tab's existing `/api/proxy` with the configured agent key + tool id. Agent Tab enforces every guardrail (agent active, tool scope, credit-line cap) and returns a structured tab snapshot. The gateway maps that into a clean MCP tool result.

The gateway holds **no signing keys**, runs **no Prisma queries**, and imports **nothing from `src/lib/`**. It is a pure HTTP adapter.

## Demo flow (snappy: 1 allowed + 1 denied — repeatable)

```bash
# 1. Make sure Agent Tab is running.
cd agent-tab && DEMO_MODE=true npx next dev -p 3000

# 2. Reset the MCP demo lane to a known-good baseline.
#    (Skips silently if there's nothing to reset.)
npx tsx scripts/seed-mcp-demo.ts --reset

# 3. Seed the MCP demo fixture with a $0.10 cap (one tool call's worth).
npx tsx scripts/seed-mcp-demo.ts --limit-amount 100000000
# ↑ prints the raw API key ONCE. Copy it before scrolling away.

# 4. Set env and start the gateway under stdio.
export AGENT_TAB_BASE_URL=http://localhost:3000
export AGENT_TAB_AGENT_KEY=<paste-from-step-3>
export AGENT_TAB_TOOL_ID=auth-demo-tool-analyze-001

# 5. Connect an MCP client. Two options:
#    a) MCP Inspector (web UI; spawns the gateway as subprocess):
npx @modelcontextprotocol/inspector npx tsx scripts/mcp-gateway/index.ts
#    b) Any other stdio-capable MCP client; point it at the same command.

# 6. In the inspector, list tools and call:
#    analyze_text({ text: "the quick brown fox jumps over the lazy dog" })
#    First call → "Charge accepted. Tab: $0.10 / $0.10 used (100% utilization) (limit reached …)."
#    Second call → "Agent Tab denied this call: cap exceeded. No state moved."

# 7. Open the dashboard to see the work receipt + activity feed:
#    http://localhost:3000/customer/<demo-debtor-id>
#    (the seed script prints the customer id)

# 8. Run again? Repeat from step 2. --reset wipes the lane cleanly each time.

# 9. When done, retire the demo fixture (audit-preserving).
npx tsx scripts/seed-mcp-demo.ts --cleanup
```

## Demo flow (literal "$1 tab" — chattier, 10 allowed + 11th denied)

```bash
npx tsx scripts/seed-mcp-demo.ts --reset       # always reset first for determinism
npx tsx scripts/seed-mcp-demo.ts               # default limit = $1.00
# ... same as steps 4–6, just call analyze_text 10 times before denial.
```

## Cleanup vs reset

| Mode | Effect | When to use |
|---|---|---|
| `--cleanup` | Soft, audit-preserving. Revokes the agent (status="revoked") and the credit line (status="inactive"). UsageEvent and ObligationUpdate rows are kept. | After a demo run, when you want the audit trail to remain visible in the dashboard. |
| `--cleanup --hard` | Same as `--cleanup`, plus deletes the CreditLine row. The AgentIdentity stays in `revoked` because UsageEvent FK refs hold it in place. | Frees up the deterministic CreditLine id without losing UsageEvent history. |
| `--reset` | **DESTRUCTIVE.** Deletes the entire MCP demo lane: UsageEvents for the demo agent, ObligationUpdates for the Demo Debtor ↔ Bolt Tools obligation, the ObligationState row, the AgentIdentity, and the CreditLine. Restores a fully fresh starting state. | Before each fresh live demo run, when you want `current=0`, `pending=0` and identical 1-allowed-then-deny behavior every time. |

Reset only touches the MCP demo lane. It never deletes canonical agents (`auth-demo-key-001`, `auth-demo-key-002`), the Bolt Tools provider, the analyze tool, the Bolt Labs canonical fixtures, or any settlement / reserve / sidecar / mainnet state.

## Required environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `AGENT_TAB_BASE_URL` | yes | — | URL of the running Agent Tab backend. |
| `AGENT_TAB_AGENT_KEY` | yes | — | Raw API key from `seed-mcp-demo`. **Never log or share.** |
| `AGENT_TAB_TOOL_ID` | yes | — | The tool id the gateway forwards to (e.g. `auth-demo-tool-analyze-001`). |
| `AGENT_TAB_TIMEOUT_MS` | no | `15000` | HTTP timeout for the proxy call. |
| `AGENT_TAB_MCP_TOOL_NAME` | no | `analyze_text` | Override the MCP tool name the model sees. |

Missing any required var → the gateway exits with code `2` and a clear stderr message.

## Tool contract

```jsonc
// MCP input schema (additionalProperties: false)
{
  "type": "object",
  "properties": {
    "text": { "type": "string", "minLength": 1 }
  },
  "required": ["text"],
  "additionalProperties": false
}
```

The model **cannot** override the agent key or tool id by passing them as arguments. The schema rejects any extra property.

## Output mapping

| Agent Tab response | MCP `isError` | Tool-result text |
|---|---|---|
| 200 (charge accepted) | false | `Charge accepted. Tab: $X / $Y used (Z% utilization). Remaining: $W. Tool result: …` |
| 402 (cap exceeded) | false | `Agent Tab denied this call: cap exceeded. No state moved. …` |
| 403 (policy denial) | false | `Agent Tab denied this call: <reason>` |
| 409 (delegation/version conflict) | false | `Agent Tab denied this call: <error> (<code>)` |
| 401 (invalid agent key) | **true** | `Agent Tab gateway configuration error: agent key is invalid or inactive.` |
| 404 (missing tool) | **true** | `Agent Tab gateway configuration error: configured tool is missing or inactive.` |
| Upstream tool error | **true** | `The analyze_text tool failed: …` |
| Network / timeout | **true** | `Agent Tab gateway error: …` |

Cap-exceeded is `isError: false` because it is a business outcome (not an infrastructure failure) — the model should reason about a full tab, not retry.

## Security guarantees

- The raw agent key lives ONLY in this process's environment.
- It is never logged, never written to stdout, never returned in any MCP response.
- The MCP input schema's `additionalProperties: false` blocks the model from overriding `x-agent-api-key`, `x-tool-id`, or any other internal field.
- The gateway never reads or writes the database directly; it only calls `/api/proxy`.

## Cleanup semantics

`seed-mcp-demo.ts --cleanup` is FK-safe. It revokes the demo agent and revokes the credit line; it does **not** delete `UsageEvent` or `ObligationUpdate` rows that hold FK references. With `--hard`, the credit line is hard-deleted (no incoming FK refs); the agent stays in `revoked` state because `UsageEvent` rows reference it. This preserves the audit trail of every charge.
