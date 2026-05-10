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

export type Alert = null | "threshold_warning" | "limit_reached";

export interface StatusReport {
  tabId: string;
  limit: string;
  current: string;
  pending: string;
  remaining: string;
  utilization: string;
  alert: Alert;
}

// Mirrors hosted CreditLine.alertThreshold default (0.8).
const ALERT_THRESHOLD = 0.8;

export function statusReport(config: Config, balances: BalancesFile): StatusReport[] {
  return config.tabs.map((tab) => {
    const tb = ensureTab(balances, tab.id);
    const cur = BigInt(tb.currentAmount);
    const pend = BigInt(tb.pendingAmount);
    const lim = BigInt(tab.limitAmount);
    const remaining = lim - cur - pend;
    const utilPct = lim > 0n ? Number((cur + pend) * 10000n / lim) / 100 : 0;
    const alert: Alert =
      utilPct >= 100 ? "limit_reached"
      : utilPct >= ALERT_THRESHOLD * 100 ? "threshold_warning"
      : null;
    return {
      tabId: tab.id,
      limit: lim.toString(),
      current: cur.toString(),
      pending: pend.toString(),
      remaining: remaining < 0n ? "0" : remaining.toString(),
      utilization: utilPct.toFixed(2),
      alert,
    };
  });
}

// ===== Authority helpers =====

export function isPositiveIntString(s: unknown): s is string {
  return typeof s === "string" && /^[1-9]\d*$/.test(s);
}

export interface RequestInput {
  tabId?: string;
  requestedLimit?: string;
  requestedDelta?: string;
  reason?: string;
}

export interface ValidatedRequest {
  tab: TabEntry;
  requestedLimit?: string;
  requestedDelta?: string;
  reason: string;
}

// Strict validation per slice 14m.0b plan.
// Throws Error with a clear message on any violation.
export function validateRequestInput(config: Config, input: RequestInput): ValidatedRequest {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length === 0) {
    throw new Error("request rejected: reason is required and must be non-empty");
  }
  const hasLimit = input.requestedLimit !== undefined && input.requestedLimit !== null;
  const hasDelta = input.requestedDelta !== undefined && input.requestedDelta !== null;
  if (hasLimit && hasDelta) {
    throw new Error(
      "request rejected: supply exactly one of requestedLimit or requestedDelta, not both",
    );
  }
  if (!hasLimit && !hasDelta) {
    throw new Error(
      "request rejected: supply exactly one of requestedLimit or requestedDelta",
    );
  }
  if (hasLimit && !isPositiveIntString(input.requestedLimit)) {
    throw new Error(
      `request rejected: requestedLimit must be a positive integer decimal string`,
    );
  }
  if (hasDelta && !isPositiveIntString(input.requestedDelta)) {
    throw new Error(
      `request rejected: requestedDelta must be a positive integer decimal string`,
    );
  }
  let tab: TabEntry | undefined;
  if (input.tabId !== undefined && input.tabId !== null && input.tabId !== "") {
    tab = config.tabs.find((t) => t.id === input.tabId);
    if (!tab) {
      throw new Error(`request rejected: unknown tabId ${JSON.stringify(input.tabId)}`);
    }
  } else {
    tab = config.defaultTabId
      ? config.tabs.find((t) => t.id === config.defaultTabId)
      : undefined;
    if (!tab) tab = config.tabs[0];
  }
  return {
    tab,
    requestedLimit: hasLimit ? input.requestedLimit : undefined,
    requestedDelta: hasDelta ? input.requestedDelta : undefined,
    reason,
  };
}

// Refuse to set a limit lower than (currentAmount + pendingAmount).
export function validateNewLimit(
  newLimit: bigint,
  current: bigint,
  pending: bigint,
): void {
  if (newLimit < current + pending) {
    throw new Error(
      `would lower limit below current+pending (current=${current} pending=${pending} newLimit=${newLimit})`,
    );
  }
}

export interface GrantApplication {
  previousLimit: bigint;
  newLimit: bigint;
  delta: bigint;
}

// Compute the new limit from a grant request shape.
export function applyGrant(
  previousLimit: bigint,
  shape: { requestedLimit?: string; requestedDelta?: string; addAmount?: bigint; setLimitAmount?: bigint },
): GrantApplication {
  let newLimit: bigint;
  if (shape.requestedLimit !== undefined) {
    newLimit = BigInt(shape.requestedLimit);
  } else if (shape.requestedDelta !== undefined) {
    newLimit = previousLimit + BigInt(shape.requestedDelta);
  } else if (shape.setLimitAmount !== undefined) {
    newLimit = shape.setLimitAmount;
  } else if (shape.addAmount !== undefined) {
    newLimit = previousLimit + shape.addAmount;
  } else {
    throw new Error("applyGrant: no grant amount supplied");
  }
  return {
    previousLimit,
    newLimit,
    delta: newLimit - previousLimit,
  };
}
