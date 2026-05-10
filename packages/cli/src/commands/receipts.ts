import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { receiptsPath } from "../ledger.js";
import { formatCredits, glyphFor, labelFor, padRight, truncateIso } from "../format.js";

export interface ReceiptsOptions {
  configPath?: string;
  limit?: string;
  outcome?: string;
  tab?: string;
  json?: boolean;
  since?: string;
}

const ALLOWED_OUTCOMES = new Set(["success", "denied", "error"]);

interface Row {
  outcome: string;
  timestamp: string;
  tool?: string;
  tabId?: string;
  amountCharged?: string;
  reason?: string;
  error?: string;
  [key: string]: unknown;
}

export async function runReceipts(opts: ReceiptsOptions): Promise<void> {
  const configPath =
    opts.configPath ?? process.env.AGENT_TAB_CONFIG ?? join(homedir(), ".agent-tab", "config.json");
  const config = await loadConfig(configPath);
  const path = receiptsPath(config.stateDir);

  const rows: Row[] = [];
  if (existsSync(path)) {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Row);
      } catch {
        // skip malformed lines silently — append-only, atomic per-line writes
        // mean partial rows are not expected, but tolerate them.
      }
    }
  }

  // Filters.
  let filtered = rows;
  if (opts.outcome) {
    if (!ALLOWED_OUTCOMES.has(opts.outcome)) {
      process.stderr.write(
        `[agent-tab receipts] --outcome must be one of: ${[...ALLOWED_OUTCOMES].join(", ")}\n`,
      );
      process.exit(2);
    }
    filtered = filtered.filter((r) => r.outcome === opts.outcome);
  }
  if (opts.tab) {
    filtered = filtered.filter((r) => r.tabId === opts.tab);
  }
  if (opts.since) {
    const since = opts.since;
    filtered = filtered.filter((r) => typeof r.timestamp === "string" && r.timestamp >= since);
  }

  const limitN = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20;
  if (Number.isNaN(limitN) || limitN < 0) {
    process.stderr.write(`[agent-tab receipts] --limit must be a non-negative integer\n`);
    process.exit(2);
  }
  // Tail of file: take last N.
  const tail = filtered.slice(-limitN);

  if (opts.json) {
    console.log(JSON.stringify(tail, null, 2));
    return;
  }

  for (const r of tail) {
    const glyph = glyphFor(r.outcome);
    const label = padRight(labelFor(r.outcome), 14);
    const ts = padRight(truncateIso(r.timestamp ?? ""), 21);
    const tool = padRight(r.tool ?? "", 18);
    const amount =
      r.outcome === "success"
        ? formatCredits(BigInt(r.amountCharged ?? "0"))
        : "no charge";
    const detail =
      r.outcome === "denied"
        ? "  Credit limit exceeded"
        : r.outcome === "error"
        ? `  ${r.error ?? "upstream tool error"}`
        : "";
    console.log(`${glyph} ${label} ${ts} ${tool} ${amount}${detail}`);
  }
}
