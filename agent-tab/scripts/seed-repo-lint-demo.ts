#!/usr/bin/env tsx
/**
 * seed-repo-lint-demo
 *
 * Slice 12a.1 fixture seeder — adds a second receipt-producing tool on a
 * dedicated provider lane so it cannot collide with the analyze_text demo.
 *
 * Self-contained — does NOT depend on seed-authority-demo.ts. Creates:
 *   - 1 Provider:       mcp-demo-repo-tools-001       (new, with own keypair)
 *   - 1 Tool:           mcp-demo-tool-repo-lint-001   ($0.10/call)
 *   - 1 AgentIdentity:  mcp-demo-repo-agent-001       (Demo Debtor's agent)
 *   - 1 CreditLine:     mcp-demo-repo-cl-001          (Demo Debtor ↔ Repo Tools)
 *
 * Reuses existing fixture (NEVER mutates):
 *   - Customer: Demo Debtor (tracker-managed, privateKey intact)
 *
 * The first /api/proxy call against this fixture creates the
 * ObligationState (Demo Debtor ↔ Repo Tools, version=0) automatically.
 *
 * Usage:
 *   tsx scripts/seed-repo-lint-demo.ts                              # default: limit=$0.10 (1 allowed + 2nd denied)
 *   tsx scripts/seed-repo-lint-demo.ts --limit-amount 1000000000   # roomy: $1.00 (10 allowed)
 *   tsx scripts/seed-repo-lint-demo.ts --cleanup                    # FK-safe: revoke agent + revoke credit line
 *   tsx scripts/seed-repo-lint-demo.ts --cleanup --hard             # also delete the CreditLine
 *   tsx scripts/seed-repo-lint-demo.ts --reset                      # destructive: scrub the lane for a fresh demo
 *   tsx scripts/seed-repo-lint-demo.ts --help
 *
 * Re-seed semantics (matches seed-mcp-demo.ts):
 *   - mcp-demo-repo-agent-001 is ACTIVE → refuse, exit nonzero, no rotation.
 *   - mcp-demo-repo-agent-001 is REVOKED → rotate (fresh raw key, status=active).
 *   - mcp-demo-repo-agent-001 does not exist → create (fresh raw key).
 *
 * Raw API key is printed exactly once to stdout. Never persisted, never logged.
 */

import { prisma } from "@/lib/prisma";
import { hashAgentApiKey, previewAgentApiKey } from "@/lib/agent-key-hash";
import { generateKeypair } from "@/lib/crypto";
import { randomUUID } from "node:crypto";

const DEMO_DEBTOR_NAME = "Demo Debtor";
const PROVIDER_ID = "mcp-demo-repo-tools-001";
const PROVIDER_NAME = "Repo Tools (demo)";
const TOOL_ID = "mcp-demo-tool-repo-lint-001";
const TOOL_NAME = "Repo Lint";
const TOOL_ENDPOINT = "http://localhost:3000/api/demo-tool/repo-lint";
const TOOL_COST = BigInt(100_000_000); // $0.10
const AGENT_ID = "mcp-demo-repo-agent-001";
const AGENT_LABEL = "mcp-gateway-repo-lint-agent";
const CL_ID = "mcp-demo-repo-cl-001";
const DEFAULT_LIMIT = BigInt(100_000_000); // $0.10 — 1 allowed, 2nd denied

interface Args {
  limitAmount: bigint;
  cleanup: boolean;
  hard: boolean;
  reset: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limitAmount: DEFAULT_LIMIT,
    cleanup: false,
    hard: false,
    reset: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cleanup") args.cleanup = true;
    else if (a === "--hard") args.hard = true;
    else if (a === "--reset") args.reset = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--limit-amount") {
      const v = argv[++i];
      if (!v) throw new Error("--limit-amount requires a value");
      args.limitAmount = BigInt(v);
      if (args.limitAmount <= BigInt(0)) throw new Error("--limit-amount must be positive");
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (args.cleanup && args.reset) {
    throw new Error("--cleanup and --reset are mutually exclusive");
  }
  return args;
}

