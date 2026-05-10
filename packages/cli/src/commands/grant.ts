import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  writeConfig,
  type Config,
  type TabEntry,
} from "../config.js";
import {
  appendOperatorGrant,
  appendResolution,
  ensureTab,
  findPendingRequest,
  readBalances,
} from "../ledger.js";
import { applyGrant, statusReport, validateNewLimit } from "../core.js";
import { formatCredits } from "../format.js";

export interface GrantOptions {
  configPath?: string;
  tab?: string;
  setLimit?: string;
  add?: string;
  requestId?: string;
}

function fail(msg: string): never {
  process.stderr.write(`[agent-tab grant] ${msg}\n`);
  process.exit(2);
}

function findTab(config: Config, tabId: string | undefined): TabEntry {
  if (tabId !== undefined && tabId !== "") {
    const t = config.tabs.find((t) => t.id === tabId);
    if (!t) fail(`unknown tabId ${JSON.stringify(tabId)}`);
    return t;
  }
  if (config.defaultTabId) {
    const t = config.tabs.find((t) => t.id === config.defaultTabId);
    if (t) return t;
  }
  return config.tabs[0];
}

export async function runGrant(opts: GrantOptions): Promise<void> {
  const configPath =
    opts.configPath ?? process.env.AGENT_TAB_CONFIG ?? join(homedir(), ".agent-tab", "config.json");
  const config = await loadConfig(configPath);
  const balances = await readBalances(config.stateDir);

  // Sanity: exactly one of {--request-id} OR {--set-limit | --add}.
  const requestForm = !!opts.requestId;
  const operatorForm = !!opts.setLimit || !!opts.add;
  if (requestForm && operatorForm) {
    fail("supply either --request-id, or --set-limit/--add — not both");
  }
  if (!requestForm && !operatorForm) {
    fail("supply --request-id, or --tab + --set-limit, or --tab + --add");
  }
  if (!!opts.setLimit && !!opts.add) {
    fail("supply at most one of --set-limit or --add");
  }

  if (requestForm) {
    const pending = await findPendingRequest(config.stateDir, opts.requestId!);
    if (!pending) {
      fail(
        `request id ${opts.requestId} is unknown or already resolved`,
      );
    }
    const tab = findTab(config, pending.tabId);
    const previousLimit = BigInt(tab.limitAmount);
    const application = applyGrant(previousLimit, {
      requestedLimit: pending.requestedLimit,
      requestedDelta: pending.requestedDelta,
    });
    const tabBal = ensureTab(balances, tab.id);
    validateNewLimit(application.newLimit, BigInt(tabBal.currentAmount), BigInt(tabBal.pendingAmount));
    await mutateConfigLimit(config, configPath, tab, application.newLimit);
    await appendResolution(config.stateDir, {
      requestId: pending.id,
      previousLimit: previousLimit.toString(),
      newLimit: application.newLimit.toString(),
      delta: application.delta.toString(),
    });
    printGrantResult(config, tab, application.previousLimit, application.newLimit, "request approved");
    return;
  }

  // Operator-initiated grant.
  const tab = findTab(config, opts.tab);
  const previousLimit = BigInt(tab.limitAmount);
  let application;
  if (opts.setLimit !== undefined) {
    if (!/^\d+$/.test(opts.setLimit)) fail("--set-limit must be an unsigned integer");
    application = applyGrant(previousLimit, { setLimitAmount: BigInt(opts.setLimit) });
  } else {
    if (!/^\d+$/.test(opts.add!)) fail("--add must be an unsigned integer");
    application = applyGrant(previousLimit, { addAmount: BigInt(opts.add!) });
  }
  const tabBal = ensureTab(balances, tab.id);
  try {
    validateNewLimit(application.newLimit, BigInt(tabBal.currentAmount), BigInt(tabBal.pendingAmount));
  } catch (e) {
    fail((e as Error).message);
  }
  await mutateConfigLimit(config, configPath, tab, application.newLimit);
  await appendOperatorGrant(config.stateDir, {
    tabId: tab.id,
    previousLimit: application.previousLimit.toString(),
    newLimit: application.newLimit.toString(),
    delta: application.delta.toString(),
  });
  printGrantResult(config, tab, application.previousLimit, application.newLimit, "operator grant applied");
}

async function mutateConfigLimit(
  config: Config,
  configPath: string,
  tab: TabEntry,
  newLimit: bigint,
): Promise<void> {
  const updated: Config = {
    ...config,
    tabs: config.tabs.map((t) => (t.id === tab.id ? { ...t, limitAmount: newLimit.toString() } : t)),
  };
  await writeConfig(configPath, updated);
}

function printGrantResult(
  config: Config,
  tab: TabEntry,
  previousLimit: bigint,
  newLimit: bigint,
  banner: string,
): void {
  // Re-read the just-written limit by re-reading balances + computing report.
  // (We could compute inline, but reuse statusReport for output consistency.)
  const newConfig = {
    ...config,
    tabs: config.tabs.map((t) => (t.id === tab.id ? { ...t, limitAmount: newLimit.toString() } : t)),
  };
  // We don't have current balances re-read here — operator grant doesn't change them,
  // so we reuse the in-memory state by computing remaining from the new limit alone.
  console.log(banner);
  console.log(`  tab:         ${tab.id}`);
  console.log(`  previous:    ${formatCredits(previousLimit)}`);
  console.log(`  new limit:   ${formatCredits(newLimit)}`);
  console.log(`  delta:       ${formatCredits(newLimit - previousLimit)}`);
  // statusReport-style remaining/utilization requires balances; fetch async-free via best-effort:
  void newConfig;
}
