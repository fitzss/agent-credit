// Slice 14m.0c release-candidate harness. Builds, packs, installs into a
// clean tmp consumer project, then drives the full earned-autonomy loop
// against the *installed* bin via the MCP SDK. Asserts G1–G27.
//
// Run from packages/cli/ with: node test/release-candidate.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import crypto from "node:crypto";

const PKG_DIR = resolve(".");
const SENTINEL_DIR = join(homedir(), ".agent-tab");

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

function md5OfDir(dir) {
  if (!existsSync(dir)) return "ABSENT";
  const h = crypto.createHash("md5");
  for (const ent of readdirSync(dir).sort()) {
    h.update(ent + "\0");
    const p = join(dir, ent);
    const st = statSync(p);
    h.update(`${st.size}\0${st.mtimeMs}\0`);
  }
  return h.digest("hex");
}

function md5OfFile(p) {
  if (!existsSync(p)) return "ABSENT";
  return crypto.createHash("md5").update(readFileSync(p)).digest("hex");
}

async function readJsonl(p) {
  if (!existsSync(p)) return [];
  const raw = await readFile(p, "utf8");
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const sentinelBaseline = md5OfDir(SENTINEL_DIR);
const RC_TMP = mkdtempSync(join(tmpdir(), "14m0c-rc-"));
const STATE_DIR = join(RC_TMP, ".agent-tab");
const CONFIG = join(STATE_DIR, "config.json");

console.log(`RC tmp dir: ${RC_TMP}`);

function runOnInstalled(cliBin, args) {
  const r = spawnSync(cliBin, args, { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

async function main() {
  // G1: build
  section("G1 — npm run build");
  const build = spawnSync("npm", ["run", "build"], { encoding: "utf8" });
  check("build exit 0", build.status === 0, build.stdout + build.stderr);
  for (const f of [
    "dist/index.js",
    "dist/commands/proxy.js",
    "dist/commands/init.js",
    "dist/commands/tabs.js",
    "dist/commands/receipts.js",
    "dist/commands/requests.js",
    "dist/commands/grant.js",
    "dist/format.js",
  ]) {
    check(`${f} exists`, existsSync(f));
  }

  // G2: tsc --noEmit
  section("G2 — tsc --noEmit");
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { encoding: "utf8" });
  check("tsc --noEmit exits 0", tsc.status === 0, tsc.stdout + tsc.stderr);

  // G3: npm pack --dry-run --json file list
  section("G3 — npm pack --dry-run file list = whitelist");
  const dry = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  check("pack --dry-run exit 0", dry.status === 0, dry.stderr);
  const dryJson = JSON.parse(dry.stdout);
  const fileList = (dryJson[0].files || []).map((f) => f.path).sort();
  check("no src/ in tarball",
    !fileList.some((f) => f.startsWith("src/")),
    fileList.filter((f) => f.startsWith("src/")).join(", "));
  check("no test/ in tarball",
    !fileList.some((f) => f.startsWith("test/")),
    fileList.filter((f) => f.startsWith("test/")).join(", "));
  check("no tsconfig.json in tarball",
    !fileList.includes("tsconfig.json"));
  check("dist/index.js included", fileList.includes("dist/index.js"));
  check("dist/commands/requests.js included", fileList.includes("dist/commands/requests.js"));
  check("recipes/mcp-inspector.md included", fileList.includes("recipes/mcp-inspector.md"));
  check("recipes/claude-desktop.md included", fileList.includes("recipes/claude-desktop.md"));
  check("README.md included", fileList.includes("README.md"));
  check("LICENSE included", fileList.includes("LICENSE"));
  check("sample-config.json included", fileList.includes("sample-config.json"));
  check("package.json included", fileList.includes("package.json"));

  // G4: npm pack
  section("G4 — npm pack produces tarball; prepack ran fresh build");
  const pack = spawnSync("npm", ["pack", "--pack-destination", RC_TMP], { encoding: "utf8" });
  check("pack exit 0", pack.status === 0, pack.stderr);
  const tarball = readdirSync(RC_TMP).find((f) => f.endsWith(".tgz"));
  check("tarball file present", !!tarball, readdirSync(RC_TMP).join(", "));
  const tarballPath = join(RC_TMP, tarball);

  // G5: install into fresh consumer project
  section("G5 — install tarball into clean tmp consumer project");
  const consumer = join(RC_TMP, "consumer");
  mkdirSync(consumer, { recursive: true });
  // Minimal package.json so npm install works there.
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "rc-consumer", version: "0.0.0", private: true,
  }) + "\n");
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: consumer, encoding: "utf8",
  });
  check("npm install exit 0", install.status === 0, install.stderr);
  const cliBin = join(consumer, "node_modules", ".bin", "agent-tab");
  check("agent-tab bin exists", existsSync(cliBin));
  // Ensure executable bit is set by npm.
  if (existsSync(cliBin)) {
    const st = statSync(cliBin);
    check("agent-tab bin is executable", (st.mode & 0o111) !== 0, `mode=${st.mode.toString(8)}`);
  }

  // G6: --help works
  section("G6 — agent-tab --help");
  const help = runOnInstalled(cliBin, ["--help"]);
  check("--help exit 0", help.code === 0, help.stderr);
  for (const cmd of ["proxy", "init", "tabs", "receipts", "requests", "grant"]) {
    check(`--help mentions '${cmd}'`, help.stdout.includes(cmd), help.stdout);
  }

  // G7: init creates config + idempotency
  section("G7 — init writes config; idempotency without --force exits 2");
  const init1 = runOnInstalled(cliBin, ["init", "--config", CONFIG, "--state-dir", STATE_DIR]);
  check("init exit 0", init1.code === 0, init1.stderr);
  check("config.json exists", existsSync(CONFIG));
  const initRetry = runOnInstalled(cliBin, ["init", "--config", CONFIG, "--state-dir", STATE_DIR]);
  check("re-init without --force exits 2", initRetry.code === 2);
  check("re-init mentions 'refusing to overwrite'", /refusing to overwrite/.test(initRetry.stderr));

  // Tighten the cap to 1 credit so the over-cap loop is just two calls.
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  cfg.tabs[0].limitAmount = "1000000000";
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");

  // G8: proxy lists 4 tools
  section("G8 — installed `agent-tab proxy` lists 4 tools (via MCP SDK)");
  const transport = new StdioClientTransport({
    command: cliBin,
    args: ["proxy", "--config", CONFIG],
    stderr: "pipe",
  });
  const client = new Client({ name: "rc-validator", version: "0.0.3-rc.1" }, { capabilities: {} });
  let stderrBuf = "";
  transport.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    process.stderr.write(`[proxy stderr] ${chunk}`);
  });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check("4 tools",
    JSON.stringify(names) === JSON.stringify([
      "agent_tab_request_more_authority",
      "agent_tab_status",
      "budgeted_echo",
      "budgeted_get_sum",
    ]),
    JSON.stringify(names));

  // G9: first budgeted_echo
  section("G9 — first budgeted_echo succeeds");
  const r1 = await client.callTool({ name: "budgeted_echo", arguments: { message: "hello" } });
  check("Charge accepted", /Charge accepted/.test(JSON.stringify(r1.content)));
  let receipts = await readJsonl(join(STATE_DIR, "receipts.jsonl"));
  check("1 success receipt", receipts.length === 1 && receipts[0].outcome === "success");

  // G10: over-cap denied
  section("G10 — over-cap denied; upstream NOT invoked");
  const stderrBeforeDeny = stderrBuf.length;
  const r2 = await client.callTool({ name: "budgeted_echo", arguments: { message: "again" } });
  check("Credit limit exceeded text", /Credit limit exceeded/.test(JSON.stringify(r2.content)));
  receipts = await readJsonl(join(STATE_DIR, "receipts.jsonl"));
  check("denied receipt added", receipts.length === 2 && receipts[1].outcome === "denied");
  const stderrAfterDeny = stderrBuf.slice(stderrBeforeDeny);
  check("stderr has 'denied tab='", /denied tab=/.test(stderrAfterDeny));
  check("stderr has no 'success tab=' since deny",
    !/success tab=/.test(stderrAfterDeny), stderrAfterDeny.slice(0, 400));

  // G11: agent_tab_request_more_authority happy path
  section("G11 — agent_tab_request_more_authority happy path");
  const cfgMd5Before = md5OfFile(CONFIG);
  const balMd5Before = md5OfFile(join(STATE_DIR, "balances.json"));
  const recCountBeforeReq = (await readJsonl(join(STATE_DIR, "receipts.jsonl"))).length;
  const r3 = await client.callTool({
    name: "agent_tab_request_more_authority",
    arguments: { requestedDelta: "5000000000", reason: "needs headroom" },
  });
  check("isError:false", !r3.isError);
  check("'Human approval is required' text",
    /Human approval is required/.test(JSON.stringify(r3.content)));
  const reqs = await readJsonl(join(STATE_DIR, "requests.jsonl"));
  check("requests.jsonl has 1 type=request,pending row",
    reqs.length === 1 && reqs[0].type === "request" && reqs[0].status === "pending");
  const requestId = reqs[0].id;
  check("config.json md5 unchanged", md5OfFile(CONFIG) === cfgMd5Before);
  check("balances.json md5 unchanged", md5OfFile(join(STATE_DIR, "balances.json")) === balMd5Before);
  check("receipts.jsonl line count unchanged",
    (await readJsonl(join(STATE_DIR, "receipts.jsonl"))).length === recCountBeforeReq);

  // G12: agent-tab requests shows the pending request
  section("G12 — agent-tab requests shows pending request; no work-receipt rows");
  const rqOut = runOnInstalled(cliBin, ["requests", "--config", CONFIG]);
  check("requests exit 0", rqOut.code === 0, rqOut.stderr);
  check("Pending Request label present", /Pending Request/.test(rqOut.stdout), rqOut.stdout);
  check("no Work Receipt label", !/Work Receipt/.test(rqOut.stdout));
  check("no Denied label", !/^✗ Denied/.test(rqOut.stdout));
  check("no Upstream Error label", !/Upstream Error/.test(rqOut.stdout));

  // G13: --pending filter
  section("G13 — agent-tab requests --pending");
  const pendOut = runOnInstalled(cliBin, ["requests", "--config", CONFIG, "--pending"]);
  check("--pending exit 0", pendOut.code === 0);
  check("--pending shows Pending Request", /Pending Request/.test(pendOut.stdout));

  // G14: --json
  section("G14 — agent-tab requests --json");
  const jsonOut = runOnInstalled(cliBin, ["requests", "--config", CONFIG, "--json"]);
  check("--json exit 0", jsonOut.code === 0);
  let parsed;
  try { parsed = JSON.parse(jsonOut.stdout); check("--json output parses", true); }
  catch (e) { check("--json output parses", false, e.message); }
  check("--json includes the request id",
    Array.isArray(parsed) && parsed.some((r) => r.id === requestId));

  // G15: grant --request-id
  section("G15 — grant --request-id resolves; no receipts mutation");
  const recCountBeforeG15 = (await readJsonl(join(STATE_DIR, "receipts.jsonl"))).length;
  const grantOut = runOnInstalled(cliBin, ["grant", "--config", CONFIG, "--request-id", requestId]);
  check("grant exit 0", grantOut.code === 0, grantOut.stderr);
  check("'request approved' banner", /request approved/.test(grantOut.stdout));
  const reqsAfterG15 = await readJsonl(join(STATE_DIR, "requests.jsonl"));
  check("requests.jsonl gained type=resolution row",
    reqsAfterG15.length === 2 && reqsAfterG15[1].type === "resolution");
  check("resolution.requestId matches",
    reqsAfterG15[1].requestId === requestId);
  check("receipts.jsonl unchanged after G15",
    (await readJsonl(join(STATE_DIR, "receipts.jsonl"))).length === recCountBeforeG15);

  // G16: load-bearing — same proxy, no restart, retry succeeds
  section("G16 — no-restart earned-autonomy via installed bin");
  const r4 = await client.callTool({ name: "budgeted_echo", arguments: { message: "after grant" } });
  check("Charge accepted after grant", /Charge accepted/.test(JSON.stringify(r4.content)));
  const recAfterG16 = await readJsonl(join(STATE_DIR, "receipts.jsonl"));
  check("receipts has +1 success", recAfterG16.length === recCountBeforeG15 + 1
    && recAfterG16[recAfterG16.length - 1].outcome === "success");

  // G17: operator-initiated grant
  section("G17 — operator grant via --add appends type=grant; receipts unchanged");
  const recCountBeforeG17 = recAfterG16.length;
  const grantAdd = runOnInstalled(cliBin, ["grant", "--config", CONFIG, "--tab", "tab-default", "--add", "1000000000"]);
  check("grant --add exit 0", grantAdd.code === 0, grantAdd.stderr);
  const reqsAfterG17 = await readJsonl(join(STATE_DIR, "requests.jsonl"));
  const lastG17 = reqsAfterG17[reqsAfterG17.length - 1];
  check("type=grant", lastG17.type === "grant");
  check("source=operator", lastG17.source === "operator");
  check("status=applied", lastG17.status === "applied");
  check("receipts.jsonl unchanged after G17",
    (await readJsonl(join(STATE_DIR, "receipts.jsonl"))).length === recCountBeforeG17);

  // G18: requests command shows all three event labels
  section("G18 — requests output covers all three event labels");
  const rqAll = runOnInstalled(cliBin, ["requests", "--config", CONFIG, "--limit", "50"]);
  check("Pending Request OR Resolved Request present",
    /Pending Request|Resolved Request/.test(rqAll.stdout), rqAll.stdout);
  check("Resolution present", /Resolution/.test(rqAll.stdout));
  check("Operator Grant present", /Operator Grant/.test(rqAll.stdout));

  // G19: receipts command stays pure
  section("G19 — receipts shows only Work Receipt / Denied / Upstream Error");
  const recOut = runOnInstalled(cliBin, ["receipts", "--config", CONFIG, "--limit", "50"]);
  check("Work Receipt label present", /Work Receipt/.test(recOut.stdout));
  check("Denied label present", /Denied/.test(recOut.stdout));
  check("no Resolution label in receipts", !/Resolution/.test(recOut.stdout));
  check("no Operator Grant label in receipts", !/Operator Grant/.test(recOut.stdout));
  check("no Pending Request label in receipts", !/Pending Request/.test(recOut.stdout));

  // G20: tabs
  section("G20 — agent-tab tabs shows all six fields");
  const tabsOut = runOnInstalled(cliBin, ["tabs", "--config", CONFIG]);
  for (const k of ["balance:", "pending:", "limit:", "remaining:", "utilization:", "alert:"]) {
    check(`tabs has '${k}' line`, tabsOut.stdout.includes(k));
  }

  // G21: over-tighten refused
  section("G21 — grant --set-limit 1 refused");
  const cfgMd5BeforeG21 = md5OfFile(CONFIG);
  const reqsCountBeforeG21 = reqsAfterG17.length;
  const tighten = runOnInstalled(cliBin, ["grant", "--config", CONFIG, "--tab", "tab-default", "--set-limit", "1"]);
  check("over-tighten exits 2", tighten.code === 2);
  check("stderr mentions 'would lower limit below current+pending'",
    /would lower limit below current\+pending/.test(tighten.stderr), tighten.stderr);
  check("config.json unchanged on refuse", md5OfFile(CONFIG) === cfgMd5BeforeG21);
  check("requests.jsonl unchanged on refuse",
    (await readJsonl(join(STATE_DIR, "requests.jsonl"))).length === reqsCountBeforeG21);

  // G22: claude_desktop_config.json snippet parses
  section("G22 — recipes/claude-desktop.md JSON snippet parses + uses installed-bin invocation");
  const cd = await readFile("recipes/claude-desktop.md", "utf8");
  const matches = [...cd.matchAll(/```json\s+([\s\S]*?)```/g)];
  check("recipe contains at least one JSON block", matches.length > 0);
  const firstSnippet = JSON.parse(matches[0][1]);
  check("snippet has mcpServers.agent-tab", !!firstSnippet?.mcpServers?.["agent-tab"]);
  const at = firstSnippet?.mcpServers?.["agent-tab"];
  check("snippet command is 'npx' or 'node' (installed-bin pattern)",
    at && (at.command === "npx" || at.command === "node"), JSON.stringify(at));
  check("snippet args includes 'agent-tab' or path with 'agent-tab'",
    Array.isArray(at?.args) && at.args.some((a) => /agent-tab/.test(a)));

  // G23: no localhost:3000 / fetch in shipped dist
  section("G23 — no localhost:3000 / fetch in dist/");
  const grepFetch = spawnSync("grep", ["-rnE", "\\bfetch\\(", "dist/"], { encoding: "utf8" });
  check("no executable fetch( in dist/", grepFetch.status !== 0);
  const grepLocal = spawnSync("grep", ["-rnE", "localhost:3000|127\\.0\\.0\\.1:3000|/api/proxy", "dist/"], { encoding: "utf8" });
  if (grepLocal.status === 0) {
    // Doc-comment cross-references compile through tsc as comments stripped by default,
    // but `tsconfig.json` has `removeComments` unset → comments preserved. Allow if string is in a comment.
    const lines = grepLocal.stdout.split("\n").filter(Boolean);
    const nonComment = lines.filter((l) => !/(\/\/|\/\*|\*).*localhost:3000|api\/proxy/.test(l));
    check("any localhost:3000 references in dist/ are doc-comment only", nonComment.length === 0,
      nonComment.join("\n"));
  } else {
    check("no localhost:3000 references in dist/", true);
  }

  // G24: ~/.agent-tab/ baseline unchanged + state-dir contents
  section("G24 — ~/.agent-tab/ baseline unchanged; state-dir contents = expected");
  check("~/.agent-tab/ md5 baseline matches", md5OfDir(SENTINEL_DIR) === sentinelBaseline);
  const ents = readdirSync(STATE_DIR).sort();
  check("state-dir contents match",
    JSON.stringify(ents) === JSON.stringify(["balances.json", "config.json", "receipts.jsonl", "requests.jsonl"]),
    JSON.stringify(ents));

  // Cleanup MCP session.
  await client.close().catch(() => {});
  await transport.close().catch(() => {});

  // G25 / G26 / G27 are run by the wrapping script (git diff + prove.sh).
  section("G25/G26/G27 — git scope + prove.sh (run by harness wrapper)");
  console.log("  (asserted externally by run-rc.sh)");
}

main()
  .catch((e) => { fail++; console.log(`  ✗ harness threw: ${e.stack ?? e.message}`); })
  .finally(() => {
    console.log(`\n=== RC gates: ${pass} passed, ${fail} failed ===`);
    console.log(`(rc tmp dir: ${RC_TMP} — preserved for inspection)`);
    process.exit(fail === 0 ? 0 : 1);
  });
