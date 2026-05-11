#!/usr/bin/env tsx
/**
 * receipt-to-settlement-demo (slice 15a)
 *
 * Smallest single-lane vertical that walks one local MCP Work Receipt
 * (from packages/cli/receipts.jsonl) all the way to a SettlementEvent
 * against the dedicated demo reserve from slice 13b.
 *
 * Pipeline: work → receipt → obligation → settlement.
 *   0  Preflight (HTTP, cookie, Demo Debtor, demo reserve manifest).
 *   1  Ensure MCP Bridge Demo Tools fixture (idempotent).
 *   2  Select receipt + match by Tool.name (honest 1:1 mapping).
 *   3  Import: dedupe → tracker.proposeNoteUpdate → UsageEvent.create.
 *   4  Readiness audit (subprocess).
 *   5  POST /api/reserves/redeem.
 *   6  Verify: SettlementEvent created + obligation reduced + canonical
 *      reserve untouched.
 *
 * NEVER mutates: prisma schema, chaincash, sidecar, the redeem route,
 * validate.sh, prove.sh, the canonical reserve, the Repo-lint lane.
 *
 * No --cleanup. Re-runs accumulate audit history. Same receipt id is
 * deduped via UsageEvent.requestRef.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { tracker, TrackerError } from "@/lib/tracker/service";
import { generateKeypair } from "@/lib/crypto";
import { operatorCookieHeader } from "./lib/test-session";

// ─── Constants ──────────────────────────────────────────────────────────

// Canonical reserve denylist (mirrors slice-13b's seed + 13c's panic guard).
const CANONICAL_RESERVE_ID = "e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c";
const CANONICAL_RESERVE_TOKEN_ID =
  "2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937";
const CANONICAL_TRACKER_NFT_ID =
  "d234898d01d478db47ab2073e4e5289a414be79e0ecb8670a9f4fc44d8d70f5b";

// Demo reserve manifest from slice 13b.
const DEMO_STATE_DIR = path.join(__dirname, "..", ".demo-state");
const MANIFEST_FILE = path.join(DEMO_STATE_DIR, "settlement-demo-reserve.json");

// MCP Bridge fixture (15a-dedicated; never collides with Repo-lint).
// In 15a demo mode the agent + credit-line are pinned to Demo Debtor;
// in 16c operator mode a separate operator-scoped agent + credit-line
// pair is created under the operator customer (same Provider + Tool).
const BRIDGE_PROVIDER_ID = "mcp-bridge-demo-provider-001";
const BRIDGE_PROVIDER_NAME = "MCP Bridge Demo Tools";
const BRIDGE_AGENT_ID = "mcp-bridge-demo-agent-001";
const BRIDGE_AGENT_LABEL = "mcp-bridge-demo-agent";
const BRIDGE_CL_ID = "mcp-bridge-demo-cl-001";
const OPERATOR_BRIDGE_AGENT_ID = "operator-bridge-demo-agent-001";
const OPERATOR_BRIDGE_AGENT_LABEL = "operator-bridge-demo-agent";
const OPERATOR_BRIDGE_CL_ID = "operator-bridge-demo-cl-001";
const BRIDGE_CL_LIMIT = BigInt("100000000000"); // 100 credits — many runs fit.
const BRIDGE_TOOLS = [
  // Tool name MUST match the local receipt's `tool` field exactly.
  { id: "mcp-bridge-demo-tool-echo-001",   name: "budgeted_echo",   cost: BigInt("50000000") /* 0.05 cr */ },
  { id: "mcp-bridge-demo-tool-getsum-001", name: "budgeted_get_sum", cost: BigInt("50000000") },
];

// Where the local CLI writes Work Receipts by default.
const DEFAULT_RECEIPTS_PATH = path.join(os.homedir(), ".agent-tab", "receipts.jsonl");
const DEFAULT_BASE_URL = process.env.AGENT_TAB_BASE_URL ?? "http://localhost:3000";

// ─── CLI flags ──────────────────────────────────────────────────────────

interface Args {
  receiptsPath: string;
  receiptId: string | undefined;
  baseUrl: string;
  dryRun: boolean;
  reserveManifestPath: string | undefined;  // 16c: operator-mode manifest path; undefined = demo mode
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    receiptsPath: DEFAULT_RECEIPTS_PATH,
    receiptId: undefined,
    baseUrl: DEFAULT_BASE_URL,
    dryRun: false,
    reserveManifestPath: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--receipts-path") a.receiptsPath = argv[++i] ?? a.receiptsPath;
    else if (arg === "--receipt-id") a.receiptId = argv[++i];
    else if (arg === "--base-url") a.baseUrl = argv[++i] ?? a.baseUrl;
    else if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--reserve-manifest") a.reserveManifestPath = argv[++i];
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return a;
}

const HELP = `\
receipt-to-settlement-demo (slice 15a + 16c) — one local MCP Work Receipt → settlement

Usage:
  npx tsx scripts/receipt-to-settlement-demo.ts [flags]

Modes:
  Default (no --reserve-manifest): 15a demo mode. Settles against the
    slice-13b dedicated demo reserve under Demo Debtor. Reads manifest
    at .demo-state/settlement-demo-reserve.json.
  Operator mode (--reserve-manifest <path>): 16c. Settles against an
    operator-owned reserve described by an operator-reserve-manifest
    (kind="operator-reserve-manifest"). The reserve must be at
    lifecycle="active"; otherwise the script stops with an instruction
    to submit the deploy tx + run operator-reserve-init.ts --sync.

Flags:
  --receipts-path <path>      default: ~/.agent-tab/receipts.jsonl
  --receipt-id <id>           which row to import; default = last outcome="success"
  --base-url <url>            default: $AGENT_TAB_BASE_URL or http://localhost:3000
  --reserve-manifest <path>   16c operator-mode manifest (explicit; no silent
                              preference). Must be of kind "operator-reserve-manifest".
  --dry-run                   preflight + ensure-fixture + receipt selection +
                              tool-name match. NO DB mutation. NO readiness audit.
                              Works in both demo and operator modes.
  --help, -h
`;

// ─── Logging ────────────────────────────────────────────────────────────

function info(stage: string, msg: string): void { console.log(`[15a] ${stage} ${msg}`); }
function ok(stage: string, msg: string): void { console.log(`[15a] ${stage} ✓ ${msg}`); }
function warn(stage: string, msg: string): void { console.error(`[15a] ${stage} ⚠ ${msg}`); }
function fail(stage: string, msg: string, code = 2): never {
  console.error(`[15a] ${stage} ✗ ${msg}`);
  process.exit(code);
}

