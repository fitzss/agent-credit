#!/usr/bin/env tsx
/**
 * repo-lint-to-reserve-settlement-demo (slice 13c)
 *
 * Receipt-to-reserve settlement demo. Closes the loop on the whitepaper thesis
 * end-to-end on testnet:
 *   work → Work Receipt → obligation → settlement
 *
 * Wires together:
 *   - slice 12a.1 repo-lint Work Receipt fixture
 *   - slice 13a settlement readiness audit
 *   - slice 13b dedicated demo reserve (canonical reserve never touched)
 *   - existing /api/reserves/redeem orchestration (auto tracker deploy,
 *     auto receiver-secret provisioning, atomic reconciliation)
 *
 * Phases:
 *   --preflight     Group A — environment-only, read-only. Verifies
 *                   infrastructure + slice-13b reserve + secrets + canonical
 *                   row exists. Does NOT check repo-lint lane state because
 *                   --execute resets/reseeds the lane in Stage 2.
 *
 *   --execute       Full settlement demo. Stages:
 *                   0  Re-run Group A preflight (gate).
 *                   1  Snapshot canonical fields + DB row counts.
 *                   2  seed-repo-lint-demo --reset, then re-seed.
 *                   2b Group B post-seed lane validation.
 *                   3  /api/proxy → one Work Receipt.
 *                   4  Run 13a audit (expect tracker-entry-missing FAIL).
 *                   5  Defensive ID denylist before any settlement call.
 *                   6  POST /api/reserves/redeem.
 *                   7  Recovery loop if 202/207.
 *                   8  Verify settlement post-conditions.
 *                   9  Verify canonical reserve byte-for-byte unchanged
 *                      including updatedAt → exit 2 PANIC on mismatch.
 *                   10 Re-run 13a audit (expect Obligation.currentAmount=0
 *                      FAIL).
 *                   11 Print structured JSON + prove.sh recommendation.
 *
 *   --help, -h
 *
 * Exit codes: 0 PASS, 1 blocked / verification failure, 2 misuse /
 *             canonical denylist hit / canonical-mutation panic.
 *
 * NEVER changes prisma schema, chaincash, sidecar-client, reconcile,
 * the redeem route, validate.sh, or prove.sh. Operator must run
 * `bash agent-tab/scripts/prove.sh` after a successful --execute and
 * confirm 49/49. If it fails, STOP and report — do not patch validate.sh
 * without explicit approval.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { getReserveStatus, getSidecarHealth } from "@/lib/sidecar-client";
import { operatorCookieHeader } from "./lib/test-session";

// ─────────────────────────────────────────────────────────────────────────
// Constants — load-bearing IDs verified against existing seeders.
// ─────────────────────────────────────────────────────────────────────────

// Demo Debtor — the only customer this script will ever operate under.
// Verified against scripts/seed-settlement-demo-reserve.ts:45.
const DEMO_DEBTOR_CUSTOMER_ID = "86c0dc8d-506b-41d8-af24-27abe58499f7";

// Canonical reserve denylist. Any match against manifest input → exit 2 BEFORE
// any side effect. Verified against scripts/seed-settlement-demo-reserve.ts:49-51.
const CANONICAL_RESERVE_ID = "e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c";
const CANONICAL_RESERVE_TOKEN_ID = "2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937";
const CANONICAL_TRACKER_NFT_ID = "d234898d01d478db47ab2073e4e5289a414be79e0ecb8670a9f4fc44d8d70f5b";

// Repo-lint fixture IDs. Verified against scripts/seed-repo-lint-demo.ts:42-50.
const REPO_LINT_PROVIDER_ID = "mcp-demo-repo-tools-001";
const REPO_LINT_TOOL_ID = "mcp-demo-tool-repo-lint-001";
const REPO_LINT_AGENT_ID = "mcp-demo-repo-agent-001";
const REPO_LINT_CL_ID = "mcp-demo-repo-cl-001";

// Demo state files (gitignored at agent-tab/.gitignore).
const DEMO_STATE_DIR = path.join(__dirname, "..", ".demo-state");
const MANIFEST_FILE = path.join(DEMO_STATE_DIR, "settlement-demo-reserve.json");

// Default settlement amount: matches seed-repo-lint-demo.ts TOOL_COST + DEFAULT_LIMIT.
const SETTLEMENT_NANO_CREDITS = BigInt(100_000_000); // 0.10 credits

// App URL (matches dev server prove.sh / validate.sh expect).
const AGENT_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

// Snapshot files for execute mode.
const CANONICAL_BEFORE_FILE = "/tmp/13c-canonical-before.json";
const COUNTS_BEFORE_FILE = "/tmp/13c-counts-before.json";

// Recovery loop tunables.
const RECOVERY_WAIT_MS = 30_000;
const RECOVERY_MAX_RETRIES = 2;

// Sidecar/network sanity timeout for direct fetches.
const NET_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

interface Manifest {
  reserveId: string;
  reserveTokenId: string;
  trackerNftId: string;
  customerId: string;
  initialCollateralNanoErg: string;
  preparedAt: string;
  syncedAt: string | null;
  deploySpecPath: string;
  note: string;
}

type CheckStatus = "pass" | "fail" | "skip" | "warn";

interface Check {
  id: string;
  name: string;
  status: CheckStatus;
  detail?: string;
  data?: unknown;
}

interface Args {
  phase: "preflight" | "execute" | "help" | null;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: null };
  let phasesSeen = 0;
  for (const a of argv) {
    if (a === "--preflight") { args.phase = "preflight"; phasesSeen++; }
    else if (a === "--execute") { args.phase = "execute"; phasesSeen++; }
    else if (a === "--help" || a === "-h") { args.phase = "help"; }
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (phasesSeen > 1) {
    throw new Error("--preflight and --execute are mutually exclusive");
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(
    `repo-lint-to-reserve-settlement-demo (slice 13c)\n\n` +
    `End-to-end receipt-to-reserve settlement demo using the slice-13b\n` +
    `dedicated demo reserve. Canonical reserve e7f6f1c2 is never touched.\n\n` +
    `Usage:\n` +
    `  --preflight    Group A environment-only checks. Read-only. Idempotent.\n` +
    `  --execute      Full demo: reset repo-lint, create one Work Receipt,\n` +
    `                 redeem against the slice-13b demo reserve, verify.\n` +
    `  --help, -h     Show this help.\n\n` +
    `Exit codes: 0 PASS / 1 blocked / 2 misuse or canonical denylist panic.\n\n` +
    `After a successful --execute, run:\n` +
    `  bash agent-tab/scripts/prove.sh\n` +
    `and confirm 49/49. If not, STOP and report — do not patch validate.sh\n` +
    `without explicit approval.\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function readManifest(): Manifest | null {
  if (!fs.existsSync(MANIFEST_FILE)) return null;
  const raw = fs.readFileSync(MANIFEST_FILE, "utf-8");
  return JSON.parse(raw) as Manifest;
}

function isCanonical(m: Manifest): { hit: boolean; field?: string } {
  if (m.reserveId === CANONICAL_RESERVE_ID) return { hit: true, field: "reserveId" };
  if (m.reserveTokenId === CANONICAL_RESERVE_TOKEN_ID) return { hit: true, field: "reserveTokenId" };
  if (m.trackerNftId === CANONICAL_TRACKER_NFT_ID) return { hit: true, field: "trackerNftId" };
  return { hit: false };
}

function check(id: string, name: string, status: CheckStatus, detail?: string, data?: unknown): Check {
  return { id, name, status, detail, data };
}

function summarize(checks: Check[]): {
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  blockingReasons: string[];
} {
  const blockingReasons: string[] = [];
  let passed = 0, failed = 0, warned = 0, skipped = 0;
  for (const c of checks) {
    if (c.status === "pass") passed++;
    else if (c.status === "fail") {
      failed++;
      blockingReasons.push(`[${c.id}] ${c.name}${c.detail ? ": " + c.detail : ""}`);
    } else if (c.status === "warn") warned++;
    else if (c.status === "skip") skipped++;
  }
  return { passed, failed, warned, skipped, blockingReasons };
}

interface JsonReplacer {
  (this: unknown, key: string, value: unknown): unknown;
}

const bigintReplacer: JsonReplacer = function (_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
};

function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, bigintReplacer, 2) + "\n");
}

function emitHuman(line: string): void {
  process.stderr.write(line + (line.endsWith("\n") ? "" : "\n"));
}

// ─────────────────────────────────────────────────────────────────────────
// Group A — environment-only preflight
// ─────────────────────────────────────────────────────────────────────────

async function runPreflightGroupA(): Promise<{ checks: Check[]; manifest: Manifest | null; canonicalDenylistHit: boolean }> {
  const checks: Check[] = [];
  let canonicalDenylistHit = false;

  // 1. Sidecar /health
  const health = await getSidecarHealth();
  if (health) checks.push(check("A1", "Sidecar /health", "pass", `network=${health.network} version=${health.sidecarVersion}`));
  else checks.push(check("A1", "Sidecar /health", "fail", "Sidecar at port 8081 unreachable. Start it: cd chaincash && sbt 'runMain chaincash.sidecar.SidecarServer'"));

  // 2. Ergo node /info
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
    const res = await fetch("http://localhost:9052/info", { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (res.ok) {
      const info = await res.json();
      checks.push(check("A2", "Ergo node /info", "pass", `height=${info.fullHeight ?? info.bestFullHeaderId ?? "?"}`));
    } else {
      checks.push(check("A2", "Ergo node /info", "fail", `node returned ${res.status}`));
    }
  } catch (e) {
    checks.push(check("A2", "Ergo node /info", "fail", e instanceof Error ? e.message : String(e)));
  }

  // 3. Dev server reachable
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
    const res = await fetch(`${AGENT_URL}/api/auth/providers`, { method: "HEAD", signal: ctrl.signal }).finally(() => clearTimeout(t));
    // Even 401/405 means the server is up; only network errors mean down.
    checks.push(check("A3", "Dev server reachable", "pass", `status=${res.status} (server is up)`));
  } catch {
    checks.push(check("A3", "Dev server reachable", "fail", `${AGENT_URL} not reachable. Start: DEMO_MODE=true npx next dev -p 3000`));
  }

  // 4. Slice-13b manifest exists
  const manifest = readManifest();
  if (!manifest) {
    checks.push(check("A4", "Slice-13b manifest exists",
      "fail",
      `Missing ${MANIFEST_FILE}. Run: npx tsx scripts/seed-settlement-demo-reserve.ts --prepare ... and --sync first.`));
    // Without a manifest we can't run the rest of the manifest-dependent checks.
    return { checks, manifest: null, canonicalDenylistHit };
  }
  checks.push(check("A4", "Slice-13b manifest exists", "pass", `reserveId=${manifest.reserveId.slice(0, 8)}...`));

  // 5-7. Canonical denylist (manifest fields)
  const cd = isCanonical(manifest);
  if (cd.hit) {
    canonicalDenylistHit = true;
    checks.push(check("A5", "Manifest reserveId not canonical", cd.field === "reserveId" ? "fail" : "pass"));
    checks.push(check("A6", "Manifest reserveTokenId not canonical", cd.field === "reserveTokenId" ? "fail" : "pass"));
    checks.push(check("A7", "Manifest trackerNftId not canonical", cd.field === "trackerNftId" ? "fail" : "pass"));
    return { checks, manifest, canonicalDenylistHit };
  }
  checks.push(check("A5", "Manifest reserveId not canonical", "pass"));
  checks.push(check("A6", "Manifest reserveTokenId not canonical", "pass"));
  checks.push(check("A7", "Manifest trackerNftId not canonical", "pass"));

  // 8. Demo reserve row at lifecycle="active"
  const reserve = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });
  if (!reserve) {
    checks.push(check("A8", "Demo reserve row at lifecycle=active", "fail",
      `No Reserve row for manifest reserveId. Manifest may be stale; run slice-13b --status to inspect.`));
  } else if (reserve.lifecycle !== "active") {
    checks.push(check("A8", "Demo reserve row at lifecycle=active", "fail",
      `lifecycle="${reserve.lifecycle}". For depleted: rerun slice-13b --cleanup, --prepare with a fresh reserveTokenId, deploy, --sync.`));
  } else {
    checks.push(check("A8", "Demo reserve row at lifecycle=active", "pass"));
  }

  // 9. boxId non-null
  if (reserve && reserve.boxId) checks.push(check("A9", "Demo reserve boxId non-null", "pass", reserve.boxId.slice(0, 16) + "..."));
  else checks.push(check("A9", "Demo reserve boxId non-null", "fail", "Run slice-13b --sync after deploy is confirmed."));

  // 10. valueNanoErg >= planned settlement amount (v1 identity: 100M nanoCredits = 100M nanoErg)
  if (reserve && reserve.valueNanoErg >= SETTLEMENT_NANO_CREDITS) {
    checks.push(check("A10", "Demo reserve valueNanoErg ≥ planned settlement", "pass",
      `${reserve.valueNanoErg.toString()} ≥ ${SETTLEMENT_NANO_CREDITS.toString()}`));
  } else if (reserve) {
    checks.push(check("A10", "Demo reserve valueNanoErg ≥ planned settlement", "fail",
      `valueNanoErg=${reserve.valueNanoErg.toString()} < ${SETTLEMENT_NANO_CREDITS.toString()}`));
  } else {
    checks.push(check("A10", "Demo reserve valueNanoErg ≥ planned settlement", "skip", "no reserve row"));
  }

  // 11-13. Sidecar reserve status
  if (reserve) {
    let status: Awaited<ReturnType<typeof getReserveStatus>> | null = null;
    try {
      status = await withTimeout(getReserveStatus(manifest.reserveTokenId), NET_TIMEOUT_MS, "sidecar /reserve/status");
    } catch (e) {
      checks.push(check("A11", "Sidecar /reserve/status reports found:true", "fail", e instanceof Error ? e.message : String(e)));
      checks.push(check("A12", "Sidecar valueNanoErg matches DB", "skip", "sidecar status unreachable"));
      checks.push(check("A13", "Reserve.avlTreeDigest matches sidecar", "skip", "sidecar status unreachable"));
    }
    if (status) {
      if (status.found) checks.push(check("A11", "Sidecar /reserve/status reports found:true", "pass"));
      else checks.push(check("A11", "Sidecar /reserve/status reports found:true", "fail", "Sidecar reports reserve not found on-chain. Re-sync or re-deploy."));

      if (status.found && reserve.valueNanoErg.toString() === String(status.valueNanoErg ?? "")) {
        checks.push(check("A12", "Sidecar valueNanoErg matches DB", "pass"));
      } else if (status.found) {
        checks.push(check("A12", "Sidecar valueNanoErg matches DB", "fail",
          `db=${reserve.valueNanoErg.toString()} sidecar=${status.valueNanoErg ?? "null"}; run slice-13b --sync`));
      } else {
        checks.push(check("A12", "Sidecar valueNanoErg matches DB", "skip", "sidecar reports not found"));
      }

      if (status.found && reserve.avlTreeDigest && status.avlTreeDigest && reserve.avlTreeDigest === status.avlTreeDigest) {
        checks.push(check("A13", "Reserve.avlTreeDigest matches sidecar", "pass"));
      } else if (status.found && reserve.avlTreeDigest && status.avlTreeDigest) {
        checks.push(check("A13", "Reserve.avlTreeDigest matches sidecar", "fail",
          `db=${reserve.avlTreeDigest.slice(0, 16)}... sidecar=${status.avlTreeDigest.slice(0, 16)}... — R5 drift; run slice-13b --sync`));
      } else if (status.found) {
        checks.push(check("A13", "Reserve.avlTreeDigest matches sidecar", "warn",
          `db=${reserve.avlTreeDigest ?? "null"} sidecar=${status.avlTreeDigest ?? "null"}`));
      } else {
        checks.push(check("A13", "Reserve.avlTreeDigest matches sidecar", "skip", "sidecar reports not found"));
      }
    }
  } else {
    checks.push(check("A11", "Sidecar /reserve/status reports found:true", "skip", "no reserve row"));
    checks.push(check("A12", "Sidecar valueNanoErg matches DB", "skip", "no reserve row"));
    checks.push(check("A13", "Reserve.avlTreeDigest matches sidecar", "skip", "no reserve row"));
  }

  // 14. Demo Debtor signingMode + privateKey
  const dd = await prisma.customer.findUnique({ where: { id: DEMO_DEBTOR_CUSTOMER_ID } });
  if (!dd) {
    checks.push(check("A14", "Demo Debtor signingMode=tracker, privateKey set", "fail", `Customer ${DEMO_DEBTOR_CUSTOMER_ID} not found`));
  } else if (dd.signingMode !== "tracker" || !dd.privateKey) {
    checks.push(check("A14", "Demo Debtor signingMode=tracker, privateKey set", "fail",
      `signingMode=${dd.signingMode}, privateKey=${dd.privateKey ? "set" : "missing"}`));
  } else {
    checks.push(check("A14", "Demo Debtor signingMode=tracker, privateKey set", "pass", `pubKey=${dd.publicKey.slice(0, 8)}...`));
  }

  // 15. Repo-lint Provider has privateKey
  const provider = await prisma.provider.findUnique({ where: { id: REPO_LINT_PROVIDER_ID } });
  if (!provider) {
    checks.push(check("A15", `Repo-lint provider ${REPO_LINT_PROVIDER_ID} exists with privateKey`, "fail",
      `Provider not found. Run: npx tsx scripts/seed-repo-lint-demo.ts`));
  } else if (!provider.privateKey) {
    checks.push(check("A15", `Repo-lint provider ${REPO_LINT_PROVIDER_ID} exists with privateKey`, "fail",
      `Provider exists but privateKey is empty — receiver secret cannot be auto-provisioned.`));
  } else {
    checks.push(check("A15", `Repo-lint provider ${REPO_LINT_PROVIDER_ID} exists with privateKey`, "pass",
      `pubKey=${provider.publicKey.slice(0, 8)}...`));
  }

  // 16. Repo-lint Tool exists
  const tool = await prisma.tool.findUnique({ where: { id: REPO_LINT_TOOL_ID } });
  if (!tool) {
    checks.push(check("A16", `Repo-lint tool ${REPO_LINT_TOOL_ID} exists`, "fail",
      `Tool not found. Run: npx tsx scripts/seed-repo-lint-demo.ts`));
  } else {
    checks.push(check("A16", `Repo-lint tool ${REPO_LINT_TOOL_ID} exists`, "pass",
      `endpoint=${tool.endpoint} cost=${tool.costPerCall.toString()} status=${tool.status}`));
  }

  // 17. Owner secret file
  if (dd && dd.publicKey) {
    const ownerFile = path.join(os.homedir(), ".chaincash-secrets", `owner-${dd.publicKey.slice(0, 8)}.json`);
    if (fs.existsSync(ownerFile)) {
      checks.push(check("A17", "Owner secret file exists", "pass", ownerFile));
    } else {
      checks.push(check("A17", "Owner secret file exists", "fail",
        `${ownerFile} missing. The redeem route auto-provisions from Customer.privateKey on first call, ` +
        `but operator-side sanity expects it pre-staged. To create manually re-run any earlier seed flow that uses ensureSecretFile.`));
    }
  } else {
    checks.push(check("A17", "Owner secret file exists", "skip", "no Demo Debtor row"));
  }

  // 18. No PendingRedemption in flight for the demo reserve
  const pending = await prisma.pendingRedemption.findMany({
    where: { reserveId: manifest.reserveId, status: "pending" },
  });
  if (pending.length === 0) {
    checks.push(check("A18", "No in-flight PendingRedemption for demo reserve", "pass"));
  } else {
    checks.push(check("A18", "No in-flight PendingRedemption for demo reserve", "fail",
      `${pending.length} pending row(s). Run: curl -X POST ${AGENT_URL}/api/reserves/recover-pending -d '{"reserveId":"${manifest.reserveId}"}'`));
  }

  // 19. Canonical reserve still exists, lifecycle=active (so Stage 1 can snapshot it)
  const canonical = await prisma.reserve.findUnique({ where: { id: CANONICAL_RESERVE_ID } });
  if (!canonical) {
    checks.push(check("A19", "Canonical reserve row exists", "fail",
      `Canonical reserve ${CANONICAL_RESERVE_ID.slice(0, 8)}... not found in DB. Snapshot will not be possible.`));
  } else if (canonical.lifecycle !== "active") {
    checks.push(check("A19", "Canonical reserve at lifecycle=active", "warn",
      `lifecycle=${canonical.lifecycle} (snapshot still works, but unexpected)`));
  } else {
    checks.push(check("A19", "Canonical reserve at lifecycle=active", "pass"));
  }

  return { checks, manifest, canonicalDenylistHit };
}

// ─────────────────────────────────────────────────────────────────────────
// Group B — post-seed lane validation (runs in --execute Stage 2b)
// ─────────────────────────────────────────────────────────────────────────

async function runLaneValidationGroupB(rawApiKey: string | null): Promise<Check[]> {
  const checks: Check[] = [];

  const provider = await prisma.provider.findUnique({ where: { id: REPO_LINT_PROVIDER_ID } });
  checks.push(provider && provider.status === "active"
    ? check("B1", "Repo-lint Provider status=active", "pass")
    : check("B1", "Repo-lint Provider status=active", "fail", `status=${provider?.status ?? "missing"}`));

  const tool = await prisma.tool.findUnique({ where: { id: REPO_LINT_TOOL_ID } });
  checks.push(tool && tool.status === "active"
    ? check("B2", "Repo-lint Tool status=active", "pass")
    : check("B2", "Repo-lint Tool status=active", "fail", `status=${tool?.status ?? "missing"}`));

  const agent = await prisma.agentIdentity.findUnique({ where: { id: REPO_LINT_AGENT_ID } });
  checks.push(agent && agent.status === "active"
    ? check("B3", "Repo-lint AgentIdentity active", "pass")
    : check("B3", "Repo-lint AgentIdentity active", "fail", `status=${agent?.status ?? "missing"}`));

  const apiKeyOk = agent && !!agent.apiKeyHash;
  checks.push(apiKeyOk
    ? check("B4", "Agent has API key hash", "pass")
    : check("B4", "Agent has API key hash", "fail", "agent has no apiKeyHash"));

  checks.push(rawApiKey && rawApiKey.length > 0
    ? check("B5", "Captured API key from seeder", "pass", `len=${rawApiKey.length}`)
    : check("B5", "Captured API key from seeder", "fail", "could not extract raw API key from seed-repo-lint-demo stdout"));

  const cl = await prisma.creditLine.findUnique({ where: { id: REPO_LINT_CL_ID } });
  checks.push(cl
    ? check("B6", "CreditLine exists", "pass")
    : check("B6", "CreditLine exists", "fail", `${REPO_LINT_CL_ID} missing`));

  if (cl) {
    checks.push(cl.limitAmount >= SETTLEMENT_NANO_CREDITS
      ? check("B7", "CreditLine limitAmount ≥ planned cap", "pass", `limit=${cl.limitAmount.toString()}`)
      : check("B7", "CreditLine limitAmount ≥ planned cap", "fail",
          `limit=${cl.limitAmount.toString()} < ${SETTLEMENT_NANO_CREDITS.toString()}`));
  } else {
    checks.push(check("B7", "CreditLine limitAmount ≥ planned cap", "skip", "no CreditLine"));
  }

  const oblForLane = await prisma.obligationState.findFirst({
    where: { customerId: DEMO_DEBTOR_CUSTOMER_ID, providerId: REPO_LINT_PROVIDER_ID },
  });
  checks.push(!oblForLane
    ? check("B8", "Lane is fresh (no ObligationState yet)", "pass")
    : check("B8", "Lane is fresh (no ObligationState yet)", "fail",
        `ObligationState ${oblForLane.id} exists. --reset should have removed it. Re-run.`));

  const ueCount = agent
    ? await prisma.usageEvent.count({ where: { agentIdentityId: REPO_LINT_AGENT_ID } })
    : 0;
  checks.push(ueCount === 0
    ? check("B9", "Lane is fresh (no UsageEvents)", "pass")
    : check("B9", "Lane is fresh (no UsageEvents)", "fail", `${ueCount} UsageEvent rows present`));

  return checks;
}

// ─────────────────────────────────────────────────────────────────────────
// --preflight entry
// ─────────────────────────────────────────────────────────────────────────

async function cmdPreflight(): Promise<number> {
  emitHuman(`[13c-preflight] starting Group A environment-only checks`);
  const { checks, manifest, canonicalDenylistHit } = await runPreflightGroupA();
  const sum = summarize(checks);

  const result = {
    phase: "preflight",
    inputs: {
      manifestPath: MANIFEST_FILE,
      manifest: manifest ?? null,
      agentUrl: AGENT_URL,
    },
    summary: {
      total: checks.length,
      passed: sum.passed,
      failed: sum.failed,
      warned: sum.warned,
      skipped: sum.skipped,
      canonicalDenylistHit,
    },
    checks,
    blockingReasons: sum.blockingReasons,
    nextStep: canonicalDenylistHit
      ? "PANIC: manifest matches canonical reserve. Edit manifest immediately. Do NOT --execute."
      : sum.failed === 0
        ? "Environment preflight PASS. Run --execute to perform the settlement demo."
        : `Environment preflight FAIL. Resolve blocker(s) and re-run --preflight. (${sum.failed} blocker(s) found.)`,
  };

  emitJson(result);
  emitHuman(``);
  emitHuman(`[13c-preflight] ${sum.passed}/${checks.length} pass, ${sum.failed} fail, ${sum.warned} warn, ${sum.skipped} skip`);
  if (canonicalDenylistHit) {
    emitHuman(`[13c-preflight] PANIC — canonical denylist hit. See JSON.`);
    return 2;
  }
  if (sum.failed > 0) {
    emitHuman(`[13c-preflight] BLOCKED. Reasons:`);
    for (const r of sum.blockingReasons) emitHuman(`  - ${r}`);
    return 1;
  }
  emitHuman(`[13c-preflight] PASS — environment is ready for --execute.`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// --execute entry
// ─────────────────────────────────────────────────────────────────────────

interface CanonicalSnapshot {
  reserveId: string;
  valueNanoErg: string;
  boxId: string | null;
  avlTreeDigest: string | null;
  lifecycle: string;
  contractVersion: string;
  updatedAt: string;
  // Settlements scoped to the canonical reserve only (slice 13d). The previous
  // customer-scoped count would falsely flag a settlement on the slice-13b
  // demo reserve as canonical mutation, since both share Demo Debtor.
  settlementCountForCanonicalReserveId: number;
}

async function snapshotCanonical(): Promise<CanonicalSnapshot> {
  const c = await prisma.reserve.findUnique({ where: { id: CANONICAL_RESERVE_ID } });
  if (!c) throw new Error(`Canonical reserve ${CANONICAL_RESERVE_ID} not found`);
  const seCount = await prisma.settlementEvent.count({
    where: {
      reserveId: CANONICAL_RESERVE_ID,
      method: "on-chain-redemption",
    },
  });
  return {
    reserveId: c.id,
    valueNanoErg: c.valueNanoErg.toString(),
    boxId: c.boxId,
    avlTreeDigest: c.avlTreeDigest,
    lifecycle: c.lifecycle,
    contractVersion: c.contractVersion,
    updatedAt: c.updatedAt.toISOString(),
    settlementCountForCanonicalReserveId: seCount,
  };
}

async function snapshotCounts(): Promise<Record<string, number>> {
  return {
    customer: await prisma.customer.count(),
    provider: await prisma.provider.count(),
    tool: await prisma.tool.count(),
    agentIdentity: await prisma.agentIdentity.count(),
    creditLine: await prisma.creditLine.count(),
    obligationState: await prisma.obligationState.count(),
    obligationUpdate: await prisma.obligationUpdate.count(),
    usageEvent: await prisma.usageEvent.count(),
    reserve: await prisma.reserve.count(),
    settlementEvent: await prisma.settlementEvent.count(),
    pendingRedemption: await prisma.pendingRedemption.count(),
    trackerBox: await prisma.trackerBox.count(),
    trackerEntry: await prisma.trackerEntry.count(),
    delegation: await prisma.delegation.count(),
  };
}

function runSeederSync(args: string[]): { stdout: string; stderr: string; code: number } {
  const scriptDir = path.join(__dirname);
  const result = spawnSync("npx", ["tsx", path.join(scriptDir, "seed-repo-lint-demo.ts"), ...args], {
    cwd: path.join(scriptDir, ".."),
    encoding: "utf-8",
    env: process.env,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? -1,
  };
}

function extractRawApiKey(stdout: string): string | null {
  // seed-repo-lint-demo.ts prints:
  //   Raw API key (shown ONCE — copy to AGENT_TAB_AGENT_KEY env var; not recoverable):
  //
  //     <uuid>
  //
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("Raw API key")) {
      // The next non-empty trimmed line is the key.
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const t = lines[j].trim();
        if (t.length > 0) return t;
      }
    }
  }
  return null;
}

function runReadinessAuditSync(reserveId: string, obligationStateId: string): { stdout: string; stderr: string; code: number } {
  const scriptDir = path.join(__dirname);
  const result = spawnSync(
    "npx",
    ["tsx", path.join(scriptDir, "check-settlement-readiness.ts"),
      "--reserve-id", reserveId,
      "--obligation-state-id", obligationStateId],
    {
      cwd: path.join(scriptDir, ".."),
      encoding: "utf-8",
      env: process.env,
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? -1,
  };
}

function parseAuditJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return { rawStdout: stdout };
  }
}

interface RedeemOutcome {
  status: number;
  body: unknown;
}

async function postRedeem(reserveId: string, obligationId: string, cookie: string): Promise<RedeemOutcome> {
  const res = await fetch(`${AGENT_URL}/api/reserves/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ reserveId, obligationId }),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function postRecoverPending(reserveId: string, cookie: string): Promise<RedeemOutcome> {
  const res = await fetch(`${AGENT_URL}/api/reserves/recover-pending`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ reserveId }),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function callProxy(rawApiKey: string): Promise<RedeemOutcome> {
  const res = await fetch(`${AGENT_URL}/api/proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-api-key": rawApiKey,
      "x-tool-id": REPO_LINT_TOOL_ID,
    },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function compareCanonical(before: CanonicalSnapshot): Promise<{ matches: boolean; diff: Record<string, unknown> }> {
  const after = await snapshotCanonical();
  const diff: Record<string, unknown> = {};
  if (before.reserveId !== after.reserveId) diff.reserveId = { before: before.reserveId, after: after.reserveId };
  if (before.valueNanoErg !== after.valueNanoErg) diff.valueNanoErg = { before: before.valueNanoErg, after: after.valueNanoErg };
  if (before.boxId !== after.boxId) diff.boxId = { before: before.boxId, after: after.boxId };
  if (before.avlTreeDigest !== after.avlTreeDigest) diff.avlTreeDigest = { before: before.avlTreeDigest, after: after.avlTreeDigest };
  if (before.lifecycle !== after.lifecycle) diff.lifecycle = { before: before.lifecycle, after: after.lifecycle };
  if (before.contractVersion !== after.contractVersion) diff.contractVersion = { before: before.contractVersion, after: after.contractVersion };
  if (before.updatedAt !== after.updatedAt) diff.updatedAt = { before: before.updatedAt, after: after.updatedAt };
  if (before.settlementCountForCanonicalReserveId !== after.settlementCountForCanonicalReserveId)
    diff.settlementCountForCanonicalReserveId = {
      before: before.settlementCountForCanonicalReserveId,
      after: after.settlementCountForCanonicalReserveId,
    };
  return { matches: Object.keys(diff).length === 0, diff };
}

async function cmdExecute(): Promise<number> {
  emitHuman(`[13c-execute] starting`);
  const stages: Array<{ stage: string; status: "pass" | "fail" | "panic"; data?: unknown }> = [];

  // Stage 0: re-run Group A
  emitHuman(`[stage 0] Re-running Group A environment preflight as gate`);
  const a = await runPreflightGroupA();
  if (a.canonicalDenylistHit) {
    emitJson({ phase: "execute", abortedAt: "stage-0", reason: "canonical-denylist", checks: a.checks });
    emitHuman(`[stage 0] PANIC — canonical denylist hit. Aborting.`);
    return 2;
  }
  const aSum = summarize(a.checks);
  if (aSum.failed > 0) {
    emitJson({ phase: "execute", abortedAt: "stage-0", blockingReasons: aSum.blockingReasons, checks: a.checks });
    emitHuman(`[stage 0] BLOCKED — ${aSum.failed} environment check(s) failed. Run --preflight for details.`);
    return 1;
  }
  if (!a.manifest) {
    emitJson({ phase: "execute", abortedAt: "stage-0", reason: "no manifest" });
    return 1;
  }
  stages.push({ stage: "0-preflight", status: "pass", data: { passed: aSum.passed, total: a.checks.length } });
  const manifest = a.manifest;

  // Stage 1: snapshot canonical + counts
  emitHuman(`[stage 1] Snapshotting canonical reserve + DB counts`);
  const canonicalBefore = await snapshotCanonical();
  fs.writeFileSync(CANONICAL_BEFORE_FILE, JSON.stringify(canonicalBefore, null, 2));
  const countsBefore = await snapshotCounts();
  fs.writeFileSync(COUNTS_BEFORE_FILE, JSON.stringify(countsBefore, null, 2));
  stages.push({ stage: "1-snapshot", status: "pass", data: { canonicalBefore, countsBefore } });

  // Stage 2: reset + reseed repo-lint lane
  emitHuman(`[stage 2] Resetting repo-lint lane (--reset) and re-seeding`);
  const resetRes = runSeederSync(["--reset"]);
  if (resetRes.code !== 0) {
    emitJson({ phase: "execute", abortedAt: "stage-2-reset", code: resetRes.code, stdout: resetRes.stdout, stderr: resetRes.stderr });
    emitHuman(`[stage 2] FAIL — seed-repo-lint-demo --reset exited ${resetRes.code}.`);
    emitHuman(`         If "Refusing to delete ObligationState ... SettlementEvent FK refs", a prior 13c run already settled this lane.`);
    emitHuman(`         To re-run 13c, manually clear the SettlementEvent rows for that obligation, or work against a different demo reserve.`);
    return 1;
  }
  const seedRes = runSeederSync([]);
  if (seedRes.code !== 0) {
    emitJson({ phase: "execute", abortedAt: "stage-2-seed", code: seedRes.code, stdout: seedRes.stdout, stderr: seedRes.stderr });
    emitHuman(`[stage 2] FAIL — seed-repo-lint-demo exited ${seedRes.code}.`);
    return 1;
  }
  const rawApiKey = extractRawApiKey(seedRes.stdout);
  stages.push({ stage: "2-reset-reseed", status: "pass", data: { capturedKey: rawApiKey ? `present (len=${rawApiKey.length})` : "absent" } });

  // Stage 2b: post-seed lane validation
  emitHuman(`[stage 2b] Group B post-seed lane validation`);
  const bChecks = await runLaneValidationGroupB(rawApiKey);
  const bSum = summarize(bChecks);
  stages.push({ stage: "2b-lane-validation", status: bSum.failed === 0 ? "pass" : "fail", data: { checks: bChecks, summary: bSum } });
  if (bSum.failed > 0) {
    emitJson({ phase: "execute", abortedAt: "stage-2b", blockingReasons: bSum.blockingReasons, checks: bChecks });
    emitHuman(`[stage 2b] FAIL — lane state is not as expected post-reseed. ${bSum.failed} blocker(s).`);
    for (const r of bSum.blockingReasons) emitHuman(`  - ${r}`);
    return 1;
  }
  if (!rawApiKey) {
    emitJson({ phase: "execute", abortedAt: "stage-2b", reason: "no-api-key" });
    emitHuman(`[stage 2b] FAIL — could not extract raw API key from seeder output.`);
    return 1;
  }

  // Stage 3: /api/proxy
  emitHuman(`[stage 3] POST /api/proxy → one Work Receipt`);
  const proxyRes = await callProxy(rawApiKey);
  if (proxyRes.status !== 200) {
    emitJson({ phase: "execute", abortedAt: "stage-3-proxy", proxy: proxyRes });
    emitHuman(`[stage 3] FAIL — /api/proxy returned ${proxyRes.status}`);
    return 1;
  }
  const obligation = await prisma.obligationState.findFirst({
    where: { customerId: DEMO_DEBTOR_CUSTOMER_ID, providerId: REPO_LINT_PROVIDER_ID },
  });
  if (!obligation || obligation.currentAmount !== SETTLEMENT_NANO_CREDITS) {
    emitJson({ phase: "execute", abortedAt: "stage-3-verify", obligation: obligation ?? null });
    emitHuman(`[stage 3] FAIL — ObligationState missing or currentAmount unexpected.`);
    return 1;
  }
  stages.push({ stage: "3-work-receipt", status: "pass", data: { obligationId: obligation.id, currentAmount: obligation.currentAmount.toString(), proxy: proxyRes.body } });

  // Stage 4: 13a audit (expect tracker-entry-missing FAIL)
  emitHuman(`[stage 4] Running slice-13a readiness audit (expect useful FAIL: tracker-entry-missing)`);
  const aud1 = runReadinessAuditSync(manifest.reserveId, obligation.id);
  const aud1Json = parseAuditJson(aud1.stdout);
  stages.push({ stage: "4-audit-pre", status: "pass", data: { exitCode: aud1.code, auditJson: aud1Json } });

  // Stage 5: defensive ID check (denylist + provider match)
  emitHuman(`[stage 5] Defensive denylist + provider check (canonical safety)`);
  const cd = isCanonical(manifest);
  if (cd.hit) {
    emitJson({ phase: "execute", abortedAt: "stage-5", reason: "canonical-denylist", field: cd.field });
    emitHuman(`[stage 5] PANIC — manifest matches canonical reserve via ${cd.field}. Aborting.`);
    return 2;
  }
  if (obligation.providerId !== REPO_LINT_PROVIDER_ID) {
    emitJson({ phase: "execute", abortedAt: "stage-5", reason: "wrong-provider", obligation });
    emitHuman(`[stage 5] PANIC — obligation provider is not the repo-lint provider.`);
    return 2;
  }
  stages.push({ stage: "5-defensive", status: "pass" });

  // Stage 6: redeem
  emitHuman(`[stage 6] POST /api/reserves/redeem`);
  const cookie = await operatorCookieHeader();
  const redeem = await postRedeem(manifest.reserveId, obligation.id, cookie);
  emitHuman(`[stage 6] redeem status=${redeem.status}`);
  stages.push({ stage: "6-redeem", status: "pass", data: redeem });

  if (redeem.status >= 400 && redeem.status !== 202 && redeem.status !== 207) {
    emitJson({ phase: "execute", abortedAt: "stage-6", redeem });
    emitHuman(`[stage 6] FAIL — redeem returned ${redeem.status}.`);
    return 1;
  }

  // Stage 7: recovery loop if needed
  if (redeem.status === 202 || redeem.status === 207) {
    emitHuman(`[stage 7] Redeem returned ${redeem.status}. Entering recovery loop.`);
    let reconciled = false;
    for (let attempt = 1; attempt <= RECOVERY_MAX_RETRIES; attempt++) {
      emitHuman(`[stage 7] attempt ${attempt}/${RECOVERY_MAX_RETRIES}: waiting ${RECOVERY_WAIT_MS}ms then calling recover-pending`);
      await new Promise((r) => setTimeout(r, RECOVERY_WAIT_MS));
      const rec = await postRecoverPending(manifest.reserveId, cookie);
      const recBody = rec.body as { recovered?: Array<{ status?: string; obligationId?: string }> };
      const reconciledMatch = (recBody.recovered ?? []).find(
        (r) => r.obligationId === obligation.id && (r.status === "reconciled" || r.status === "already-reconciled"),
      );
      if (reconciledMatch) {
        reconciled = true;
        stages.push({ stage: "7-recovery", status: "pass", data: { attempt, rec } });
        break;
      }
    }
    if (!reconciled) {
      emitJson({ phase: "execute", abortedAt: "stage-7" });
      emitHuman(`[stage 7] FAIL — recovery did not reconcile within ${RECOVERY_MAX_RETRIES} attempts.`);
      emitHuman(`         Manual remediation: POST ${AGENT_URL}/api/reserves/recover-pending with reserveId=${manifest.reserveId}`);
      emitHuman(`         Or check the Ergo block explorer for the redemption tx.`);
      return 1;
    }
  } else {
    stages.push({ stage: "7-recovery", status: "pass", data: "skipped (synchronous reconciliation in stage 6)" });
  }

  // Stage 8: verify post-conditions
  emitHuman(`[stage 8] Verifying settlement post-conditions`);
  const settlement = await prisma.settlementEvent.findFirst({
    where: { obligationStateId: obligation.id, redemptionTxId: { not: null } },
    orderBy: { timestamp: "desc" },
  });
  const obligationAfter = await prisma.obligationState.findUnique({ where: { id: obligation.id } });
  const reserveAfter = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });
  const trackerEntry = await prisma.trackerEntry.findFirst({
    where: {
      debtorPubKey: obligation.debtorPubKey,
      creditorPubKey: obligation.creditorPubKey,
      trackerBox: { trackerNftId: manifest.trackerNftId, isCurrent: true },
    },
  });
  const provider = await prisma.provider.findUnique({ where: { id: REPO_LINT_PROVIDER_ID } });
  const receiverFile = provider?.publicKey
    ? path.join(os.homedir(), ".chaincash-secrets", `receiver-${provider.publicKey.slice(0, 8)}.json`)
    : "";
  const receiverFileExists = receiverFile.length > 0 && fs.existsSync(receiverFile);

  const stage8Pass =
    !!settlement &&
    settlement.method === "on-chain-redemption" &&
    settlement.status === "completed" &&
    !!obligationAfter && obligationAfter.currentAmount === BigInt(0) &&
    !!reserveAfter &&
    reserveAfter.boxId !== canonicalBefore.boxId && // not the same box
    !!trackerEntry &&
    receiverFileExists;

  stages.push({
    stage: "8-verify",
    status: stage8Pass ? "pass" : "fail",
    data: {
      settlement: settlement
        ? { id: settlement.id, redemptionTxId: settlement.redemptionTxId, amount: settlement.amount.toString(), method: settlement.method, status: settlement.status }
        : null,
      obligationAfter: obligationAfter ? { id: obligationAfter.id, currentAmount: obligationAfter.currentAmount.toString(), settlementStatus: obligationAfter.settlementStatus } : null,
      reserveAfter: reserveAfter ? { id: reserveAfter.id, valueNanoErg: reserveAfter.valueNanoErg.toString(), boxId: reserveAfter.boxId, avlTreeDigest: reserveAfter.avlTreeDigest, lifecycle: reserveAfter.lifecycle } : null,
      trackerEntry: trackerEntry ? { id: trackerEntry.id, totalDebtNanoErg: trackerEntry.totalDebtNanoErg.toString() } : null,
      receiverFile: { path: receiverFile, exists: receiverFileExists },
    },
  });

  if (!stage8Pass) {
    emitJson({ phase: "execute", abortedAt: "stage-8", stages });
    emitHuman(`[stage 8] FAIL — post-condition mismatch.`);
    return 1;
  }

  // Stage 9: canonical reserve byte-for-byte
  emitHuman(`[stage 9] Verifying canonical reserve untouched (PANIC on any drift)`);
  const cmp = await compareCanonical(canonicalBefore);
  if (!cmp.matches) {
    stages.push({ stage: "9-canonical", status: "panic", data: { diff: cmp.diff, before: canonicalBefore } });
    emitJson({ phase: "execute", abortedAt: "stage-9", reason: "canonical-mutation", diff: cmp.diff, before: canonicalBefore, stages });
    emitHuman(`[stage 9] PANIC — canonical reserve was mutated. Diff:`);
    for (const k of Object.keys(cmp.diff)) emitHuman(`  - ${k}: ${JSON.stringify((cmp.diff as Record<string, unknown>)[k])}`);
    return 2;
  }
  stages.push({ stage: "9-canonical", status: "pass" });

  // Stage 10: 13a audit again (expect Obligation.currentAmount > 0 FAIL)
  emitHuman(`[stage 10] Re-running slice-13a readiness audit (expect FAIL: Obligation.currentAmount=0)`);
  const aud2 = runReadinessAuditSync(manifest.reserveId, obligation.id);
  const aud2Json = parseAuditJson(aud2.stdout);
  stages.push({ stage: "10-audit-post", status: "pass", data: { exitCode: aud2.code, auditJson: aud2Json } });

  // Stage 11: final summary
  emitHuman(`[stage 11] Settlement demo complete. Building final report.`);
  const finalReport = {
    phase: "execute",
    result: "PASS",
    redemptionTxId: settlement?.redemptionTxId ?? null,
    settlementEventId: settlement?.id ?? null,
    obligationId: obligation.id,
    canonicalBefore,
    canonicalAfter: await snapshotCanonical(),
    demoReserveBefore: { /* derived from manifest + initial sync — not snapshot here for brevity */
      reserveId: manifest.reserveId,
      reserveTokenId: manifest.reserveTokenId,
      trackerNftId: manifest.trackerNftId,
    },
    demoReserveAfter: reserveAfter ? {
      id: reserveAfter.id,
      valueNanoErg: reserveAfter.valueNanoErg.toString(),
      boxId: reserveAfter.boxId,
      avlTreeDigest: reserveAfter.avlTreeDigest,
      lifecycle: reserveAfter.lifecycle,
    } : null,
    auditBeforeRedeem: aud1Json,
    auditAfterRedeem: aud2Json,
    stages,
    prove_sh_recommendation:
      "Run `bash agent-tab/scripts/prove.sh` to confirm 49/49 baseline preserved. " +
      "If it does NOT pass 49/49, STOP and report — do not patch validate.sh without explicit approval.",
  };
  emitJson(finalReport);
  emitHuman(``);
  emitHuman(`[13c-execute] PASS — settlement demo completed end-to-end.`);
  emitHuman(`[13c-execute] Settlement tx: ${settlement?.redemptionTxId ?? "(none)"}`);
  emitHuman(`[13c-execute] Next: bash agent-tab/scripts/prove.sh — must return 49/49.`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n\n`);
    printHelp();
    process.exit(2);
  }

  if (args.phase === "help" || args.phase === null) {
    printHelp();
    process.exit(args.phase === "help" ? 0 : 2);
  }

  let code: number;
  if (args.phase === "preflight") code = await cmdPreflight();
  else if (args.phase === "execute") code = await cmdExecute();
  else code = 2;

  process.exit(code);
}

main()
  .catch((e) => {
    process.stderr.write(`13c failed: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof Error && e.stack) process.stderr.write(e.stack + "\n");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
