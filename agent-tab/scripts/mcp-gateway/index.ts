#!/usr/bin/env tsx
/**
 * agent-tab-mcp-gateway — Slice 12a (tracker-managed budget-wall demo).
 *
 * Stdio MCP server that exposes ONE concrete tool (default: `analyze_text`)
 * which forwards the call to Agent Tab's existing `POST /api/proxy`. Agent
 * Tab enforces every cap (credit-line limit) and returns a structured tab
 * snapshot. The gateway maps that to a clean MCP tool result.
 *
 * Boundary (Tightening Issue 2):
 *   - No Prisma. No src/lib/* imports. No tracker/crypto/signing helpers.
 *   - Only env config + MCP SDK + global fetch.
 *
 * Required env:
 *   AGENT_TAB_BASE_URL   (e.g. http://localhost:3000)
 *   AGENT_TAB_AGENT_KEY  (raw key — never logged, never echoed)
 *   AGENT_TAB_TOOL_ID    (e.g. auth-demo-tool-analyze-001)
 *
 * Optional env:
 *   AGENT_TAB_TIMEOUT_MS       (default 15000)
 *   AGENT_TAB_MCP_TOOL_NAME    (default analyze_text)
 *   AGENT_TAB_MCP_INPUT_SHAPE  (default text; allowed: text|none)
 *                              text — input schema { text: string }, forwarded
 *                                     to the upstream tool as { text }.
 *                              none — input schema {} (strict), forwarded as
 *                                     {}; for tools that take no caller input
 *                                     (e.g. budgeted_repo_lint).
 *
 * Output mapping (Tightening Issue 5):
 *   200          → isError false, "Charge accepted. Tab: $X / $Y used. …"
 *   402          → isError false, "Agent Tab denied this call: cap exceeded. …"
 *   403          → isError false, "Agent Tab denied this call: <reason>"
 *   409          → isError false, "Agent Tab denied this call: <code> → <error>"
 *   401          → isError true,  "Agent Tab gateway configuration error: agent key …"
 *   404          → isError true,  "Agent Tab gateway configuration error: tool …"
 *   tool ≥400    → isError true,  "The analyze tool failed: …"
 *   network/etc  → isError true,  "Agent Tab gateway error: …"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const NANOCREDITS_PER_CREDIT = BigInt(1_000_000_000);

function fmtCredits(nanoStr: string | undefined): string {
  if (typeof nanoStr !== "string") return "—";
  let n: bigint;
  try {
    n = BigInt(nanoStr);
  } catch {
    return nanoStr;
  }
  const whole = n / NANOCREDITS_PER_CREDIT;
  const frac = n % NANOCREDITS_PER_CREDIT;
  const fracPadded = frac.toString().padStart(9, "0").slice(0, 2);
  return `$${whole.toString()}.${fracPadded}`;
}

type InputShape = "text" | "none";

function readEnv(): {
  baseUrl: string;
  agentKey: string;
  toolId: string;
  timeoutMs: number;
  toolName: string;
  inputShape: InputShape;
} {
  const baseUrl = process.env.AGENT_TAB_BASE_URL;
  const agentKey = process.env.AGENT_TAB_AGENT_KEY;
  const toolId = process.env.AGENT_TAB_TOOL_ID;
  if (!baseUrl) {
    process.stderr.write("Missing AGENT_TAB_BASE_URL\n");
    process.exit(2);
  }
  if (!agentKey) {
    process.stderr.write("Missing AGENT_TAB_AGENT_KEY\n");
    process.exit(2);
  }
  if (!toolId) {
    process.stderr.write("Missing AGENT_TAB_TOOL_ID\n");
    process.exit(2);
  }
  const timeoutRaw = process.env.AGENT_TAB_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 15000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write("AGENT_TAB_TIMEOUT_MS must be a positive number\n");
    process.exit(2);
  }
  const toolName = process.env.AGENT_TAB_MCP_TOOL_NAME ?? "analyze_text";
  const inputShapeRaw = process.env.AGENT_TAB_MCP_INPUT_SHAPE ?? "text";
  if (inputShapeRaw !== "text" && inputShapeRaw !== "none") {
    process.stderr.write(`AGENT_TAB_MCP_INPUT_SHAPE must be "text" or "none" (got "${inputShapeRaw}")\n`);
    process.exit(2);
  }
  return { baseUrl, agentKey, toolId, timeoutMs, toolName, inputShape: inputShapeRaw };
}

type ToolResultContent = { type: "text"; text: string };
type ToolResult = { content: ToolResultContent[]; isError?: boolean };

interface ProxyTab {
  balance?: string;
  pending?: string;
  limit?: string;
  remaining?: string;
  utilization?: number;
  alert?: string | null;
}

interface ProxySuccess {
  toolResponse?: unknown;
  toolStatus?: number;
  tab?: ProxyTab;
}

interface ProxyError {
  error?: string;
  code?: string;
  currentBalance?: string;
  pendingBalance?: string;
  limit?: string;
  remaining?: string;
}

function summariseToolResponse(toolResponse: unknown): string {
  if (toolResponse === null || toolResponse === undefined) return "(no result)";
  if (typeof toolResponse === "string") return toolResponse.slice(0, 500);
  try {
    const json = JSON.stringify(toolResponse);
    return json.length > 500 ? json.slice(0, 497) + "…" : json;
  } catch {
    return "(unserialisable result)";
  }
}

function buildAllowedText(body: ProxySuccess): string {
  const tab = body.tab ?? {};
  const balance = fmtCredits(tab.balance);
  const limit = fmtCredits(tab.limit);
  const remaining = fmtCredits(tab.remaining);
  const utilization = typeof tab.utilization === "number" ? `${Math.round(tab.utilization * 100)}%` : "—";
  const alertSuffix =
    tab.alert === "limit_reached"
      ? " (limit reached — no further calls will be allowed)"
      : tab.alert === "threshold_warning"
        ? " (alert: approaching limit)"
        : "";
  const summary = summariseToolResponse(body.toolResponse);
  return [
    `Charge accepted. Tab: ${balance} / ${limit} used (${utilization} utilization)${alertSuffix}.`,
    `Remaining: ${remaining}.`,
    `Tool result: ${summary}`,
  ].join("\n");
}

function buildDeniedCapText(body: ProxyError): string {
  const balance = fmtCredits(body.currentBalance);
  const pending = fmtCredits(body.pendingBalance);
  const limit = fmtCredits(body.limit);
  const remaining = fmtCredits(body.remaining);
  return [
    `Agent Tab denied this call: cap exceeded. No state moved.`,
    `Tab: ${balance} current + ${pending} pending of ${limit} (remaining: ${remaining}).`,
  ].join("\n");
}

async function callProxy(
  cfg: ReturnType<typeof readEnv>,
  text: string | null,
): Promise<ToolResult> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/api/proxy`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const payload = text === null ? "{}" : JSON.stringify({ text });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-agent-api-key": cfg.agentKey,
        "x-tool-id": cfg.toolId,
        "Content-Type": "application/json",
      },
      body: payload,
      signal: ctrl.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: `Agent Tab gateway error: ${msg}. Is the Agent Tab backend running at ${cfg.baseUrl}?` }],
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      content: [{ type: "text", text: `Agent Tab gateway error: non-JSON response (status ${res.status}).` }],
      isError: true,
    };
  }

  // Allowed (200) — but check for upstream tool error first
  if (res.status === 200) {
    const success = body as ProxySuccess;
    if (typeof success.toolStatus === "number" && success.toolStatus >= 400) {
      const upstream = success.toolResponse as { error?: string } | undefined;
      const upstreamMsg = upstream?.error ?? `tool returned status ${success.toolStatus}`;
      return {
        content: [{ type: "text", text: `The ${cfg.toolName} tool failed: ${upstreamMsg}. (toolStatus ${success.toolStatus})` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: buildAllowedText(success) }] };
  }

  const err = body as ProxyError;

  // 402 cap exceeded — policy denial
  if (res.status === 402) {
    return { content: [{ type: "text", text: buildDeniedCapText(err) }] };
  }

  // 403 policy denials — business denial
  if (res.status === 403) {
    return {
      content: [{ type: "text", text: `Agent Tab denied this call: ${err.error ?? "unauthorized"}.` }],
    };
  }

  // 409 delegation/version conflicts — business denial with code
  if (res.status === 409) {
    const codeSuffix = err.code ? ` (${err.code})` : "";
    return {
      content: [{ type: "text", text: `Agent Tab denied this call: ${err.error ?? "request rejected"}${codeSuffix}.` }],
    };
  }

  // 401 invalid/inactive agent key — gateway misconfig
  if (res.status === 401) {
    return {
      content: [{ type: "text", text: `Agent Tab gateway configuration error: agent key is invalid or inactive.` }],
      isError: true,
    };
  }

  // 404 missing/inactive tool — gateway misconfig
  if (res.status === 404) {
    return {
      content: [{ type: "text", text: `Agent Tab gateway configuration error: configured tool is missing or inactive.` }],
      isError: true,
    };
  }

  // Anything else — treat as gateway error
  return {
    content: [{ type: "text", text: `Agent Tab gateway error: HTTP ${res.status} ${err.error ?? ""}`.trim() }],
    isError: true,
  };
}

async function main() {
  const cfg = readEnv();

  const server = new McpServer({
    name: "agent-tab-mcp-gateway",
    version: "0.1.0",
  });

  // .strict() rejects any unknown property at runtime — the model cannot pass
  // x-agent-api-key, toolId, or any other field as an argument.
  if (cfg.inputShape === "text") {
    const inputSchema = z
      .object({ text: z.string().min(1).describe("Text to analyze.") })
      .strict();
    server.registerTool(
      cfg.toolName,
      {
        description: "Analyze a piece of text via Agent Tab. Each call is metered against the agent's tab; the tab will refuse calls beyond its limit.",
        inputSchema,
      },
      async (args: { text: string }) => {
        return callProxy(cfg, args.text);
      },
    );
  } else {
    const inputSchema = z.object({}).strict();
    server.registerTool(
      cfg.toolName,
      {
        description: "Run a budgeted demo task via Agent Tab. Takes no arguments. Each call is metered against the agent's tab; the tab will refuse calls beyond its limit.",
        inputSchema,
      },
      async () => {
        return callProxy(cfg, null);
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Ready log goes to stderr ONLY — stdout is reserved for the MCP protocol.
  // Never log the agent key.
  process.stderr.write(
    `[mcp-gateway] ready: tool=${cfg.toolName}, shape=${cfg.inputShape}, base=${cfg.baseUrl}, toolId=${cfg.toolId}\n`,
  );
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[mcp-gateway] fatal: ${msg}\n`);
  process.exit(1);
});
