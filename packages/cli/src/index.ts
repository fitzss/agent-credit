#!/usr/bin/env node
import { Command } from "commander";
import { runProxy } from "./commands/proxy.js";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG = join(homedir(), ".agent-tab", "config.json");

const program = new Command();
program
  .name("agent-tab")
  .description("Agent Tab CLI — MCP proxy spike (slice 14m.0a)")
  .version("0.0.1");

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

// Surface deferred subcommand names honestly.
for (const cmd of ["init", "grant", "receipts", "tabs", "sync"]) {
  program
    .command(cmd)
    .description(`(not implemented in slice 14m.0a)`)
    .action(() => {
      console.error(
        `[agent-tab] '${cmd}' is not implemented in slice 14m.0a. ` +
          `This spike only ships 'proxy'. See packages/cli/README.md.`,
      );
      process.exit(2);
    });
}

program.parseAsync().catch((e) => {
  console.error("[agent-tab] fatal:", (e as Error).message);
  process.exit(2);
});
