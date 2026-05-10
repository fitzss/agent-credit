#!/usr/bin/env node
import { Command, Option } from "commander";
import { runProxy } from "./commands/proxy.js";
import { runInit } from "./commands/init.js";
import { runTabs } from "./commands/tabs.js";
import { runReceipts } from "./commands/receipts.js";
import { runGrant } from "./commands/grant.js";
import { runRequests } from "./commands/requests.js";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG = join(homedir(), ".agent-tab", "config.json");

const program = new Command();
program
  .name("agent-tab")
  .description("Agent Tab CLI — local-first MCP proxy with budgeted tools, work receipts, and an authority ledger.")
  .version("0.0.3-rc.1");

program
  .command("proxy")
  .description("Run the Agent Tab MCP proxy on stdio")
  .option(
    "-c, --config <path>",
    `path to config.json (default: $AGENT_TAB_CONFIG or ${DEFAULT_CONFIG})`,
  )
  .action(async (opts: { config?: string }) => {
    const configPath = opts.config ?? process.env.AGENT_TAB_CONFIG ?? DEFAULT_CONFIG;
    try {
      await runProxy({ configPath });
    } catch (e) {
      console.error("[agent-tab proxy] fatal:", (e as Error).message);
      process.exit(2);
    }
  });

program
  .command("init")
  .description("Write a fresh config.json with sensible defaults")
  .option("-c, --config <path>", "config path (default: ~/.agent-tab/config.json)")
  .option("--state-dir <path>", "state dir (default: ~/.agent-tab)")
  .option("--upstream-command <cmd>", "upstream MCP server command (default: npx)")
  .option(
    "--upstream-args <comma-separated>",
    "upstream args, comma-separated (default: -y,@modelcontextprotocol/server-everything)",
  )
  .addOption(
    new Option("--wrap-tool <name[=cost]>", "upstream tool to wrap (repeatable)")
      .argParser((v, prev) => (Array.isArray(prev) ? [...prev, v] : [v])),
  )
  .option("--limit <nanocredits>", "tab limit in nanoCredits (default: 10000000000)")
  .option("-f, --force", "overwrite existing config")
  .action(async (opts: {
    config?: string;
    stateDir?: string;
    upstreamCommand?: string;
    upstreamArgs?: string;
    wrapTool?: string[];
    limit?: string;
    force?: boolean;
  }) => {
    try {
      await runInit({
        configPath: opts.config,
        stateDir: opts.stateDir,
        upstreamCommand: opts.upstreamCommand,
        upstreamArgs: opts.upstreamArgs,
        wrapTool: opts.wrapTool,
        limit: opts.limit,
        force: opts.force,
      });
    } catch (e) {
      console.error("[agent-tab init] fatal:", (e as Error).message);
      process.exit(2);
    }
  });

program
  .command("tabs")
  .description("Show tab balances")
  .option("-c, --config <path>", "config path")
  .option("--json", "output JSON")
  .action(async (opts: { config?: string; json?: boolean }) => {
    try {
      await runTabs({ configPath: opts.config, json: opts.json });
    } catch (e) {
      console.error("[agent-tab tabs] fatal:", (e as Error).message);
      process.exit(2);
    }
  });

program
  .command("receipts")
  .description("Show recent Work Receipts (tool-call outcomes)")
  .option("-c, --config <path>", "config path")
  .option("-l, --limit <N>", "max rows (default: 20)")
  .option("--outcome <kind>", "filter: success|denied|error")
  .option("--tab <id>", "filter by tab id")
  .option("--since <ISO>", "filter by ISO timestamp")
  .option("--json", "output JSON")
  .action(async (opts: {
    config?: string;
    limit?: string;
    outcome?: string;
    tab?: string;
    since?: string;
    json?: boolean;
  }) => {
    try {
      await runReceipts({
        configPath: opts.config,
        limit: opts.limit,
        outcome: opts.outcome,
        tab: opts.tab,
        since: opts.since,
        json: opts.json,
      });
    } catch (e) {
      console.error("[agent-tab receipts] fatal:", (e as Error).message);
      process.exit(2);
    }
  });

program
  .command("grant")
  .description("Raise a tab limit (operator action)")
  .option("-c, --config <path>", "config path")
  .option("--tab <id>", "tab to grant on (default: defaultTabId)")
  .option("--set-limit <nanocredits>", "absolute new limit")
  .option("--add <nanocredits>", "delta to add to current limit")
  .option("--request-id <id>", "approve a pending request as-is")
  .action(async (opts: {
    config?: string;
    tab?: string;
    setLimit?: string;
    add?: string;
    requestId?: string;
  }) => {
    try {
      await runGrant({
        configPath: opts.config,
        tab: opts.tab,
        setLimit: opts.setLimit,
        add: opts.add,
        requestId: opts.requestId,
      });
    } catch (e) {
      console.error("[agent-tab grant] fatal:", (e as Error).message);
      process.exit(2);
    }
  });

program
  .command("requests")
  .description("Show authority ledger rows (request, resolution, grant)")
  .option("-c, --config <path>", "config path")
  .option("-l, --limit <N>", "max rows (default: 20)")
  .option("--type <kind>", "filter: request|resolution|grant")
  .option("--pending", "show only requests still awaiting approval")
  .option("--tab <id>", "filter by tab id")
  .option("--since <ISO>", "filter by ISO timestamp")
  .option("--json", "output JSON")
  .action(async (opts: {
    config?: string;
    limit?: string;
    type?: string;
    pending?: boolean;
    tab?: string;
    since?: string;
    json?: boolean;
  }) => {
    try {
      await runRequests({
        configPath: opts.config,
        limit: opts.limit,
        type: opts.type,
        pending: opts.pending,
        tab: opts.tab,
        since: opts.since,
        json: opts.json,
      });
    } catch (e) {
      console.error("[agent-tab requests] fatal:", (e as Error).message);
      process.exit(2);
    }
  });

// Honest stub for not-yet-implemented commands.
for (const cmd of ["sync"]) {
  program
    .command(cmd)
    .description(`(not implemented in slice 14m.0c)`)
    .action(() => {
      console.error(
        `[agent-tab] '${cmd}' is not implemented in slice 14m.0c. ` +
          `See packages/cli/README.md.`,
      );
      process.exit(2);
    });
}

program.parseAsync().catch((e) => {
  console.error("[agent-tab] fatal:", (e as Error).message);
  process.exit(2);
});
