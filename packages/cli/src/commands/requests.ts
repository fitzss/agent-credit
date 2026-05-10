import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { readRequests, type AuthorityRow } from "../ledger.js";
import { glyphForAuthority, labelForAuthority, padRight, truncateIso, formatCredits } from "../format.js";

export interface RequestsOptions {
  configPath?: string;
  pending?: boolean;
  type?: string;
  tab?: string;
  limit?: string;
  since?: string;
  json?: boolean;
}

const ALLOWED_TYPES = new Set(["request", "resolution", "grant"]);

export async function runRequests(opts: RequestsOptions): Promise<void> {
  const configPath =
    opts.configPath ?? process.env.AGENT_TAB_CONFIG ?? join(homedir(), ".agent-tab", "config.json");
  const config = await loadConfig(configPath);
  const rows = await readRequests(config.stateDir);

  // Pre-compute resolved set if --pending requested.
  const resolvedRequestIds = new Set<string>();
  for (const r of rows) {
    if (r.type === "resolution") resolvedRequestIds.add(r.requestId);
  }

  let filtered: AuthorityRow[] = rows;

  if (opts.type) {
    if (!ALLOWED_TYPES.has(opts.type)) {
      process.stderr.write(
        `[agent-tab requests] --type must be one of: ${[...ALLOWED_TYPES].join(", ")}\n`,
      );
      process.exit(2);
    }
    filtered = filtered.filter((r) => r.type === opts.type);
  }

  if (opts.pending) {
    filtered = filtered.filter((r) => r.type === "request" && !resolvedRequestIds.has(r.id));
  }

  if (opts.tab) {
    filtered = filtered.filter((r) => {
      if (r.type === "request") return r.tabId === opts.tab;
      if (r.type === "grant") return r.tabId === opts.tab;
      // Resolution rows don't carry tabId directly — look up via their requestId.
      if (r.type === "resolution") {
        const linked = rows.find((q) => q.type === "request" && q.id === r.requestId);
        return linked?.type === "request" && linked.tabId === opts.tab;
      }
      return false;
    });
  }

  if (opts.since) {
    const since = opts.since;
    filtered = filtered.filter((r) => typeof r.timestamp === "string" && r.timestamp >= since);
  }

  const limitN = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20;
  if (Number.isNaN(limitN) || limitN < 0) {
    process.stderr.write(`[agent-tab requests] --limit must be a non-negative integer\n`);
    process.exit(2);
  }
  const tail = filtered.slice(-limitN);

  if (opts.json) {
    console.log(JSON.stringify(tail, null, 2));
    return;
  }

  for (const r of tail) {
    const ts = padRight(truncateIso(r.timestamp ?? ""), 21);
    if (r.type === "request") {
      const isPending = !resolvedRequestIds.has(r.id);
      const glyph = isPending ? glyphForAuthority("request_pending") : glyphForAuthority("request_resolved");
      const label = padRight(isPending ? labelForAuthority("request_pending") : labelForAuthority("request_resolved"), 18);
      const tab = padRight(r.tabId, 14);
      const ask = r.requestedDelta
        ? `+${formatCredits(BigInt(r.requestedDelta))}`
        : `=${formatCredits(BigInt(r.requestedLimit ?? "0"))}`;
      const reason = r.reason ? `  "${r.reason}"` : "";
      const idTail = r.id.length > 8 ? r.id.slice(0, 8) + "…" : r.id;
      console.log(`${glyph} ${label} ${ts} ${tab} ${ask}${reason}  id=${idTail}`);
    } else if (r.type === "resolution") {
      const glyph = glyphForAuthority("resolution");
      const label = padRight(labelForAuthority("resolution"), 18);
      const linked = rows.find((q) => q.type === "request" && q.id === r.requestId);
      const tab = padRight(linked && linked.type === "request" ? linked.tabId : "", 14);
      const prev = formatCredits(BigInt(r.previousLimit));
      const next = formatCredits(BigInt(r.newLimit));
      const idTail = r.requestId.length > 8 ? r.requestId.slice(0, 8) + "…" : r.requestId;
      console.log(`${glyph} ${label} ${ts} ${tab} prev=${prev} → new=${next}  resolves=${idTail}`);
    } else if (r.type === "grant") {
      const glyph = glyphForAuthority("grant");
      const label = padRight(labelForAuthority("grant"), 18);
      const tab = padRight(r.tabId, 14);
      const prev = formatCredits(BigInt(r.previousLimit));
      const next = formatCredits(BigInt(r.newLimit));
      console.log(`${glyph} ${label} ${ts} ${tab} prev=${prev} → new=${next}  source=${r.source}`);
    }
  }
}
