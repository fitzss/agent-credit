import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { loadConfig, type Config } from "../config.js";
import { Upstream } from "../upstream.js";
import {
  appendReceipt,
  appendRequest,
  ensureStateDir,
  readBalances,
  writeBalances,
} from "../ledger.js";
import {
  applyAllowed,
  deniedReceipt,
  errorReceipt,
  evaluate,
  statusReport,
  successReceipt,
  validateRequestInput,
  type RequestInput,
} from "../core.js";

function log(...args: unknown[]): void {
  // stdout is reserved for MCP protocol — all logging goes to stderr.
  console.error("[agent-tab proxy]", ...args);
}

interface ProxyOptions {
  configPath: string;
}

// JSON Schema → Zod raw shape. Spike scope: handle string/number/boolean
// top-level properties from upstream input schemas.
function jsonSchemaToZodShape(schema: unknown): ZodRawShape {
  if (!schema || typeof schema !== "object") return {};
  const s = schema as Record<string, unknown>;
  const props = (s.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
  const shape: ZodRawShape = {};
  for (const [name, p] of Object.entries(props)) {
    let zt: z.ZodTypeAny;
    switch (p.type) {
      case "string":
        zt = z.string();
        break;
      case "number":
      case "integer":
        zt = z.number();
        break;
      case "boolean":
        zt = z.boolean();
        break;
      default:
        zt = z.unknown();
    }
    if (typeof p.description === "string") zt = zt.describe(p.description);
    if (!required.has(name)) zt = zt.optional();
    shape[name] = zt;
  }
  return shape;
}

// Reads config.json from disk every call. Used by cap checks and status
// to support the no-restart earned-autonomy loop. Throws are caught at
// the call sites so a transient parse failure produces an MCP isError
// result instead of a process crash.
async function readFreshConfig(configPath: string): Promise<Config> {
  return await loadConfig(configPath);
}

export async function runProxy(opts: ProxyOptions): Promise<void> {
  const startupConfig: Config = await loadConfig(opts.configPath);
  await ensureStateDir(startupConfig.stateDir);

  log(`config loaded from ${opts.configPath}`);
  log(`state dir: ${startupConfig.stateDir}`);
  log(`upstream: ${startupConfig.upstream.command} ${startupConfig.upstream.args.join(" ")}`);

  const upstream = new Upstream();
  await upstream.connect(startupConfig);
  log("upstream connected");

  const upstreamTools = await upstream.listTools();
  log(`upstream advertises ${upstreamTools.length} tools`);

  // Preflight: every configured upstreamName must exist in upstream tools/list.
  const missing = startupConfig.tools.filter(
    (tc) => !upstreamTools.some((u) => u.name === tc.upstreamName),
  );
  if (missing.length > 0) {
    const found = upstreamTools.map((t) => t.name).join(", ");
    const want = missing.map((m) => m.upstreamName).join(", ");
    log(
      `preflight FAILED: configured upstream tool(s) not found: ${want}. ` +
        `Upstream advertises: ${found}`,
    );
    process.exit(2);
  }

  // Cache upstream schemas at startup; tool registrations don't change at runtime.
  const wrapped = startupConfig.tools.map((tc) => {
    const u = upstreamTools.find((t) => t.name === tc.upstreamName)!;
    return { ...tc, upstreamSchema: u.inputSchema, description: u.description };
  });

  const server = new McpServer({
    name: "@agent-tab/cli proxy",
    version: "0.0.2",
  });

  // Built-in: agent_tab_status — uses fresh config (limit may have changed).
  server.registerTool(
    "agent_tab_status",
    {
      description:
        "Returns the current Agent Tab budget status: limit, current, pending, remaining, utilization, alert for each tab.",
      inputSchema: {},
    },
    async () => {
      let cfg: Config;
      try {
        cfg = await readFreshConfig(opts.configPath);
      } catch (e) {
        return {
          content: [{ type: "text", text: `agent_tab_status: config read failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
      const balances = await readBalances(cfg.stateDir);
      const report = statusReport(cfg, balances);
      return {
        content: [
          {
            type: "text",
            text: report
              .map(
                (r) =>
                  `tab=${r.tabId} limit=${r.limit} current=${r.current} pending=${r.pending} ` +
                  `remaining=${r.remaining} utilization=${r.utilization}% alert=${r.alert ?? "none"}`,
              )
              .join("\n"),
          },
        ],
      };
    },
  );

  // Built-in: agent_tab_request_more_authority — strict validation, append to requests.jsonl,
  // never auto-approve, never mutate config or balances.
  server.registerTool(
    "agent_tab_request_more_authority",
    {
      description:
        "Submit a request for more authority on a tab. Human approval is required: the operator must run " +
        "`agent-tab grant --request-id <id>` to approve. This call never auto-approves and never mutates state.",
      inputSchema: {
        tabId: z.string().optional().describe("tab to extend; default: defaultTabId or first tab"),
        requestedLimit: z.string().optional().describe("absolute new limit, positive BigInt decimal string"),
        requestedDelta: z.string().optional().describe("delta on top of current limit, positive BigInt decimal string"),
        reason: z.string().describe("human-readable justification (required, non-empty)"),
      },
    },
    async (args: RequestInput) => {
      let cfg: Config;
      try {
        cfg = await readFreshConfig(opts.configPath);
      } catch (e) {
        return {
          content: [{ type: "text", text: `request rejected: config read failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
      let validated;
      try {
        validated = validateRequestInput(cfg, args);
      } catch (e) {
        log(`request rejected: ${(e as Error).message}`);
        return {
          content: [{ type: "text", text: (e as Error).message }],
          isError: true,
        };
      }
      const row = await appendRequest(cfg.stateDir, {
        tabId: validated.tab.id,
        currentLimit: validated.tab.limitAmount,
        requestedLimit: validated.requestedLimit,
        requestedDelta: validated.requestedDelta,
        reason: validated.reason,
      });
      log(`request submitted id=${row.id} tab=${validated.tab.id}`);
      return {
        content: [
          {
            type: "text",
            text:
              `Request submitted (id=${row.id}). Human approval is required. ` +
              `The operator must run \`agent-tab grant --request-id ${row.id}\` to approve. ` +
              `No state has been changed.`,
          },
        ],
      };
    },
  );

  // Wrapped upstream tools — cap check uses fresh config so grants take effect without restart.
  for (const tc of wrapped) {
    const shape = jsonSchemaToZodShape(tc.upstreamSchema);
    server.registerTool(
      tc.exposedName,
      {
        description:
          (tc.description ?? `Wraps upstream tool ${tc.upstreamName}.`) +
          ` (Cost: ${tc.costPerCall} nanoCredits per call. Cap-enforced.)`,
        inputSchema: shape,
      },
      async (args: Record<string, unknown>) => {
        // 1. Re-read config from disk so grants take effect without proxy restart.
        let cfg: Config;
        try {
          cfg = await readFreshConfig(opts.configPath);
        } catch (e) {
          log(`config read failed during ${tc.exposedName}: ${(e as Error).message}`);
          return {
            content: [
              { type: "text", text: `Agent Tab error: config read failed: ${(e as Error).message}` },
            ],
            isError: true,
          };
        }

        // 2. Cap check.
        const balances = await readBalances(cfg.stateDir);
        let decision;
        try {
          decision = evaluate(cfg, balances, tc.exposedName);
        } catch (e) {
          // Tool not in fresh config (e.g. removed). Surface as infrastructure failure.
          return {
            content: [
              { type: "text", text: `Agent Tab error: ${(e as Error).message}` },
            ],
            isError: true,
          };
        }
        if (decision.decision === "denied") {
          await appendReceipt(cfg.stateDir, deniedReceipt(decision));
          log(
            `denied tab=${decision.tab.id} tool=${tc.exposedName} ` +
              `current=${decision.currentAmount} limit=${decision.limitAmount}`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Agent Tab denied this call: Credit limit exceeded on tab ${decision.tab.id}. ` +
                  `current=${decision.currentAmount} pending=${decision.pendingAmount} ` +
                  `cost=${decision.cost} limit=${decision.limitAmount}. No state moved.`,
              },
            ],
          };
        }

        // 3. Forward to upstream.
        let upstreamResult: unknown;
        try {
          upstreamResult = await upstream.callTool(tc.upstreamName, args);
        } catch (e) {
          await appendReceipt(cfg.stateDir, errorReceipt(decision, (e as Error).message));
          log(`upstream error tool=${tc.upstreamName}: ${(e as Error).message}`);
          return {
            content: [
              {
                type: "text",
                text: `Upstream tool ${tc.upstreamName} failed: ${(e as Error).message}. No charge.`,
              },
            ],
            isError: true,
          };
        }

        // 4. Persist receipt + new balances.
        applyAllowed(balances, decision);
        await writeBalances(cfg.stateDir, balances);
        await appendReceipt(cfg.stateDir, successReceipt(decision));
        log(
          `success tab=${decision.tab.id} tool=${tc.exposedName} ` +
            `prev=${decision.previousAmount} new=${decision.newAmount}`,
        );

        const upstreamContent =
          upstreamResult && typeof upstreamResult === "object" && "content" in upstreamResult
            ? (upstreamResult as { content: unknown }).content
            : [{ type: "text", text: JSON.stringify(upstreamResult) }];

        return {
          content: [
            {
              type: "text",
              text:
                `Charge accepted on tab ${decision.tab.id}. ` +
                `previous=${decision.previousAmount} new=${decision.newAmount} ` +
                `limit=${BigInt(decision.tab.limitAmount)}.`,
            },
            ...((upstreamContent as Array<unknown>) ?? []),
          ] as Array<{ type: "text"; text: string }>,
        };
      },
    );
  }

  log(
    "registered tools: agent_tab_status, agent_tab_request_more_authority, " +
      wrapped.map((w) => w.exposedName).join(", "),
  );

  // Connect own server transport last, so tools/list is fully populated.
  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);
  log("ready (stdio)");

  // Keep the process alive until parent disconnects.
  await new Promise<void>((resolve) => {
    process.stdin.on("close", () => resolve());
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });

  await upstream.close();
  log("upstream closed");
}