function printHelp() {
  process.stdout.write(`seed-repo-lint-demo

Slice 12a.1 fixture seeder. Adds a dedicated Provider + Tool + AgentIdentity +
CreditLine so the budgeted_repo_lint demo runs in its own (provider, customer)
lane and cannot collide with seed-mcp-demo.ts state.

Flags:
  (no flags)              Seed with default limit $0.10 (1 allowed call + 1 denied).
  --limit-amount <ns>     Override limit in nanoCredits (default 100_000_000).
  --cleanup               FK-safe cleanup: revoke agent + revoke credit line.
                          Preserves audit history. Idempotent.
  --cleanup --hard        Also hard-delete the CreditLine (no FK refs).
                          AgentIdentity stays revoked (UsageEvent FK refs block deletion).
  --reset                 DESTRUCTIVE: delete every row in the repo-lint demo lane.
                          Removes UsageEvents for the agent, ObligationUpdates +
                          ObligationState for the (Demo Debtor ↔ Repo Tools) lane,
                          and the AgentIdentity + CreditLine themselves.
                          Provider + Tool rows are kept (no incoming user-facing FK refs).
                          Never touches canonical agents, providers, tools, or any
                          other customer/lane.
  --help, -h              Show this help.
`);
}

async function findDemoDebtor() {
  const dd = await prisma.customer.findFirst({
    where: { name: DEMO_DEBTOR_NAME },
    select: { id: true, name: true, signingMode: true, status: true, privateKey: true },
  });
  if (!dd) throw new Error(`Customer "${DEMO_DEBTOR_NAME}" not found in DB. The repo-lint demo requires this canonical fixture.`);
  if (dd.signingMode !== "tracker") throw new Error(`Demo Debtor signingMode is "${dd.signingMode}", expected "tracker".`);
  if (!dd.privateKey || dd.privateKey.length === 0) throw new Error("Demo Debtor.privateKey missing — tracker-managed signing will fail.");
  if (dd.status !== "active") throw new Error(`Demo Debtor status is "${dd.status}", expected "active".`);
  return dd;
}

async function ensureProvider() {
  const existing = await prisma.provider.findUnique({
    where: { id: PROVIDER_ID },
    select: { id: true, status: true, name: true },
  });
  if (existing) {
    if (existing.status !== "active") {
      await prisma.provider.update({ where: { id: PROVIDER_ID }, data: { status: "active" } });
      return { action: `${PROVIDER_ID}: reactivated (was ${existing.status})` };
    }
    return { action: `${PROVIDER_ID}: already exists (no change)` };
  }
  const keys = generateKeypair();
  await prisma.provider.create({
    data: {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    },
  });
  return { action: `${PROVIDER_ID}: created (${PROVIDER_NAME}, fresh keypair)` };
}

async function ensureTool() {
  const existing = await prisma.tool.findUnique({
    where: { id: TOOL_ID },
    select: { id: true, status: true, providerId: true, costPerCall: true },
  });
  if (existing) {
    if (existing.providerId !== PROVIDER_ID) {
      throw new Error(`Tool ${TOOL_ID} provider mismatch: expected ${PROVIDER_ID}, got ${existing.providerId}.`);
    }
    await prisma.tool.update({
      where: { id: TOOL_ID },
      data: {
        name: TOOL_NAME,
        endpoint: TOOL_ENDPOINT,
        costPerCall: TOOL_COST,
        status: "active",
      },
    });
    return { action: `${TOOL_ID}: ensured (cost=${TOOL_COST.toString()} nanoCredits, status=active)` };
  }
  await prisma.tool.create({
    data: {
      id: TOOL_ID,
      providerId: PROVIDER_ID,
      name: TOOL_NAME,
      description: "Runs npm run lint in the agent-tab repo (demo).",
      endpoint: TOOL_ENDPOINT,
      costPerCall: TOOL_COST,
      status: "active",
    },
  });
  return { action: `${TOOL_ID}: created (cost=${TOOL_COST.toString()} nanoCredits)` };
}

async function doCleanup(hard: boolean) {
  const agent = await prisma.agentIdentity.findUnique({ where: { id: AGENT_ID }, select: { id: true, status: true } });
  const cl = await prisma.creditLine.findUnique({ where: { id: CL_ID }, select: { id: true, status: true } });

  let agentMsg = `(no ${AGENT_ID} found — nothing to revoke)`;
  let clMsg = `(no ${CL_ID} found — nothing to revoke)`;

  if (agent) {
    if (agent.status !== "revoked") {
      await prisma.agentIdentity.update({ where: { id: AGENT_ID }, data: { status: "revoked" } });
      agentMsg = `${AGENT_ID}: status active → revoked`;
    } else {
      agentMsg = `${AGENT_ID}: already revoked (no change)`;
    }
  }

  if (cl) {
    if (hard) {
      await prisma.creditLine.delete({ where: { id: CL_ID } });
      clMsg = `${CL_ID}: hard-deleted (no incoming FK refs)`;
    } else {
      if (cl.status !== "inactive") {
        await prisma.creditLine.update({ where: { id: CL_ID }, data: { status: "inactive" } });
        clMsg = `${CL_ID}: status active → inactive`;
      } else {
        clMsg = `${CL_ID}: already inactive (no change)`;
      }
    }
  }

  process.stdout.write(`[seed-repo-lint-demo] cleanup ${hard ? "(hard)" : "(soft)"}\n`);
  process.stdout.write(`  AgentIdentity:  ${agentMsg}\n`);
  process.stdout.write(`  CreditLine:     ${clMsg}\n`);

  if (hard && agent && agent.status !== "revoked") {
    process.stdout.write(`  NOTE: AgentIdentity hard-delete is blocked by UsageEvent FK refs (Restrict).\n`);
    process.stdout.write(`        The agent stays in revoked state. Audit history preserved.\n`);
  }
}

