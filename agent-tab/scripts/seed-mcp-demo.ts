#!/usr/bin/env tsx
/**
 * seed-mcp-demo
 *
 * Slice 12a fixture seeder — additive on the existing tracker-managed
 * Demo Debtor customer. Creates exactly:
 *   - 1 AgentIdentity:  mcp-demo-agent-001  (Demo Debtor's agent)
 *   - 1 CreditLine:     mcp-demo-cl-001     (Demo Debtor ↔ Bolt Tools)
 *
 * Reuses existing fixtures (NEVER mutates):
 *   - Customer:  Demo Debtor (tracker-managed, privateKey intact)
 *   - Provider:  auth-demo-bolt-tools-001
 *   - Tool:      auth-demo-tool-analyze-001 (costPerCall = $0.10)
 *
 * The first /api/proxy call against this fixture creates the
 * ObligationState (Demo Debtor ↔ Bolt Tools, version=0) automatically.
 *
 * Usage:
 *   tsx scripts/seed-mcp-demo.ts                       # default: limit=$1.00 (10 allowed + 11th denied)
 *   tsx scripts/seed-mcp-demo.ts --limit-amount 100000000   # snappy: $0.10 (1 allowed + 2nd denied)
 *   tsx scripts/seed-mcp-demo.ts --cleanup             # FK-safe: revoke agent + revoke credit line
 *   tsx scripts/seed-mcp-demo.ts --cleanup --hard      # also delete CreditLine; AgentIdentity stays revoked
 *   tsx scripts/seed-mcp-demo.ts --help
 *
 * Re-seed semantics (Tightening Issue 3):
 *   - mcp-demo-agent-001 is ACTIVE → refuse, exit nonzero, no rotation.
 *   - mcp-demo-agent-001 is REVOKED → rotate (fresh raw key, status=active, hash overwritten).
 *   - mcp-demo-agent-001 does not exist → create (fresh raw key).
 *
 * Raw API key is printed exactly once to stdout. Never persisted, never logged.
 */

import { prisma } from "@/lib/prisma";
import { hashAgentApiKey, previewAgentApiKey } from "@/lib/agent-key-hash";
import { randomUUID } from "node:crypto";

const DEMO_DEBTOR_NAME = "Demo Debtor";
const PROVIDER_ID = "auth-demo-bolt-tools-001";
const TOOL_ID = "auth-demo-tool-analyze-001";
const AGENT_ID = "mcp-demo-agent-001";
const AGENT_LABEL = "mcp-gateway-agent";
const CL_ID = "mcp-demo-cl-001";
const DEFAULT_LIMIT = BigInt(1_000_000_000); // $1.00

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
  process.stdout.write(`seed-mcp-demo

Slice 12a fixture seeder. Adds 1 AgentIdentity + 1 CreditLine to Demo Debtor
for the MCP Gateway demo. Tracker-managed; no delegation needed.

Flags:
  (no flags)              Seed with default limit $1.00 (10 allowed calls).
  --limit-amount <ns>     Override limit in nanoCredits (default 1_000_000_000).
                          Use 100000000 for the snappy 1-allowed-then-deny demo.
  --cleanup               FK-safe cleanup: revoke agent + revoke credit line.
                          Preserves audit history. Idempotent.
  --cleanup --hard        Also hard-delete the CreditLine (no FK refs).
                          AgentIdentity stays revoked (UsageEvent FK refs block deletion).
  --reset                 DESTRUCTIVE: delete every row in the MCP demo lane to
                          restore a fresh repeatable demo. Removes:
                            - UsageEvent rows for mcp-demo-agent-001
                            - ObligationUpdate rows for the
                              Demo Debtor ↔ Bolt Tools obligation lane
                            - the ObligationState (auto-created by /api/proxy)
                            - mcp-demo-agent-001 and mcp-demo-cl-001 themselves
                          Never touches canonical agents, providers, tools, or
                          any other customer/lane.
  --help, -h              Show this help.
`);
}

