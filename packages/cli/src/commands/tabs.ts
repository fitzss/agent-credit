import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { readBalances } from "../ledger.js";
import { statusReport } from "../core.js";
import { formatCredits } from "../format.js";

export interface TabsOptions {
  configPath?: string;
  json?: boolean;
}

export async function runTabs(opts: TabsOptions): Promise<void> {
  const configPath =
    opts.configPath ?? process.env.AGENT_TAB_CONFIG ?? join(homedir(), ".agent-tab", "config.json");
  const config = await loadConfig(configPath);
  const balances = await readBalances(config.stateDir);
  const reports = statusReport(config, balances);

  if (opts.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const r of reports) {
    console.log(r.tabId);
    console.log(`  balance:     ${formatCredits(BigInt(r.current))}`);
    console.log(`  pending:     ${formatCredits(BigInt(r.pending))}`);
    console.log(`  limit:       ${formatCredits(BigInt(r.limit))}`);
    console.log(`  remaining:   ${formatCredits(BigInt(r.remaining))}`);
    console.log(`  utilization: ${r.utilization}%`);
    console.log(`  alert:       ${r.alert ?? "none"}`);
    console.log("");
  }
}
