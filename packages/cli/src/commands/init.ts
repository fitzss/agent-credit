import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeConfig, type Config, type ToolEntry, type TabEntry } from "../config.js";
import { expandHome } from "../ledger.js";

export interface InitOptions {
  configPath?: string;
  stateDir?: string;
  upstreamCommand?: string;
  upstreamArgs?: string;
  wrapTool?: string[];
  limit?: string;
  force?: boolean;
}

const DEFAULT_COST_PER_CALL = "1000000000"; // 1 credit
const DEFAULT_LIMIT = "10000000000"; // 10 credits
const DEFAULT_TAB_ID = "tab-default";
const DEFAULT_UPSTREAM_COMMAND = "npx";
const DEFAULT_UPSTREAM_ARGS = ["-y", "@modelcontextprotocol/server-everything"];
const DEFAULT_WRAPS = ["echo", "get-sum"];

function deriveExposedName(upstream: string): string {
  return "budgeted_" + upstream.replaceAll("-", "_");
}

function parseWrapToolArg(arg: string): { upstreamName: string; cost: string } {
  const eq = arg.indexOf("=");
  if (eq < 0) return { upstreamName: arg, cost: DEFAULT_COST_PER_CALL };
  const name = arg.slice(0, eq);
  const cost = arg.slice(eq + 1);
  if (!/^\d+$/.test(cost)) {
    throw new Error(
      `--wrap-tool ${JSON.stringify(arg)}: cost must be an unsigned integer (nanoCredits)`,
    );
  }
  return { upstreamName: name, cost };
}

export async function runInit(opts: InitOptions): Promise<void> {
  const configPath =
    opts.configPath ?? process.env.AGENT_TAB_CONFIG ?? join(homedir(), ".agent-tab", "config.json");

  if (existsSync(configPath) && !opts.force) {
    process.stderr.write(
      `[agent-tab init] refusing to overwrite existing ${configPath}. ` +
        `Pass --force to overwrite.\n`,
    );
    process.exit(2);
  }

  const stateDir = opts.stateDir ?? join(homedir(), ".agent-tab");
  const upstreamCommand = opts.upstreamCommand ?? DEFAULT_UPSTREAM_COMMAND;
  const upstreamArgs = opts.upstreamArgs
    ? opts.upstreamArgs.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : DEFAULT_UPSTREAM_ARGS;

  // Resolve tools.
  const wrapInputs = opts.wrapTool && opts.wrapTool.length > 0 ? opts.wrapTool : DEFAULT_WRAPS;
  const tools: ToolEntry[] = [];
  const seenExposed = new Set<string>();
  for (const w of wrapInputs) {
    const { upstreamName, cost } = parseWrapToolArg(w);
    const exposedName = deriveExposedName(upstreamName);
    if (seenExposed.has(exposedName)) {
      process.stderr.write(
        `[agent-tab init] ambiguous --wrap-tool: ${JSON.stringify(upstreamName)} ` +
          `produces exposedName ${JSON.stringify(exposedName)} that collides with another wrap. ` +
          `Refusing to write config.\n`,
      );
      process.exit(2);
    }
    seenExposed.add(exposedName);
    tools.push({
      id: `wrap-${upstreamName}`,
      upstreamName,
      exposedName,
      costPerCall: cost,
    });
  }

  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!/^\d+$/.test(limit)) {
    process.stderr.write(`[agent-tab init] --limit must be an unsigned integer\n`);
    process.exit(2);
  }

  const tab: TabEntry = {
    id: DEFAULT_TAB_ID,
    scope: "*",
    limitAmount: limit,
  };

  const config: Config = {
    version: 1,
    stateDir,
    upstream: {
      command: upstreamCommand,
      args: upstreamArgs,
      env: {},
    },
    tools,
    tabs: [tab],
    defaultTabId: DEFAULT_TAB_ID,
  };

  await writeConfig(configPath, config);
  // Pre-create the state dir too.
  const { ensureStateDir } = await import("../ledger.js");
  await ensureStateDir(stateDir);

  // stdout is fine here — `init` is not the proxy; nothing depends on stdio MCP discipline.
  console.log(`Wrote ${configPath}`);
  console.log(`State dir: ${expandHome(stateDir)}`);
  console.log(`Upstream: ${upstreamCommand} ${upstreamArgs.join(" ")}`);
  console.log(`Wrapped tools: ${tools.map((t) => t.exposedName).join(", ")}`);
  console.log(`Tab limit: ${limit} nanoCredits`);
  console.log("");
  console.log("Next: `agent-tab proxy` (stdio). See packages/cli/recipes/ for client setup.");
}