// ─── Manifest helpers (copied from 13c pattern; extended in 16c) ────────

// Legacy 15a/13b demo manifest (no `kind` field).
interface LegacyDemoManifest {
  reserveId: string;
  reserveTokenId: string;
  trackerNftId: string;
  customerId: string;
  initialCollateralNanoErg: string;
  preparedAt: string;
  syncedAt?: string;
  deploySpecPath?: string;
  note?: string;
}

// 16a-core operator manifest (kind="operator-reserve-manifest").
interface OperatorReserveManifest {
  kind: "operator-reserve-manifest";
  version: string;
  reserveId: string;
  reserveTokenId: string;
  trackerNftId: string;
  operatorCustomerId: string;
  operatorPublicKey: string;
  reserveAddress: string;
  network: string;
  lifecycle: string;
  initialCollateralNanoErg: string;
  preparedAt: string;
  syncedAt: string | null;
  proofOfControl?: unknown;
  deploySpecPath?: string;
  note?: string;
}

type Manifest = LegacyDemoManifest | OperatorReserveManifest;

function readManifestAt(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function isOperatorManifest(m: unknown): m is OperatorReserveManifest {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as Record<string, unknown>).kind === "operator-reserve-manifest"
  );
}

function isLegacyDemoManifest(m: unknown): m is LegacyDemoManifest {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.reserveId === "string" &&
    typeof o.reserveTokenId === "string" &&
    typeof o.trackerNftId === "string" &&
    typeof o.customerId === "string" &&
    o.kind === undefined
  );
}

function isCanonical(m: Manifest): { hit: boolean; field?: string } {
  if (m.reserveId === CANONICAL_RESERVE_ID) return { hit: true, field: "reserveId" };
  if (m.reserveTokenId === CANONICAL_RESERVE_TOKEN_ID) return { hit: true, field: "reserveTokenId" };
  if (m.trackerNftId === CANONICAL_TRACKER_NFT_ID) return { hit: true, field: "trackerNftId" };
  return { hit: false };
}

// ─── Receipt parsing ────────────────────────────────────────────────────

interface ReceiptRow {
  id: string;
  timestamp: string;
  tabId?: string;
  tool: string;
  upstreamTool?: string;
  amountCharged: string;
  outcome: "success" | "denied" | "error" | string;
  previousAmount?: string;
  newAmount?: string;
  reason?: string;
  error?: string;
}

function readReceipts(p: string): ReceiptRow[] {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8");
  const out: ReceiptRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ReceiptRow); } catch { /* skip */ }
  }
  return out;
}

function pickReceipt(rows: ReceiptRow[], explicitId: string | undefined): ReceiptRow {
  if (explicitId) {
    const r = rows.find((row) => row.id === explicitId);
    if (!r) fail("Stage 2", `receipt id ${explicitId} not found in receipts file`);
    return r;
  }
  const successes = rows.filter((row) => row.outcome === "success");
  if (successes.length === 0) {
    fail("Stage 2", `no rows with outcome="success" in receipts file`);
  }
  return successes[successes.length - 1];
}

// ─── Bridge fixture (idempotent ensure) ─────────────────────────────────

async function ensureBridgeProvider(): Promise<{ id: string; publicKey: string }> {
  const existing = await prisma.provider.findUnique({
    where: { id: BRIDGE_PROVIDER_ID },
    select: { id: true, status: true, publicKey: true },
  });
  if (existing) {
    if (existing.status !== "active") {
      await prisma.provider.update({
        where: { id: BRIDGE_PROVIDER_ID },
        data: { status: "active" },
      });
    }
    return { id: existing.id, publicKey: existing.publicKey };
  }
  const keys = generateKeypair();
  const created = await prisma.provider.create({
    data: {
      id: BRIDGE_PROVIDER_ID,
      name: BRIDGE_PROVIDER_NAME,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    },
    select: { id: true, publicKey: true },
  });
  return created;
}

async function ensureBridgeTool(toolId: string, toolName: string, cost: bigint): Promise<{ id: string; name: string }> {
  const existing = await prisma.tool.findUnique({
    where: { id: toolId },
    select: { id: true, providerId: true, name: true, costPerCall: true, status: true },
  });
  if (existing) {
    if (existing.providerId !== BRIDGE_PROVIDER_ID) {
      throw new Error(`Tool ${toolId} has wrong providerId: expected ${BRIDGE_PROVIDER_ID}, got ${existing.providerId}`);
    }
    await prisma.tool.update({
      where: { id: toolId },
      data: { name: toolName, costPerCall: cost, status: "active" },
    });
    return { id: existing.id, name: toolName };
  }
  const created = await prisma.tool.create({
    data: {
      id: toolId,
      providerId: BRIDGE_PROVIDER_ID,
      name: toolName,
      description: `15a bridge wrapper for upstream MCP tool (mirrors local ${toolName}).`,
      endpoint: "local-mcp-bridge://noop",
      costPerCall: cost,
      status: "active",
    },
    select: { id: true, name: true },
  });
  return created;
}

async function ensureBridgeAgent(customerId: string): Promise<{ id: string }> {
  const existing = await prisma.agentIdentity.findUnique({
    where: { id: BRIDGE_AGENT_ID },
    select: { id: true, status: true, customerId: true },
  });
  if (existing) {
    if (existing.customerId !== customerId) {
      throw new Error(`AgentIdentity ${BRIDGE_AGENT_ID} customerId mismatch`);
    }
    if (existing.status !== "active") {
      await prisma.agentIdentity.update({ where: { id: BRIDGE_AGENT_ID }, data: { status: "active" } });
    }
    return { id: existing.id };
  }
  // No raw API key needed — script bypasses /api/proxy. Use a deterministic
  // hash placeholder + obvious preview so it can't be confused with a live
  // agent key.
  const created = await prisma.agentIdentity.create({
    data: {
      id: BRIDGE_AGENT_ID,
      customerId,
      label: BRIDGE_AGENT_LABEL,
      apiKeyHash: `bridge-15a-no-proxy-key-${BRIDGE_AGENT_ID}`,
      apiKeyPreview: "(15a bridge — no key)",
      allowedToolIds: "*",
    },
    select: { id: true },
  });
  return created;
}

