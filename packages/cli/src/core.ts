import { randomUUID } from "node:crypto";
import type { Config, TabEntry, ToolEntry } from "./config.js";
import type { BalancesFile, TabBalance } from "./ledger.js";
import { ensureTab } from "./ledger.js";

export interface AllowedDecision {
  decision: "allowed";
  tab: TabEntry;
  tool: ToolEntry;
  cost: bigint;
  previousAmount: bigint;
  newAmount: bigint;
}

export interface DeniedDecision {
  decision: "denied";
  reason: "cap_exceeded";
  tab: TabEntry;
  tool: ToolEntry;
  cost: bigint;
  currentAmount: bigint;
  pendingAmount: bigint;
  limitAmount: bigint;
}

export type Decision = AllowedDecision | DeniedDecision;

// Mirrors agent-tab/src/app/api/proxy/route.ts:62.
// Denied iff currentAmount + pendingAmount + costPerCall > limitAmount.
export function evaluate(
  config: Config,
  balances: BalancesFile,
  exposedToolName: string,
): Decision {
  const tool = config.tools.find((t) => t.exposedName === exposedToolName);
  if (!tool) throw new Error(`No configured tool with exposedName=${exposedToolName}`);
  // v0: single tab; if multiple, pick the tab whose scope matches "*" or the tool id.
  const tab =
    config.tabs.find((t) => t.scope === tool.id) ??
    config.tabs.find((t) => t.scope === "*") ??
    config.tabs[0];
  const tabBal = ensureTab(balances, tab.id);
  const current = BigInt(tabBal.currentAmount);
  const pending = BigInt(tabBal.pendingAmount);
  const cost = BigInt(tool.costPerCall);
  const limit = BigInt(tab.limitAmount);
  if (current + pending + cost > limit) {
    return {
      decision: "denied",
      reason: "cap_exceeded",
      tab,
      tool,
      cost,
      currentAmount: current,
      pendingAmount: pending,
      limitAmount: limit,
    };
  }
  return {
    decision: "allowed",
    tab,
    tool,
    cost,
    previousAmount: current,
    newAmount: current + cost,
  };
}

export function applyAllowed(b: BalancesFile, d: AllowedDecision): TabBalance {
  const tabBal = ensureTab(b, d.tab.id);
  tabBal.currentAmount = d.newAmount.toString();
  tabBal.version += 1;
  tabBal.updatedAt = new Date().toISOString();
  return tabBal;
}

export function deniedReceipt(d: DeniedDecision) {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    tabId: d.tab.id,
    tool: d.tool.exposedName,
    upstreamTool: d.tool.upstreamName,
    amountCharged: "0",
    outcome: "denied" as const,
    reason: d.reason,
    currentAmount: d.currentAmount.toString(),
    pendingAmount: d.pendingAmount.toString(),
    limitAmount: d.limitAmount.toString(),
  };
}

export function successReceipt(d: AllowedDecision) {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    tabId: d.tab.id,
    tool: d.tool.exposedName,
    upstreamTool: d.tool.upstreamName,
    amountCharged: d.cost.toString(),
    outcome: "success" as const,
    previousAmount: d.previousAmount.toString(),
    newAmount: d.newAmount.toString(),
  };
}

export function errorReceipt(d: AllowedDecision, message: string) {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    tabId: d.tab.id,
    tool: d.tool.exposedName,
    upstreamTool: d.tool.upstreamName,
    amountCharged: "0",
    outcome: "error" as const,
    error: message,
  };
}

export interface StatusReport {
  tabId: string;
  limit: string;
  current: string;
  pending: string;
  remaining: string;
  utilization: string;
}

export function statusReport(config: Config, balances: BalancesFile): StatusReport[] {
  return config.tabs.map((tab) => {
    const tb = ensureTab(balances, tab.id);
    const cur = BigInt(tb.currentAmount);
    const pend = BigInt(tb.pendingAmount);
    const lim = BigInt(tab.limitAmount);
    const remaining = lim - cur - pend;
    // utilization as a string; integer percent + 2 decimals
    const utilPct = lim > 0n
      ? Number((cur + pend) * 10000n / lim) / 100
      : 0;
    return {
      tabId: tab.id,
      limit: lim.toString(),
      current: cur.toString(),
      pending: pend.toString(),
      remaining: remaining < 0n ? "0" : remaining.toString(),
      utilization: utilPct.toFixed(2),
    };
  });
}