async function findDemoDebtor() {
  const dd = await prisma.customer.findFirst({
    where: { name: DEMO_DEBTOR_NAME },
    select: { id: true, name: true, signingMode: true, status: true, privateKey: true },
  });
  if (!dd) throw new Error(`Customer "${DEMO_DEBTOR_NAME}" not found in DB. The MCP demo requires this canonical fixture.`);
  if (dd.signingMode !== "tracker") throw new Error(`Demo Debtor signingMode is "${dd.signingMode}", expected "tracker".`);
  if (!dd.privateKey || dd.privateKey.length === 0) throw new Error("Demo Debtor.privateKey missing — tracker-managed signing will fail.");
  if (dd.status !== "active") throw new Error(`Demo Debtor status is "${dd.status}", expected "active".`);
  return dd;
}

async function ensureProviderAndTool() {
  const provider = await prisma.provider.findUnique({ where: { id: PROVIDER_ID }, select: { id: true, status: true, name: true } });
  if (!provider || provider.status !== "active") {
    throw new Error(`Provider ${PROVIDER_ID} not found or inactive. Run scripts/seed-authority-demo.ts first.`);
  }
  const tool = await prisma.tool.findUnique({ where: { id: TOOL_ID }, select: { id: true, status: true, providerId: true, costPerCall: true } });
  if (!tool || tool.status !== "active") {
    throw new Error(`Tool ${TOOL_ID} not found or inactive. Run scripts/seed-authority-demo.ts first.`);
  }
  if (tool.providerId !== PROVIDER_ID) {
    throw new Error(`Tool ${TOOL_ID} provider mismatch: expected ${PROVIDER_ID}, got ${tool.providerId}.`);
  }
  return { provider, tool };
}

async function doCleanup(hard: boolean) {
  const agent = await prisma.agentIdentity.findUnique({ where: { id: AGENT_ID }, select: { id: true, status: true } });
  const cl = await prisma.creditLine.findUnique({ where: { id: CL_ID }, select: { id: true, status: true } });

  let agentMsg = "(no mcp-demo-agent-001 found — nothing to revoke)";
  let clMsg = "(no mcp-demo-cl-001 found — nothing to revoke)";

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

  process.stdout.write(`[seed-mcp-demo] cleanup ${hard ? "(hard)" : "(soft)"}\n`);
  process.stdout.write(`  AgentIdentity:  ${agentMsg}\n`);
  process.stdout.write(`  CreditLine:     ${clMsg}\n`);

  if (hard && agent && agent.status !== "revoked") {
    process.stdout.write(`  NOTE: AgentIdentity hard-delete is blocked by UsageEvent FK refs (Restrict).\n`);
    process.stdout.write(`        The agent stays in revoked state. Audit history preserved.\n`);
  }
}