async function doReset() {
  const dd = await prisma.customer.findFirst({
    where: { name: DEMO_DEBTOR_NAME },
    select: { id: true },
  });
  if (!dd) {
    process.stdout.write(`[seed-repo-lint-demo] reset: Demo Debtor not found; nothing to reset.\n`);
    return;
  }

  const obl = await prisma.obligationState.findFirst({
    where: { customerId: dd.id, providerId: PROVIDER_ID },
    select: { id: true, currentAmount: true, pendingAmount: true, version: true },
  });

  let updatesDeleted = 0;
  if (obl) {
    const ouRes = await prisma.obligationUpdate.deleteMany({
      where: { obligationStateId: obl.id },
    });
    updatesDeleted = ouRes.count;

    const prCount = await prisma.pendingRedemption.count({ where: { obligationId: obl.id } });
    const seCount = await prisma.settlementEvent.count({ where: { obligationStateId: obl.id } });
    if (prCount > 0 || seCount > 0) {
      throw new Error(
        `Refusing to delete ObligationState ${obl.id}: ${prCount} PendingRedemption + ${seCount} SettlementEvent FK refs. ` +
          `These should not exist for a pure tracker-mode repo-lint demo lane. Investigate before retrying.`,
      );
    }
    await prisma.obligationState.delete({ where: { id: obl.id } });
  }

  const ueRes = await prisma.usageEvent.deleteMany({
    where: { agentIdentityId: AGENT_ID },
  });

  const delegCount = await prisma.delegation.count({ where: { agentIdentityId: AGENT_ID } });
  if (delegCount > 0) {
    throw new Error(`Refusing to delete AgentIdentity ${AGENT_ID}: ${delegCount} Delegation FK refs. Investigate before retrying.`);
  }
  let agentDeleted = false;
  const agentExists = await prisma.agentIdentity.findUnique({ where: { id: AGENT_ID }, select: { id: true } });
  if (agentExists) {
    await prisma.agentIdentity.delete({ where: { id: AGENT_ID } });
    agentDeleted = true;
  }

  let clDeleted = false;
  const clExists = await prisma.creditLine.findUnique({ where: { id: CL_ID }, select: { id: true } });
  if (clExists) {
    await prisma.creditLine.delete({ where: { id: CL_ID } });
    clDeleted = true;
  }

  process.stdout.write(`[seed-repo-lint-demo] reset complete (repo-lint demo lane only)\n`);
  if (obl) {
    process.stdout.write(`  ObligationState ${obl.id}: deleted (was current=${obl.currentAmount.toString()}, pending=${obl.pendingAmount.toString()}, v=${obl.version})\n`);
    process.stdout.write(`  ObligationUpdate rows for that lane: ${updatesDeleted} deleted\n`);
  } else {
    process.stdout.write(`  ObligationState (Demo Debtor ↔ Repo Tools): none — nothing to delete\n`);
  }
  process.stdout.write(`  UsageEvent rows for ${AGENT_ID}: ${ueRes.count} deleted\n`);
  process.stdout.write(`  AgentIdentity ${AGENT_ID}: ${agentDeleted ? "deleted" : "absent"}\n`);
  process.stdout.write(`  CreditLine ${CL_ID}: ${clDeleted ? "deleted" : "absent"}\n`);
  process.stdout.write(`  Provider ${PROVIDER_ID} + Tool ${TOOL_ID}: kept (re-seed will reuse them)\n`);
  process.stdout.write(`\nNext: npx tsx scripts/seed-repo-lint-demo.ts --limit-amount 100000000\n`);
}

