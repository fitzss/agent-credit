import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