async function ensureBridgeCreditLine(providerId: string, customerId: string): Promise<{ id: string }> {
  const existing = await prisma.creditLine.findFirst({
    where: { providerId, customerId },
    select: { id: true, status: true, limitAmount: true },
  });
  if (existing) {
    if (existing.status !== "active" || existing.limitAmount < BRIDGE_CL_LIMIT) {
      await prisma.creditLine.update({
        where: { id: existing.id },
        data: { status: "active", limitAmount: BRIDGE_CL_LIMIT },
      });
    }
    return { id: existing.id };
  }
  const created = await prisma.creditLine.create({
    data: {
      id: BRIDGE_CL_ID,
      providerId,
      customerId,
      limitAmount: BRIDGE_CL_LIMIT,
    },
    select: { id: true },
  });
  return created;
}

// 16c: operator-scoped agent + credit-line under the operator customer.
// Distinct id/label from BRIDGE_* so it can coexist with the demo lane.
async function ensureOperatorBridgeAgent(customerId: string): Promise<{ id: string }> {
  const existing = await prisma.agentIdentity.findUnique({
    where: { id: OPERATOR_BRIDGE_AGENT_ID },
    select: { id: true, status: true, customerId: true },
  });
  if (existing) {
    if (existing.customerId !== customerId) {
      throw new Error(
        `AgentIdentity ${OPERATOR_BRIDGE_AGENT_ID} customerId mismatch: ` +
        `expected ${customerId}, got ${existing.customerId}`,
      );
    }
    if (existing.status !== "active") {
      await prisma.agentIdentity.update({ where: { id: OPERATOR_BRIDGE_AGENT_ID }, data: { status: "active" } });
    }
    return { id: existing.id };
  }
  const created = await prisma.agentIdentity.create({
    data: {
      id: OPERATOR_BRIDGE_AGENT_ID,
      customerId,
      label: OPERATOR_BRIDGE_AGENT_LABEL,
      apiKeyHash: `operator-bridge-16c-no-proxy-key-${OPERATOR_BRIDGE_AGENT_ID}`,
      apiKeyPreview: "(16c operator bridge — no key)",
      allowedToolIds: "*",
    },
    select: { id: true },
  });
  return created;
}

async function ensureOperatorBridgeCreditLine(providerId: string, customerId: string): Promise<{ id: string }> {
  const existing = await prisma.creditLine.findFirst({
    where: { providerId, customerId },
    select: { id: true, status: true, limitAmount: true },
  });
  if (existing) {
    if (existing.status !== "active" || existing.limitAmount < BRIDGE_CL_LIMIT) {
      await prisma.creditLine.update({
        where: { id: existing.id },
        data: { status: "active", limitAmount: BRIDGE_CL_LIMIT },
      });
    }
    return { id: existing.id };
  }
  const created = await prisma.creditLine.create({
    data: {
      id: OPERATOR_BRIDGE_CL_ID,
      providerId,
      customerId,
      limitAmount: BRIDGE_CL_LIMIT,
    },
    select: { id: true },
  });
  return created;
}

// ─── Subprocess + HTTP helpers ──────────────────────────────────────────

function runReadinessAuditSync(reserveId: string, obligationStateId: string): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(
    "npx",
    ["tsx", path.join(__dirname, "check-settlement-readiness.ts"),
      "--reserve-id", reserveId,
      "--obligation-state-id", obligationStateId,
      "--json"],
    { cwd: path.join(__dirname, ".."), encoding: "utf-8", env: process.env },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? -1,
  };
}

interface AuditCheck { id: number; label: string; status: "pass" | "fail" | "skip"; detail?: string }
interface AuditReport { checks: AuditCheck[]; blockingReasons: string[]; nextStep: string }

function parseAuditReport(stdout: string): AuditReport | null {
  try { return JSON.parse(stdout) as AuditReport; } catch { return null; }
}

// 15a-specific gate: warn-and-proceed iff every failing check id is in
// {13, 18}. Both are auto-resolvable by /api/reserves/redeem on first
// redemption. Any other failure → hard abort.
const AUTO_RESOLVABLE_FAIL_IDS = new Set<number>([13, 18]);
function classifyAudit(report: AuditReport): { proceed: boolean; failedIds: number[]; nonResolvable: number[] } {
  const failedIds = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
  const nonResolvable = failedIds.filter((id) => !AUTO_RESOLVABLE_FAIL_IDS.has(id));
  return {
    proceed: failedIds.length > 0 && nonResolvable.length === 0,
    failedIds,
    nonResolvable,
  };
}

interface RedeemOutcome { status: number; body: unknown; }

