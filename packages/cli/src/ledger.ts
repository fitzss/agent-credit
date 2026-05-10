import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p === "~" ? "." : p.slice(2));
  }
  return resolve(p);
}

export interface TabBalance {
  currentAmount: string;
  pendingAmount: string;
  version: number;
  updatedAt: string;
}

export interface BalancesFile {
  tabs: Record<string, TabBalance>;
}

export async function ensureStateDir(stateDir: string): Promise<string> {
  const dir = expandHome(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function balancesPath(stateDir: string): string {
  return join(expandHome(stateDir), "balances.json");
}

export function receiptsPath(stateDir: string): string {
  return join(expandHome(stateDir), "receipts.jsonl");
}

export async function readBalances(stateDir: string): Promise<BalancesFile> {
  const p = balancesPath(stateDir);
  if (!existsSync(p)) return { tabs: {} };
  const raw = await readFile(p, "utf8");
  if (raw.trim().length === 0) return { tabs: {} };
  return JSON.parse(raw) as BalancesFile;
}

// Atomic: write to temp, rename. Same dir → atomic on POSIX.
export async function writeBalances(stateDir: string, b: BalancesFile): Promise<void> {
  const dir = expandHome(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = balancesPath(stateDir);
  const tmp = join(dir, `.balances.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(b, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, target);
}

export async function appendReceipt(stateDir: string, receipt: object): Promise<void> {
  await ensureStateDir(stateDir);
  const line = JSON.stringify(receipt) + "\n";
  await appendFile(receiptsPath(stateDir), line, { mode: 0o600 });
}

export function ensureTab(b: BalancesFile, tabId: string): TabBalance {
  if (!b.tabs[tabId]) {
    b.tabs[tabId] = {
      currentAmount: "0",
      pendingAmount: "0",
      version: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  return b.tabs[tabId];
}

// ===== Authority ledger (requests.jsonl) =====
//
// Three event types share this file, distinguished by `type`:
//   type="request"     — appended by agent_tab_request_more_authority
//   type="resolution"  — appended by `agent-tab grant --request-id <id>`
//   type="grant"       — appended by `agent-tab grant --tab <id> --add/--set-limit`
// Append-only. No in-place edits.

export function requestsPath(stateDir: string): string {
  return join(expandHome(stateDir), "requests.jsonl");
}

export interface RequestRow {
  id: string;
  timestamp: string;
  type: "request";
  status: "pending";
  tabId: string;
  currentLimit: string;
  requestedLimit?: string;
  requestedDelta?: string;
  reason: string;
}

export interface ResolutionRow {
  id: string;
  timestamp: string;
  type: "resolution";
  requestId: string;
  status: "resolved";
  resolvedBy: "grant";
  previousLimit: string;
  newLimit: string;
  delta: string;
}

export interface OperatorGrantRow {
  id: string;
  timestamp: string;
  type: "grant";
  status: "applied";
  tabId: string;
  previousLimit: string;
  newLimit: string;
  delta: string;
  source: "operator";
}

export type AuthorityRow = RequestRow | ResolutionRow | OperatorGrantRow;

async function appendAuthorityRow(stateDir: string, row: AuthorityRow): Promise<void> {
  await ensureStateDir(stateDir);
  await appendFile(requestsPath(stateDir), JSON.stringify(row) + "\n", { mode: 0o600 });
}

export async function appendRequest(
  stateDir: string,
  fields: {
    tabId: string;
    currentLimit: string;
    requestedLimit?: string;
    requestedDelta?: string;
    reason: string;
  },
): Promise<RequestRow> {
  const row: RequestRow = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "request",
    status: "pending",
    tabId: fields.tabId,
    currentLimit: fields.currentLimit,
    ...(fields.requestedLimit ? { requestedLimit: fields.requestedLimit } : {}),
    ...(fields.requestedDelta ? { requestedDelta: fields.requestedDelta } : {}),
    reason: fields.reason,
  };
  await appendAuthorityRow(stateDir, row);
  return row;
}

export async function appendResolution(
  stateDir: string,
  fields: { requestId: string; previousLimit: string; newLimit: string; delta: string },
): Promise<ResolutionRow> {
  const row: ResolutionRow = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "resolution",
    requestId: fields.requestId,
    status: "resolved",
    resolvedBy: "grant",
    previousLimit: fields.previousLimit,
    newLimit: fields.newLimit,
    delta: fields.delta,
  };
  await appendAuthorityRow(stateDir, row);
  return row;
}

export async function appendOperatorGrant(
  stateDir: string,
  fields: { tabId: string; previousLimit: string; newLimit: string; delta: string },
): Promise<OperatorGrantRow> {
  const row: OperatorGrantRow = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "grant",
    status: "applied",
    tabId: fields.tabId,
    previousLimit: fields.previousLimit,
    newLimit: fields.newLimit,
    delta: fields.delta,
    source: "operator",
  };
  await appendAuthorityRow(stateDir, row);
  return row;
}

export async function readRequests(stateDir: string): Promise<AuthorityRow[]> {
  const p = requestsPath(stateDir);
  if (!existsSync(p)) return [];
  const raw = await readFile(p, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuthorityRow);
}

// "Is request X still pending?" — pending iff present as type=request and
// no later type=resolution row references it.
export interface PendingRequest extends RequestRow {}

export async function findPendingRequest(
  stateDir: string,
  requestId: string,
): Promise<PendingRequest | null> {
  const rows = await readRequests(stateDir);
  let req: RequestRow | null = null;
  let resolved = false;
  for (const r of rows) {
    if (r.type === "request" && r.id === requestId) req = r;
    if (r.type === "resolution" && r.requestId === requestId) resolved = true;
  }
  if (!req || resolved) return null;
  return req;
}