async function doReset() {
  // Resolve Demo Debtor without modifying it.
  const dd = await prisma.customer.findFirst({
    where: { name: DEMO_DEBTOR_NAME },
    select: { id: true },
  });
  if (!dd) {
    process.stdout.write(`[seed-mcp-demo] reset: Demo Debtor not found; nothing to reset.\n`);
    return;
  }

  // 1. Find the obligation state for this lane (Demo Debtor ↔ Bolt Tools).
  //    This lane was created by /api/proxy on the first MCP demo call; it is
  //    used exclusively by the MCP demo because canonical fixtures (Bolt Labs,
  //    auth-demo agents) target a different customer.
  const obl = await prisma.obligationState.findFirst({
    where: { customerId: dd.id, providerId: PROVIDER_ID },
    select: { id: true, currentAmount: true, pendingAmount: true, version: true },
  });

  let updatesDeleted = 0;
  let oblDeleted = false;
  if (obl) {
    // 2. Delete all ObligationUpdate rows for this lane.
    //    Restrict FK on ObligationUpdate.delegationId is moot in tracker mode
    //    (delegationId is always null for these rows). If any non-null
    //    delegationId showed up, this delete would still succeed because we
    //    are deleting the CHILD (ObligationUpdate), not the parent.
    const ouRes = await prisma.obligationUpdate.deleteMany({
      where: { obligationStateId: obl.id },
    });
    updatesDeleted = ouRes.count;

    // 3. Delete the ObligationState (now FK-clear of children).
    //    PendingRedemption + SettlementEvent FK to ObligationState are
    //    Restrict, but the MCP demo never creates either. Defensively check.
    const prCount = await prisma.pendingRedemption.count({ where: { obligationId: obl.id } });
    const seCount = await prisma.settlementEvent.count({ where: { obligationStateId: obl.id } });
    if (prCount > 0 || seCount > 0) {
      throw new Error(
        `Refusing to delete ObligationState ${obl.id}: ${prCount} PendingRedemption + ${seCount} SettlementEvent FK refs. ` +
          `These should not exist for a pure tracker-mode MCP demo lane. Investigate before retrying.`,
      );
    }
    await prisma.obligationState.delete({ where: { id: obl.id } });
    oblDeleted = true;
  }

  // 4. Delete UsageEvent rows for mcp-demo-agent-001 (was blocking AgentIdentity deletion).
  const ueRes = await prisma.usageEvent.deleteMany({
    where: { agentIdentityId: AGENT_ID },
  });

  // 5. Delete the AgentIdentity row (now FK-clear of UsageEvents and ObligationUpdates).
  //    Defensive check: any Delegation FK would block deletion. MCP demo
  //    creates none, but verify.
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

  // 6. Delete the CreditLine row (no incoming FK refs in schema).
  let clDeleted = false;
  const clExists = await prisma.creditLine.findUnique({ where: { id: CL_ID }, select: { id: true } });
  if (clExists) {
    await prisma.creditLine.delete({ where: { id: CL_ID } });
    clDeleted = true;
  }

  process.stdout.write(`[seed-mcp-demo] reset complete (MCP demo lane only)\n`);
  if (obl) {
    process.stdout.write(`  ObligationState ${obl.id}: deleted (was current=${obl.currentAmount.toString()}, pending=${obl.pendingAmount.toString()}, v=${obl.version})\n`);
    process.stdout.write(`  ObligationUpdate rows for that lane: ${updatesDeleted} deleted\n`);
  } else {
    process.stdout.write(`  ObligationState (Demo Debtor ↔ Bolt Tools): none — nothing to delete\n`);
  }
  process.stdout.write(`  UsageEvent rows for ${AGENT_ID}: ${ueRes.count} deleted\n`);
  process.stdout.write(`  AgentIdentity ${AGENT_ID}: ${agentDeleted ? "deleted" : "absent"}\n`);
  process.stdout.write(`  CreditLine ${CL_ID}: ${clDeleted ? "deleted" : "absent"}\n`);
  process.stdout.write(`\nNext: npx tsx scripts/seed-mcp-demo.ts --limit-amount 100000000\n`);

  // Mark unused vars as referenced for the linter
  void oblDeleted;
}

async function doSeed(limitAmount: bigint) {
  const dd = await findDemoDebtor();
  await ensureProviderAndTool();

  // Re-seed semantics (Tightening Issue 3)
  const existing = await prisma.agentIdentity.findUnique({
    where: { id: AGENT_ID },
    select: { id: true, status: true },
  });

  let rawKey: string | null = null;
  let agentAction: string;

  if (existing && existing.status === "active") {
    process.stderr.write(
      `[seed-mcp-demo] mcp-demo-agent-001 is already ACTIVE.\n` +
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

  // CreditLine: upsert with deterministic id
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
    clAction = `${CL_ID}: created (Demo Debtor ↔ Bolt Tools, limit=${limitAmount.toString()} nanoCredits)`;
  }

  process.stdout.write(`[seed-mcp-demo] seed complete\n`);
  process.stdout.write(`  Customer:       ${dd.id} (Demo Debtor, tracker-managed)\n`);
  process.stdout.write(`  Provider:       ${PROVIDER_ID} (Bolt Tools)\n`);
  process.stdout.write(`  Tool:           ${TOOL_ID} (analyze, $0.10/call)\n`);
  process.stdout.write(`  AgentIdentity:  ${agentAction}\n`);
  process.stdout.write(`  CreditLine:     ${clAction}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Raw API key (shown ONCE — copy to AGENT_TAB_AGENT_KEY env var; not recoverable):\n\n`);
  process.stdout.write(`  ${rawKey}\n\n`);
  process.stdout.write(`Quick env setup:\n`);
  process.stdout.write(`  export AGENT_TAB_BASE_URL=http://localhost:3000\n`);
  process.stdout.write(`  export AGENT_TAB_AGENT_KEY='${rawKey}'\n`);
  process.stdout.write(`  export AGENT_TAB_TOOL_ID=${TOOL_ID}\n`);
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
    process.stderr.write(`seed-mcp-demo failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