async function doSeed(limitAmount: bigint) {
  const dd = await findDemoDebtor();
  const provAction = await ensureProvider();
  const toolAction = await ensureTool();

  const existing = await prisma.agentIdentity.findUnique({
    where: { id: AGENT_ID },
    select: { id: true, status: true },
  });

  let rawKey: string | null = null;
  let agentAction: string;

  if (existing && existing.status === "active") {
    process.stderr.write(
      `[seed-repo-lint-demo] ${AGENT_ID} is already ACTIVE.\n` +
        `        Run with --cleanup before re-seeding to rotate the API key.\n` +
        `        The previous raw API key cannot be recovered.\n`,
    );
    process.exitCode = 2;
    return;
  } else if (existing && existing.status === "revoked") {
    rawKey = randomUUID();
    const apiKeyHash = hashAgentApiKey(rawKey);
    const apiKeyPreview = previewAgentApiKey(rawKey);
    await prisma.agentIdentity.update({
      where: { id: AGENT_ID },
      data: { apiKeyHash, apiKeyPreview, status: "active" },
    });
    agentAction = `${AGENT_ID}: revoked → active (key rotated)`;
  } else {
    rawKey = randomUUID();
    const apiKeyHash = hashAgentApiKey(rawKey);
    const apiKeyPreview = previewAgentApiKey(rawKey);
    await prisma.agentIdentity.create({
      data: {
        id: AGENT_ID,
        customerId: dd.id,
        label: AGENT_LABEL,
        apiKeyHash,
        apiKeyPreview,
        allowedToolIds: TOOL_ID,
        status: "active",
      },
    });
    agentAction = `${AGENT_ID}: created (label=${AGENT_LABEL}, allowedToolIds=${TOOL_ID})`;
  }

  const existingCl = await prisma.creditLine.findUnique({
    where: { id: CL_ID },
    select: { id: true, status: true, limitAmount: true },
  });
  let clAction: string;
  if (existingCl) {
    await prisma.creditLine.update({
      where: { id: CL_ID },
      data: { limitAmount: limitAmount, status: "active" },
    });
    clAction = `${CL_ID}: limit=${limitAmount.toString()} nanoCredits, status=active (was ${existingCl.status}, ${existingCl.limitAmount.toString()})`;
  } else {
    await prisma.creditLine.create({
      data: {
        id: CL_ID,
        providerId: PROVIDER_ID,
        customerId: dd.id,
        limitAmount: limitAmount,
        alertThreshold: 0.8,
        dueDays: 30,
        status: "active",
      },
    });
    clAction = `${CL_ID}: created (Demo Debtor ↔ Repo Tools, limit=${limitAmount.toString()} nanoCredits)`;
  }

  process.stdout.write(`[seed-repo-lint-demo] seed complete\n`);
  process.stdout.write(`  Customer:       ${dd.id} (Demo Debtor, tracker-managed)\n`);
  process.stdout.write(`  Provider:       ${provAction.action}\n`);
  process.stdout.write(`  Tool:           ${toolAction.action}\n`);
  process.stdout.write(`  AgentIdentity:  ${agentAction}\n`);
  process.stdout.write(`  CreditLine:     ${clAction}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Raw API key (shown ONCE — copy to AGENT_TAB_AGENT_KEY env var; not recoverable):\n\n`);
  process.stdout.write(`  ${rawKey}\n\n`);
  process.stdout.write(`Quick env setup:\n`);
  process.stdout.write(`  export AGENT_TAB_BASE_URL=http://localhost:3000\n`);
  process.stdout.write(`  export AGENT_TAB_AGENT_KEY='${rawKey}'\n`);
  process.stdout.write(`  export AGENT_TAB_TOOL_ID=${TOOL_ID}\n`);
  process.stdout.write(`  export AGENT_TAB_MCP_TOOL_NAME=budgeted_repo_lint\n`);
  process.stdout.write(`  export AGENT_TAB_MCP_INPUT_SHAPE=none\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Then run:  npx tsx scripts/mcp-gateway/index.ts\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.cleanup) {
    await doCleanup(args.hard);
  } else if (args.reset) {
    if (args.hard) {
      process.stderr.write("ERROR: --hard is for --cleanup, not --reset. --reset is already destructive.\n");
      process.exitCode = 2;
      return;
    }
    await doReset();
  } else {
    if (args.hard) {
      process.stderr.write("ERROR: --hard requires --cleanup. Use `--cleanup --hard`.\n");
      process.exitCode = 2;
      return;
    }
    await doSeed(args.limitAmount);
  }
}

main()
  .catch((e) => {
    process.stderr.write(`seed-repo-lint-demo failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