async function postRedeem(baseUrl: string, reserveId: string, obligationId: string, cookie: string): Promise<RedeemOutcome> {
  const res = await fetch(`${baseUrl}/api/reserves/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ reserveId, obligationId }),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function getBaseUrl(baseUrl: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(baseUrl, { method: "GET", signal: ctrl.signal });
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(args: Args): Promise<void> {
  if (args.help) { console.log(HELP); return; }

  // ─── STAGE 0 — PREFLIGHT ───
  info("Stage 0", "preflight starting…");

  // 0a. Server reachable.
  const reach = await getBaseUrl(args.baseUrl);
  if (!reach.ok) {
    fail(
      "Stage 0",
      `Next.js dev server is not reachable at ${args.baseUrl} (${reach.error ?? `HTTP ${reach.status}`}). ` +
        `Start it with: cd agent-tab && DEMO_MODE=true npx next dev -p 3000`,
    );
  }
  ok("Stage 0", `HTTP reachable (${args.baseUrl} → ${reach.status})`);

  // 0b. Operator cookie mints.
  let cookie: string;
  try {
    cookie = await operatorCookieHeader(prisma);
  } catch (e) {
    fail("Stage 0", `failed to mint operator cookie: ${(e as Error).message}`);
  }
  if (!cookie || !cookie.includes("session-token=")) {
    fail("Stage 0", `operator cookie minted empty or malformed`);
  }
  ok("Stage 0", "operator cookie minted");

  // 0c. Mode detection + customer/reserve resolution.
  //
  //   Default (no --reserve-manifest): demo mode under Demo Debtor with
  //   the slice-13b demo reserve. Existing 15a behavior.
  //
  //   Operator (--reserve-manifest <path>): 16c. Manifest must be
  //   kind="operator-reserve-manifest" with lifecycle="active".
  //   Reserve is operator-owned; tracker may be reused from 15a (a
  //   deliberate 16c scope choice — independent operator tracker is
  //   deferred to a later slice).
  const mode: "demo" | "operator" = args.reserveManifestPath ? "operator" : "demo";
  ok("Stage 0", `mode=${mode}${mode === "operator" ? ` (manifest=${args.reserveManifestPath})` : ""}`);

  let customer: { id: string; signingMode: string; publicKey: string; privateKey: string | null };
  let targetReserve: { id: string; lifecycle: string; valueNanoErg: bigint; customerId: string; reserveTokenId: string; trackerNftId: string };
  let manifestForStage6: Manifest;
  let agentIdForUsage: string;
  let ensureAgent: (cid: string) => Promise<{ id: string }>;
  let ensureCreditLine: (pid: string, cid: string) => Promise<{ id: string }>;

  if (mode === "demo") {
    // 0c-demo. Demo Debtor exists with signingMode="tracker".
    const debtor = await prisma.customer.findFirst({
      where: { name: "Demo Debtor" },
      select: { id: true, signingMode: true, publicKey: true, privateKey: true },
    });
    if (!debtor) {
      fail(
        "Stage 0",
        "Demo Debtor not found. Run: npx tsx scripts/seed-debtor.ts (or any seeder that creates Demo Debtor)",
      );
    }
    if (debtor.signingMode !== "tracker") {
      fail("Stage 0", `Demo Debtor signingMode is ${JSON.stringify(debtor.signingMode)}, expected "tracker"`);
    }
    if (!debtor.privateKey || debtor.privateKey.length === 0) {
      fail("Stage 0", "Demo Debtor.privateKey missing — tracker-managed signing requires it");
    }
    ok("Stage 0", `Demo Debtor exists (id=${debtor.id.slice(0, 8)}…, signingMode=tracker)`);
    customer = debtor;

    // 0d-demo. Demo reserve manifest + canonical denylist.
    const raw = readManifestAt(MANIFEST_FILE);
    if (!raw) {
      fail(
        "Stage 0",
        `Missing demo reserve manifest at ${MANIFEST_FILE}. Run slice 13b first: ` +
          `cd agent-tab && npx tsx scripts/seed-settlement-demo-reserve.ts --prepare ` +
          `&& npx tsx scripts/seed-settlement-demo-reserve.ts --sync`,
      );
    }
    if (isOperatorManifest(raw)) {
      fail("Stage 0", `default demo path requires the LEGACY demo manifest at ${MANIFEST_FILE}, but found an operator-reserve-manifest. Either pass --reserve-manifest <operator-path> explicitly, or restore the demo manifest.`);
    }
    if (!isLegacyDemoManifest(raw)) {
      fail("Stage 0", `manifest at ${MANIFEST_FILE} does not match the expected legacy demo shape (reserveId/reserveTokenId/trackerNftId/customerId fields).`);
    }
    const m: LegacyDemoManifest = raw;
    const cd = isCanonical(m);
    if (cd.hit) {
      fail("Stage 0", `PANIC: manifest matches canonical reserve (${cd.field}). Refusing to proceed.`);
    }
    const demoReserve = await prisma.reserve.findUnique({
      where: { id: m.reserveId },
      select: { id: true, lifecycle: true, valueNanoErg: true, customerId: true, reserveTokenId: true, trackerNftId: true },
    });
    if (!demoReserve) {
      fail("Stage 0", `manifest references reserveId=${m.reserveId} but no Reserve row exists`);
    }
    if (demoReserve.lifecycle !== "active") {
      fail("Stage 0", `demo Reserve lifecycle is ${demoReserve.lifecycle}, expected "active"`);
    }
    ok("Stage 0", `demo reserve (id=${demoReserve.id.slice(0, 8)}…, value=${demoReserve.valueNanoErg} nanoERG, NOT canonical)`);
    targetReserve = demoReserve;
    manifestForStage6 = m;
    agentIdForUsage = BRIDGE_AGENT_ID;
    ensureAgent = ensureBridgeAgent;
    ensureCreditLine = ensureBridgeCreditLine;
  } else {
    // 0c-operator. Read explicit operator manifest.
    if (!args.reserveManifestPath) {
      fail("Stage 0", "internal: operator mode without --reserve-manifest path (unreachable)");
    }
    const raw = readManifestAt(args.reserveManifestPath);
    if (!raw) {
      fail("Stage 0", `--reserve-manifest path not found: ${args.reserveManifestPath}`);
    }
    if (isLegacyDemoManifest(raw)) {
      fail(
        "Stage 0",
        `--reserve-manifest expected an operator-reserve-manifest (kind="operator-reserve-manifest") but got a legacy demo manifest at ${args.reserveManifestPath}. Refusing — operator mode requires explicit operator manifest.`,
      );
    }
    if (!isOperatorManifest(raw)) {
      fail(
        "Stage 0",
        `--reserve-manifest contents are not an operator-reserve-manifest at ${args.reserveManifestPath}. Expected kind="operator-reserve-manifest"; got ${JSON.stringify((raw as Record<string, unknown>).kind ?? "<missing>")}.`,
      );
    }
    const opM: OperatorReserveManifest = raw;
    const cd = isCanonical(opM);
    if (cd.hit) {
      fail("Stage 0", `PANIC: operator manifest matches canonical reserve (${cd.field}). Refusing to proceed.`);
    }
    // Lifecycle pre-check (refuse if not active; resumable instruction).
    if (opM.lifecycle !== "active") {
      const reserveIdShort = opM.reserveId.slice(0, 8);
      console.error(
        `[15a] Stage 0 ✗ operator reserve ${reserveIdShort}… is at lifecycle="${opM.lifecycle}", not "active".\n` +
        `       To activate:\n` +
        `         1. ensure your wallet holds the singleton reserveToken;\n` +
        `         2. submit the deploy tx via your Ergo testnet wallet using\n` +
        `            ${opM.deploySpecPath ?? ".demo-state/operator-reserve-deploy.json"}'s\n` +
        `            deploymentRequestJson;\n` +
        `         3. run \`npx tsx scripts/operator-reserve-init.ts --sync\` until lifecycle=active;\n` +
        `         4. re-run this command.`,
      );
      process.exit(1);
    }
    // Operator Customer must exist.
    const opCustomer = await prisma.customer.findUnique({
      where: { id: opM.operatorCustomerId },
      select: { id: true, name: true, signingMode: true, publicKey: true, privateKey: true },
    });
    if (!opCustomer) {
      fail("Stage 0", `manifest.operatorCustomerId ${opM.operatorCustomerId} does not match any Customer row`);
    }
    if (opCustomer.signingMode !== "self-custody") {
      fail("Stage 0", `operator Customer signingMode is ${JSON.stringify(opCustomer.signingMode)}, expected "self-custody"`);
    }
    if (opCustomer.publicKey !== opM.operatorPublicKey) {
      fail("Stage 0", `operator Customer publicKey mismatches manifest operatorPublicKey`);
    }
    ok("Stage 0", `operator Customer "${opCustomer.name}" (id=${opCustomer.id.slice(0, 8)}…, signingMode=self-custody)`);
    customer = opCustomer;

    // Operator Reserve must exist + be active.
    const opReserve = await prisma.reserve.findUnique({
      where: { id: opM.reserveId },
      select: { id: true, lifecycle: true, valueNanoErg: true, customerId: true, reserveTokenId: true, trackerNftId: true },
    });
    if (!opReserve) {
      fail("Stage 0", `manifest.reserveId ${opM.reserveId} not found in DB`);
    }
    if (opReserve.lifecycle !== "active") {
      fail("Stage 0", `operator Reserve DB row lifecycle=${opReserve.lifecycle}; manifest claims active but DB disagrees`);
    }
    if (opReserve.customerId !== opCustomer.id) {
      fail("Stage 0", `operator Reserve.customerId ${opReserve.customerId} does not match operator Customer ${opCustomer.id}`);
    }
    ok("Stage 0", `operator reserve (id=${opReserve.id.slice(0, 8)}…, value=${opReserve.valueNanoErg} nanoERG, NOT canonical)`);
    // Honest disclosure if the tracker is the 15a shared tracker.
    if (opReserve.trackerNftId === "b84289dd847e8a3a8dbdf02fc458e663a40d9ba082b19d273e27368d24f9131a") {
      info("Stage 0", `note: operator reserve trusts the 15a shared testnet tracker (b84289dd…). 16c scope reuses this tracker; independent operator tracker is deferred.`);
    }
    targetReserve = opReserve;
    manifestForStage6 = opM;
    agentIdForUsage = OPERATOR_BRIDGE_AGENT_ID;
    ensureAgent = ensureOperatorBridgeAgent;
    ensureCreditLine = ensureOperatorBridgeCreditLine;

    // 16c: in operator mode the Customer.privateKey is empty (self-custody),
    // so the redeem route's ensureSecretFile() cannot auto-provision the
    // sidecar's owner secret file. Provision it here from
    // .demo-state/operator-key.json (mode 0o600 on disk; same format
    // ~/.chaincash-secrets/owner-<hex8>.json expects). Idempotent: only
    // writes if missing; refuses to overwrite a mismatching file.
    if (!args.dryRun) {
      const opKeyPath = path.join(DEMO_STATE_DIR, "operator-key.json");
      if (!fs.existsSync(opKeyPath)) {
        fail("Stage 0", `operator-key.json missing at ${opKeyPath}; cannot provision sidecar secret file`);
      }
      const opKey = JSON.parse(fs.readFileSync(opKeyPath, "utf-8")) as { publicKey: string; privateKey: string };
      const secretsDir = path.join(os.homedir(), ".chaincash-secrets");
      const ownerFile = path.join(secretsDir, `owner-${opKey.publicKey.substring(0, 8)}.json`);
      if (fs.existsSync(ownerFile)) {
        const existing = JSON.parse(fs.readFileSync(ownerFile, "utf-8")) as { pubKeyHex?: string; secretHex?: string };
        if (existing.pubKeyHex && existing.pubKeyHex !== opKey.publicKey) {
          fail("Stage 0", `sidecar secret file ${ownerFile} exists with mismatching pubKeyHex; refusing to overwrite`);
        }
        ok("Stage 0", `sidecar owner secret file present (${ownerFile.replace(os.homedir(), "~")})`);
      } else {
        if (!fs.existsSync(secretsDir)) fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(ownerFile, JSON.stringify({ pubKeyHex: opKey.publicKey, secretHex: opKey.privateKey }, null, 2), { mode: 0o600 });
        ok("Stage 0", `sidecar owner secret file provisioned (${ownerFile.replace(os.homedir(), "~")}, mode 0o600)`);
      }
    }
  }

  // ─── STAGE 1 — BRIDGE FIXTURE ───
  // In dry-run: peek at existing rows; do NOT ensure (no DB mutation).
  // In real run: idempotent find-or-create.
  let provider: { id: string; publicKey: string };
  if (args.dryRun) {
    info("Stage 1", "checking MCP Bridge fixture (peek only, no mutation)…");
    const existingProvider = await prisma.provider.findUnique({
      where: { id: BRIDGE_PROVIDER_ID },
      select: { id: true, publicKey: true, status: true },
    });
    const existingToolNames = await prisma.tool.findMany({
      where: { providerId: BRIDGE_PROVIDER_ID, status: "active" },
      select: { name: true },
    }).then((rows) => rows.map((r) => r.name));
    if (existingProvider) {
      provider = { id: existingProvider.id, publicKey: existingProvider.publicKey };
      ok("Stage 1", `bridge provider exists (active=${existingProvider.status === "active"}, tools=[${existingToolNames.join(", ")}])`);
    } else {
      // Use a placeholder so dry-run can still report intended mapping.
      provider = { id: BRIDGE_PROVIDER_ID, publicKey: "<would-be-generated-on-real-run>" };
      info("Stage 1", `bridge fixture not yet created. Real run would create:`);
      console.log(`  Provider:      ${BRIDGE_PROVIDER_ID} (${BRIDGE_PROVIDER_NAME})`);
      for (const t of BRIDGE_TOOLS) {
        console.log(`  Tool:          ${t.id} name="${t.name}" cost=${t.cost.toString()}`);
      }
      console.log(`  AgentIdentity: ${BRIDGE_AGENT_ID} (${BRIDGE_AGENT_LABEL})`);
      console.log(`  CreditLine:    ${BRIDGE_CL_ID} limit=${BRIDGE_CL_LIMIT.toString()}`);
    }
  } else {
    info("Stage 1", `ensuring MCP Bridge fixture (idempotent, ${mode} mode)…`);
    provider = await ensureBridgeProvider();
    for (const t of BRIDGE_TOOLS) {
      await ensureBridgeTool(t.id, t.name, t.cost);
    }
    await ensureAgent(customer.id);
    await ensureCreditLine(provider.id, customer.id);
    const agentLabelForLog = mode === "operator" ? OPERATOR_BRIDGE_AGENT_LABEL : BRIDGE_AGENT_LABEL;
    ok("Stage 1", `bridge fixture: provider=${BRIDGE_PROVIDER_NAME}, tools=[${BRIDGE_TOOLS.map((t) => t.name).join(", ")}], agent=${agentLabelForLog}`);
  }

  // ─── STAGE 2 — RECEIPT SELECTION + TOOL MATCH ───
  info("Stage 2", `reading receipts from ${args.receiptsPath}…`);
  if (!fs.existsSync(args.receiptsPath)) {
    fail(
      "Stage 2",
      `receipts file not found at ${args.receiptsPath}. ` +
        `Generate one by running the local MCP proxy with a budgeted_echo call: ` +
        `cd packages/cli && npx agent-tab init && npx agent-tab proxy.`,
    );
  }
  const rows = readReceipts(args.receiptsPath);
  if (rows.length === 0) {
    fail("Stage 2", `receipts file is empty`);
  }
  const receipt = pickReceipt(rows, args.receiptId);
  if (receipt.outcome !== "success") {
    fail("Stage 2", `receipt outcome=${JSON.stringify(receipt.outcome)} — only success rows can be imported`);
  }
  ok("Stage 2", `selected receipt id=${receipt.id} tool=${receipt.tool} outcome=success amount=${receipt.amountCharged}`);

  // Tool name match (honest 1:1). In dry-run with no fixture yet, fall back
  // to the in-memory BRIDGE_TOOLS list so the preview is still meaningful.
  let matchedTool: { id: string; name: string; costPerCall: bigint } | null = await prisma.tool.findFirst({
    where: { providerId: provider.id, name: receipt.tool, status: "active" },
    select: { id: true, name: true, costPerCall: true },
  });
  if (!matchedTool && args.dryRun) {
    const inMem = BRIDGE_TOOLS.find((t) => t.name === receipt.tool);
    if (inMem) matchedTool = { id: inMem.id, name: inMem.name, costPerCall: inMem.cost };
  }
  if (!matchedTool) {
    fail(
      "Stage 2",
      `no backend Tool named ${JSON.stringify(receipt.tool)} under "${BRIDGE_PROVIDER_NAME}" — ` +
        `refusing to bridge to a non-matching fixture. ` +
        `Bridge fixture exposes: ${BRIDGE_TOOLS.map((t) => t.name).join(", ")}.`,
    );
  }
  ok("Stage 2", `tool name match (Tool: ${matchedTool.name} / ${BRIDGE_PROVIDER_NAME})`);

  if (args.dryRun) {
    info("DRY RUN", `would import the following (${mode} mode):`);
    console.log(JSON.stringify({
      mode,
      receipt: { id: receipt.id, tool: receipt.tool, amount: receipt.amountCharged },
      mapping: {
        customerId: customer.id,
        providerId: provider.id,
        agentIdentityId: agentIdForUsage,
        toolId: matchedTool.id,
      },
      reserve: { id: targetReserve.id, valueNanoErg: targetReserve.valueNanoErg.toString() },
    }, null, 2));
    info("DRY RUN", "skipped: bridge fixture ensure (peek only)");
    info("DRY RUN", "skipped: readiness audit (no obligation state to audit before import)");
    info("DRY RUN", "skipped: import / redeem / verify");
    info("DRY RUN", "no DB rows created in this run.");
    return;
  }

  // ─── STAGE 3 — IMPORT (sequential, non-atomic) ───
  // Resume-aware dedupe:
  //   (a) UsageEvent.requestRef MISSING                                  → normal import
  //   (b) UsageEvent.requestRef EXISTS + currentAmount > 0               → resume settlement
  //   (c) UsageEvent.requestRef EXISTS + currentAmount == 0 + completed
  //       SettlementEvent exists                                         → resume-verify (Stage 6 + exit 0)
  //   (d) UsageEvent.requestRef EXISTS + currentAmount == 0 + no
  //       SettlementEvent                                                → DB inconsistency, fail
  info("Stage 3", "importing receipt → ObligationUpdate + UsageEvent…");

  const dup = await prisma.usageEvent.findFirst({
    where: { requestRef: receipt.id },
    select: { id: true, timestamp: true },
  });
  const liveOb = await prisma.obligationState.findUnique({
    where: { providerId_customerId: { providerId: provider.id, customerId: customer.id } },
    select: { id: true, version: true, currentAmount: true, pendingAmount: true, settlementStatus: true, latestSignature: true },
  });

  let bridgeObligationId: string;
  let usageEventId: string;
  let importedDelta: bigint;
  // 16c: SettlementEvent.reserveId is `string | null` in the Prisma schema;
  // the prior type narrowed it incorrectly to `string`. Fixed here.
  let priorSettlement:
    | { id: string; status: string; amount: bigint; reserveId: string | null; redemptionTxId: string | null }
    | null = null;

  if (dup && liveOb && liveOb.currentAmount > BigInt(0)) {
    // Resume case (b): previous partial run; obligation still outstanding.
    info(
      "Stage 3",
      `receipt already imported; resuming settlement for outstanding bridge obligation`,
    );
    ok("Stage 3", `existing UsageEvent ${dup.id} (imported ${dup.timestamp.toISOString()})`);
    ok("Stage 3", `existing ObligationState ${liveOb.id} v=${liveOb.version} currentAmount=${liveOb.currentAmount}`);
    bridgeObligationId = liveOb.id;
    usageEventId = dup.id;
    importedDelta = liveOb.currentAmount;
  } else if (dup && liveOb) {
    // currentAmount == 0 — receipt was imported AND obligation was already
    // settled, OR DB is inconsistent. Look up the SettlementEvent.
    priorSettlement = await prisma.settlementEvent.findFirst({
      where: { obligationStateId: liveOb.id, status: "completed" },
      orderBy: { timestamp: "desc" },
      select: { id: true, status: true, amount: true, reserveId: true, redemptionTxId: true },
    });
    if (!priorSettlement) {
      // Case (d): inconsistency — UsageEvent exists, obligation drained, no SettlementEvent.
      fail(
        "Stage 3",
        `already imported but no completed SettlementEvent found and currentAmount=0. ` +
          `UsageEvent ${dup.id} from ${dup.timestamp.toISOString()}; ` +
          `ObligationState.id=${liveOb.id} settlementStatus=${liveOb.settlementStatus}. ` +
          `DB inconsistency — manual inspection required.`,
      );
    }
    // Case (c): resume-verify path. Run Stage 6 verification against the existing
    // SettlementEvent and exit 0 without touching tracker, audit, or redeem.
    info(
      "Stage 3",
      `receipt already imported and settled; verifying completed settlement`,
    );
    ok("Stage 3", `existing UsageEvent ${dup.id} (imported ${dup.timestamp.toISOString()})`);
    ok("Stage 3", `existing ObligationState ${liveOb.id} v=${liveOb.version} currentAmount=0 settlementStatus=${liveOb.settlementStatus}`);
    ok("Stage 3", `existing SettlementEvent ${priorSettlement.id} status=${priorSettlement.status} txId=${priorSettlement.redemptionTxId?.slice(0, 16) ?? "?"}…`);
    bridgeObligationId = liveOb.id;
    usageEventId = dup.id;
    importedDelta = priorSettlement.amount;
  } else {
    ok("Stage 3a", `dedupe pre-check: requestRef=${receipt.id} not yet imported`);

    // 3b. Resolve signing key. In demo mode the tracker-managed
    // Demo Debtor private key lives in customer.privateKey. In operator
    // (self-custody) mode the privateKey field is empty by convention; we
    // read the operator's key from .demo-state/operator-key.json (the same
    // file 16a-core wrote, mode 0o600).
    let signingPrivateKey: string;
    if (mode === "operator") {
      const opKeyPath = path.join(DEMO_STATE_DIR, "operator-key.json");
      if (!fs.existsSync(opKeyPath)) {
        fail("Stage 3b", `operator mode requires ${opKeyPath} (16a-core key file). Not found.`);
      }
      const opKey = JSON.parse(fs.readFileSync(opKeyPath, "utf-8")) as { publicKey: string; privateKey: string };
      if (!opKey.privateKey || !/^[0-9a-f]{64}$/.test(opKey.privateKey)) {
        fail("Stage 3b", `operator-key.json has invalid or missing privateKey (expected 64-char hex)`);
      }
      if (opKey.publicKey !== customer.publicKey) {
        fail("Stage 3b", `operator-key.json publicKey does not match operator Customer publicKey`);
      }
      signingPrivateKey = opKey.privateKey;
    } else {
      if (!customer.privateKey) {
        fail("Stage 3b", `tracker-managed customer privateKey missing (unreachable in demo mode after Stage 0 check)`);
      }
      signingPrivateKey = customer.privateKey;
    }

    // 3b. tracker.proposeNoteUpdate.
    const expectedVersion = liveOb?.version ?? 0;
    let trackerOut;
    try {
      trackerOut = await tracker.proposeNoteUpdate(
        {
          debtorPubKey: customer.publicKey,
          creditorPubKey: provider.publicKey,
          delta: BigInt(receipt.amountCharged),
          expectedVersion,
          requestId: receipt.id,
          agentIdentityId: agentIdForUsage,
          customerId: customer.id,
          toolId: matchedTool.id,
          toolName: matchedTool.name,
          providerId: provider.id,
          providerName: BRIDGE_PROVIDER_NAME,
        },
        signingPrivateKey,
      );
    } catch (e) {
      if (e instanceof TrackerError) {
        fail("Stage 3b", `tracker rejected: ${e.message} (code=${e.code})`);
      }
      throw e;
    }
    ok("Stage 3b", `tracker.proposeNoteUpdate (ObligationUpdate ${trackerOut.updateId}, ObligationState v=${trackerOut.version})`);

    // Patch newly-created ObligationState with customerId/providerId, mirroring /api/proxy:130–135.
    if (!liveOb) {
      await prisma.obligationState.update({
        where: { id: trackerOut.noteId },
        data: { customerId: customer.id, providerId: provider.id },
      });
    }

    // 3c. UsageEvent.create.
    let usageEvent;
    try {
      usageEvent = await prisma.usageEvent.create({
        data: {
          agentIdentityId: agentIdForUsage,
          toolId: matchedTool.id,
          providerId: provider.id,
          customerId: customer.id,
          amountCharged: BigInt(receipt.amountCharged),
          outcome: "success",
          requestRef: receipt.id,
          timestamp: new Date(receipt.timestamp),
        },
        select: { id: true, timestamp: true },
      });
    } catch (e) {
      fail(
        "Stage 3c",
        `PARTIAL STATE: ObligationUpdate ${trackerOut.updateId} created at version ${trackerOut.version}; ` +
          `UsageEvent insert failed: ${(e as Error).message}. ` +
          `Manual inspection required: the obligation has been advanced; you can either insert ` +
          `the UsageEvent manually or roll back the ObligationUpdate via DB intervention. ` +
          `Settlement was NOT attempted.`,
      );
    }
    ok("Stage 3c", `prisma.usageEvent.create (UsageEvent ${usageEvent.id}, requestRef=${receipt.id})`);

    bridgeObligationId = trackerOut.noteId;
    usageEventId = usageEvent.id;
    importedDelta = BigInt(receipt.amountCharged);
  }

  // ─── STAGE 4 — READINESS AUDIT (warn-and-proceed for {#13, #18}) ───
  // Skipped on resume-verify (case c): no audit needed since the obligation
  // is already settled and the SettlementEvent is present.
  if (priorSettlement) {
    info("Stage 4", "skipped (resume-verify: already settled)");
  } else {
  info("Stage 4", "running settlement-readiness audit…");
  const audit = runReadinessAuditSync(targetReserve.id, bridgeObligationId);
  const report = parseAuditReport(audit.stdout);
  if (!report) {
    console.error(audit.stdout);
    console.error(audit.stderr);
    fail("Stage 4", `readiness audit produced unparseable output (exit ${audit.code})`);
  }
  if (audit.code === 0) {
    ok("Stage 4", "readiness audit passed");
  } else {
    const cls = classifyAudit(report);
    if (!cls.proceed) {
      console.error(audit.stderr);
      fail(
        "Stage 4",
        `readiness audit FAILED with non-auto-resolvable blocker(s): ids=[${cls.nonResolvable.join(", ")}]. ` +
          `Auto-resolvable subset is exactly {13, 18}. Aborting before redeem.`,
      );
    }
    // Pre-condition for relying on #18 auto-provisioning: Provider.privateKey must be present.
    if (cls.failedIds.includes(18)) {
      const providerRow = await prisma.provider.findUnique({
        where: { id: BRIDGE_PROVIDER_ID },
        select: { privateKey: true },
      });
      if (!providerRow || !providerRow.privateKey || providerRow.privateKey.length === 0) {
        fail(
          "Stage 4",
          `audit blocker #18 (receiver secret missing) is normally auto-resolvable, but ` +
            `Provider.privateKey for "${BRIDGE_PROVIDER_NAME}" is empty — redeem cannot ` +
            `auto-provision the receiver secret without it. Aborting before redeem.`,
        );
      }
    }
    warn(
      "Stage 4",
      `readiness audit FAILED with auto-resolvable blockers: ids=[${cls.failedIds.join(", ")}]. ` +
        `Proceeding — /api/reserves/redeem auto-deploys missing tracker entries (#13) and ` +
        `auto-provisions receiver secrets (#18) on first redemption.`,
    );
  }
  } // end !priorSettlement Stage-4 branch

  // ─── STAGE 5 — REDEEM (skipped on resume-verify) ───
  let redemptionTxId: string;
  let settlementEventId: string;
  if (priorSettlement) {
    info("Stage 5", "skipped (resume-verify: SettlementEvent already on file)");
    redemptionTxId = priorSettlement.redemptionTxId ?? "";
    settlementEventId = priorSettlement.id;
  } else {
    info("Stage 5", "POST /api/reserves/redeem…");
    const redeem = await postRedeem(args.baseUrl, targetReserve.id, bridgeObligationId, cookie);
    if (redeem.status !== 200) {
      console.error(JSON.stringify(redeem.body, null, 2));
      fail("Stage 5", `redeem returned HTTP ${redeem.status}`);
    }
    const redeemBody = redeem.body as {
      reconciled?: boolean;
      redemptionTxId?: string;
      txId?: string; // legacy fallback
      settlement?: { id?: string };
      settlementEventId?: string; // legacy fallback
      chainVerification?: Record<string, boolean>;
      phase?: string;
    };
    const txId = redeemBody.redemptionTxId ?? redeemBody.txId;
    const sId = redeemBody.settlement?.id ?? redeemBody.settlementEventId;
    if (!txId) {
      fail("Stage 5", `redeem succeeded HTTP 200 but no redemptionTxId in response: ${JSON.stringify(redeemBody)}`);
    }
    if (!sId) {
      fail("Stage 5", `redeem succeeded HTTP 200 but no settlement.id in response: ${JSON.stringify(redeemBody)}`);
    }
    const flags = redeemBody.chainVerification
      ? Object.entries(redeemBody.chainVerification).filter(([, v]) => v).map(([k]) => k).join(",")
      : "";
    ok(
      "Stage 5",
      `redeem (redemptionTxId=${txId.slice(0, 16)}…, SettlementEvent ${sId}, reconciled=${redeemBody.reconciled === true}` +
        (flags ? `, chainVerification=[${flags}]` : "") + `)`,
    );
    redemptionTxId = txId;
    settlementEventId = sId;
  }

  // ─── STAGE 6 — VERIFY ───
  info("Stage 6", "verifying chain…");

  const settlementEvent = await prisma.settlementEvent.findFirst({
    where: { id: settlementEventId, obligationStateId: bridgeObligationId },
    select: { id: true, status: true, amount: true, reserveId: true, redemptionTxId: true },
  });
  if (!settlementEvent) {
    fail("Stage 6a", `SettlementEvent not found for id=${settlementEventId} obligationStateId=${bridgeObligationId}`);
  }
  if (redemptionTxId && settlementEvent.redemptionTxId !== redemptionTxId) {
    fail("Stage 6a", `SettlementEvent.redemptionTxId mismatch: expected ${redemptionTxId}, got ${settlementEvent.redemptionTxId}`);
  }
  if (settlementEvent.reserveId !== targetReserve.id) {
    fail("Stage 6a", `SettlementEvent.reserveId mismatch: expected ${targetReserve.id}, got ${settlementEvent.reserveId}`);
  }
  if (settlementEvent.status !== "completed") {
    warn("Stage 6a", `SettlementEvent.status=${settlementEvent.status} (expected "completed")`);
  }
  ok("Stage 6a", `SettlementEvent ${settlementEvent.id} status=${settlementEvent.status} amount=${settlementEvent.amount}`);

  const reducedOb = await prisma.obligationState.findUnique({
    where: { id: bridgeObligationId },
    select: { currentAmount: true, settlementStatus: true, version: true },
  });
  if (!reducedOb) {
    fail("Stage 6b", `ObligationState ${bridgeObligationId} disappeared`);
  }
  ok("Stage 6b", `bridge ObligationState reduced (currentAmount=${reducedOb.currentAmount}, settlementStatus=${reducedOb.settlementStatus})`);

  // Post-redeem audit: previously-blocking #13 / #18 should now be resolved.
  info("Stage 6", "post-redeem readiness re-audit…");
  const postAudit = runReadinessAuditSync(targetReserve.id, bridgeObligationId);
  const postReport = parseAuditReport(postAudit.stdout);
  if (postReport) {
    const stillFailing = postReport.checks.filter((c) => c.status === "fail").map((c) => c.id);
    const stillAutoResolvable13 = stillFailing.includes(13);
    const stillAutoResolvable18 = stillFailing.includes(18);
    if (stillAutoResolvable13) {
      warn("Stage 6d", `audit #13 still failing post-redeem (tracker entry not yet observed)`);
    } else {
      ok("Stage 6d", "audit #13 resolved (tracker entry now exists for the bridge pair)");
    }
    if (stillAutoResolvable18) {
      warn("Stage 6d", `audit #18 still failing post-redeem (receiver secret not yet observed)`);
    } else {
      ok("Stage 6d", "audit #18 resolved (receiver secret file now present)");
    }
  } else {
    warn("Stage 6d", "post-redeem audit output unparseable (skipping verification)");
  }

  // Canonical reserve untouched.
  const canonical = await prisma.reserve.findUnique({
    where: { id: CANONICAL_RESERVE_ID },
    select: { reserveTokenId: true, trackerNftId: true, valueNanoErg: true, avlTreeDigest: true, lifecycle: true },
  });
  if (canonical) {
    if (canonical.reserveTokenId !== CANONICAL_RESERVE_TOKEN_ID) {
      fail("Stage 6c", `PANIC: canonical reserve.reserveTokenId mutated`);
    }
    if (canonical.trackerNftId !== CANONICAL_TRACKER_NFT_ID) {
      fail("Stage 6c", `PANIC: canonical reserve.trackerNftId mutated`);
    }
  }
  ok("Stage 6c", "canonical reserve untouched (denylist still rejects, ids stable)");

  console.log("");
  console.log(
    priorSettlement
      ? "[15a] OK — receipt already imported and settled; verified existing SettlementEvent."
      : "[15a] OK — receipt → obligation → settlement → reduced obligation in 1 command.",
  );
  console.log(JSON.stringify({
    receipt: { id: receipt.id, tool: receipt.tool, amount: receipt.amountCharged },
    importedDelta: importedDelta.toString(),
    obligationState: bridgeObligationId,
    usageEvent: usageEventId,
    settlementEvent: settlementEvent.id,
    redemptionTxId,
    reserveId: targetReserve.id,
    mode,
  }, null, 2));
}

main(parseArgs(process.argv.slice(2)))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[15a] fatal:", (e as Error).stack ?? (e as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
