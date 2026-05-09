import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { loadConfig, type Config } from "../config.js";
import { Upstream } from "../upstream.js";
import {
  appendReceipt,
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

export async function runProxy(opts: ProxyOptions): Promise<void> {
  const config: Config = await loadConfig(opts.configPath);
  await ensureStateDir(config.stateDir);

  log(`config loaded from ${opts.configPath}`);
  log(`state dir: ${config.stateDir}`);
  log(`upstream: ${config.upstream.command} ${config.upstream.args.join(" ")}`);

  const upstream = new Upstream();
  await upstream.connect(config);
  log("upstream connected");

  const tools = await upstream.listTools();
  log(`upstream advertises ${tools.length} tools`);

  // Resolve each configured tool's schema by name.
  const wrapped = config.tools.map((tc) => {
    const u = tools.find((t) => t.name === tc.upstreamName);
    if (!u) {
      throw new Error(
        `Configured upstream tool ${tc.upstreamName} not found in upstream tools/list. ` +
          `Available: ${tools.map((t) => t.name).join(", ")}`,
      );
    }
    return { ...tc, upstreamSchema: u.inputSchema, description: u.description };
  });

  const server = new McpServer({
    name: "@agent-tab/cli proxy",
    version: "0.0.1",
  });

  // Built-in: agent_tab_status
  server.registerTool(
    "agent_tab_status",
    {
      description:
        "Returns the current Agent Tab budget status: limit, current, pending, remaining, utilization for each tab.",
      inputSchema: {},
    },
    async () => {
      const balances = await readBalances(config.stateDir);
      const report = statusReport(config, balances);
      return {
        content: [
          {
            type: "text",
            text: report
              .map(
                (r) =>
                  `tab=${r.tabId} limit=${r.limit} current=${r.current} pending=${r.pending} ` +
                  `remaining=${r.remaining} utilization=${r.utilization}%`,
              )
              .join("\n"),
          },
        ],
      };
    },
  );

  // Wrapped upstream tools.
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
        // 1. Cap check.
        const balances = await readBalances(config.stateDir);
        const decision = evaluate(config, balances, tc.exposedName);
        if (decision.decision === "denied") {
          await appendReceipt(config.stateDir, deniedReceipt(decision));
          log(
            `denied tab=${decision.tab.id} tool=${tc.exposedName} ` +
              `current=${decision.currentAmount} limit=${decision.limitAmount}`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Agent Tab denied this call: cap exceeded on tab ${decision.tab.id}. ` +
                  `current=${decision.currentAmount} pending=${decision.pendingAmount} ` +
                  `cost=${decision.cost} limit=${decision.limitAmount}. No state moved.`,
              },
            ],
          };
        }

        // 2. Forward to upstream.
        let upstreamResult: unknown;
        try {
          upstreamResult = await upstream.callTool(tc.upstreamName, args);
        } catch (e) {
          await appendReceipt(
            config.stateDir,
            errorReceipt(decision, (e as Error).message),
          );
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

        // 3. Persist receipt + new balances.
        applyAllowed(balances, decision);
        await writeBalances(config.stateDir, balances);
        await appendReceipt(config.stateDir, successReceipt(decision));
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

  log("registered tools: agent_tab_status, " + wrapped.map((w) => w.exposedName).join(", "));

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
