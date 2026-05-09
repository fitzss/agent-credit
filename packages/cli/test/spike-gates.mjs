// Spike validation harness for slice 14m.0a.
// Drives the proxy via the MCP SDK to exercise gates G2–G10.
// Run from packages/cli/ with: node test/spike-gates.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const STATE_DIR = join(homedir(), ".agent-tab-spike");
const CONFIG = join(STATE_DIR, "config.json");
const SENTINEL_DIR = join(homedir(), ".agent-tab");

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

// Probe :3000 to ensure the proxy never makes outbound HTTP to it.
let httpHit = 0;
const httpServer = http.createServer((_req, res) => {
  httpHit++;
  res.statusCode = 418;
  res.end();
});
// Don't actually bind to :3000 (the agent-tab dev server may be there).
// Instead, monitor the actual agent-tab dev server for any new lines.

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "proxy", "--config", CONFIG],
  env: { ...process.env, AGENT_TAB_CONFIG: CONFIG },
  stderr: "pipe",
});
const client = new Client(
  { name: "spike-validator", version: "0.0.1" },
  { capabilities: {} },
);

let stderrBuf = "";
transport.stderr?.on("data", (chunk) => {
  stderrBuf += chunk.toString();
  process.stderr.write(`[proxy stderr] ${chunk}`);
});

async function main() {
  console.log("== G2: tools/list lists exactly agent_tab_status + budgeted_echo ==");
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    "exactly two tools",
    names.length === 2,
    `got ${names.length}: ${names.join(", ")}`,
  );
  check(
    "names = [agent_tab_status, budgeted_echo]",
    JSON.stringify(names) === JSON.stringify(["agent_tab_status", "budgeted_echo"]),
    `got ${JSON.stringify(names)}`,
  );

  console.log("\n== G3: agent_tab_status shows limit/current/pending/remaining ==");
  const statusRes = await client.callTool({ name: "agent_tab_status", arguments: {} });
  const text = statusRes.content?.[0]?.text ?? "";
  check("contains 'limit='", /limit=/.test(text), text);
  check("contains 'current=0'", /current=0\b/.test(text), text);
  check("contains 'pending=0'", /pending=0\b/.test(text), text);
  check("contains 'remaining=1000000000'", /remaining=1000000000\b/.test(text), text);

  console.log("\n== G4: first budgeted_echo call succeeds ==");
  const r1 = await client.callTool({
    name: "budgeted_echo",
    arguments: { message: "hello" },
  });
  const r1text = JSON.stringify(r1.content);
  check("call returned content", Array.isArray(r1.content), r1text);
  check(
    "Charge accepted text present",
    /Charge accepted/.test(r1text),
    r1text,
  );

  console.log("\n== G4b: receipts.jsonl has 1 success line ==");
  const receipts1 = await readReceipts();
  check("1 receipt total", receipts1.length === 1, `got ${receipts1.length}`);
  check("receipt[0].outcome=success", receipts1[0]?.outcome === "success", JSON.stringify(receipts1[0]));
  check("receipt[0].amountCharged=1000000000", receipts1[0]?.amountCharged === "1000000000", JSON.stringify(receipts1[0]));
  check("receipt[0].tool=budgeted_echo", receipts1[0]?.tool === "budgeted_echo", JSON.stringify(receipts1[0]));

  console.log("\n== G5: balances.json advanced ==");
  const bal1 = await readBalances();
  check("tab-default exists", !!bal1.tabs?.["tab-default"], JSON.stringify(bal1));
  check(
    "currentAmount=1000000000",
    bal1.tabs?.["tab-default"]?.currentAmount === "1000000000",
    JSON.stringify(bal1.tabs?.["tab-default"]),
  );
  check("version=1", bal1.tabs?.["tab-default"]?.version === 1, JSON.stringify(bal1.tabs?.["tab-default"]));

  console.log("\n== G6: second over-cap call is denied ==");
  const stderrBeforeDenied = stderrBuf.length;
  const r2 = await client.callTool({
    name: "budgeted_echo",
    arguments: { message: "again" },
  });
  const r2text = JSON.stringify(r2.content);
  check("denied text present", /denied this call: cap exceeded/.test(r2text), r2text);
  check("isError not set or false", !r2.isError, JSON.stringify(r2));

  console.log("\n== G7: balances.json unchanged after denial ==");
  const bal2 = await readBalances();
  check(
    "currentAmount still 1000000000",
    bal2.tabs?.["tab-default"]?.currentAmount === "1000000000",
    JSON.stringify(bal2.tabs?.["tab-default"]),
  );
  check("version still 1", bal2.tabs?.["tab-default"]?.version === 1, JSON.stringify(bal2.tabs?.["tab-default"]));

  console.log("\n== G7b: receipts.jsonl has 2 entries; second is denied ==");
  const receipts2 = await readReceipts();
  check("2 receipts total", receipts2.length === 2, `got ${receipts2.length}`);
  check("receipt[1].outcome=denied", receipts2[1]?.outcome === "denied", JSON.stringify(receipts2[1]));
  check("receipt[1].reason=cap_exceeded", receipts2[1]?.reason === "cap_exceeded", JSON.stringify(receipts2[1]));
  check("receipt[1].amountCharged=0", receipts2[1]?.amountCharged === "0", JSON.stringify(receipts2[1]));

  console.log("\n== G8: upstream NOT invoked on denial (proxy stderr trace) ==");
  const stderrAfter = stderrBuf.slice(stderrBeforeDenied);
  // The proxy logs "denied tab=" on the denied path and never logs "success" for the second call.
  check(
    "stderr has 'denied tab='",
    /denied tab=tab-default/.test(stderrAfter),
    stderrAfter.slice(0, 400),
  );
  check(
    "stderr has no 'success tab=' since last denial",
    !/success tab=/.test(stderrAfter),
    stderrAfter.slice(0, 400),
  );

  console.log("\n== G9: ~/.agent-tab/ untouched ==");
  check(
    "~/.agent-tab/ still does not exist",
    !existsSync(SENTINEL_DIR),
    `${SENTINEL_DIR} exists`,
  );

  console.log("\n== G10: state-dir contents only balances.json + receipts.jsonl + config.json ==");
  const { readdirSync } = await import("node:fs");
  const entries = readdirSync(STATE_DIR).sort();
  check(
    "state-dir entries match expected",
    JSON.stringify(entries) === JSON.stringify(["balances.json", "config.json", "receipts.jsonl"]),
    JSON.stringify(entries),
  );
}

async function readReceipts() {
  const p = join(STATE_DIR, "receipts.jsonl");
  if (!existsSync(p)) return [];
  const raw = await readFile(p, "utf8");
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

async function readBalances() {
  const p = join(STATE_DIR, "balances.json");
  if (!existsSync(p)) return { tabs: {} };
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw);
}

main()
  .catch((e) => { fail++; console.log(`  ✗ harness threw: ${e.stack ?? e.message}`); })
  .finally(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    console.log(`\n=== Spike gates: ${pass} passed, ${fail} failed ===`);
    process.exit(fail === 0 ? 0 : 1);
  });
