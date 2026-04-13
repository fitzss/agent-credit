/**
 * On-demand authority demo fixture — fully self-contained.
 *
 * Creates a complete delegated-authority setup independent of any other
 * fixture or seed data:
 *   - Customer: Bolt Labs (self-custody)
 *   - Provider: Bolt Tools (dedicated, with demo tool)
 *   - Credit line: Bolt Labs ↔ Bolt Tools ($50 limit)
 *   - Reserve: 0.5 ERG (DB-only, not on-chain)
 *   - Obligation: Bolt Labs → Bolt Tools
 *   - Delegations: 1 active (approaching cap), 1 expired
 *   - Agent identity for proxy calls
 *
 * Root private key is written to .demo-state/authority-demo-root.json
 * (repo-local, gitignored) for use by the test-authority-loop script.
 *
 * Usage:
 *   cd agent-tab && npx tsx scripts/seed-authority-demo.ts
 *
 * Cleanup:
 *   npx tsx scripts/seed-authority-demo.ts --cleanup
 */

import { PrismaClient } from "@prisma/client";
import { generateKeypair, signMessage } from "../src/lib/crypto";
import { buildDelegationMessage } from "../src/lib/tracker/delegation";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

// Deterministic IDs — all prefixed auth-demo- for easy identification
const IDS = {
  customer: "auth-demo-bolt-labs-001",
  reserve: "auth-demo-reserve-001",
  provider: "auth-demo-bolt-tools-001",
  tool: "auth-demo-tool-analyze-001",
  creditLine: "auth-demo-cl-001",
  obligation: "auth-demo-obl-001",
  delegationActive: "auth-demo-deleg-active-001",
  delegationExpired: "auth-demo-deleg-expired-001",
  agent1: "auth-demo-agent-001",
  agent2: "auth-demo-agent-002",
};

const DEMO_STATE_DIR = path.join(__dirname, "..", ".demo-state");
const ROOT_KEY_FILE = path.join(DEMO_STATE_DIR, "authority-demo-root.json");

async function cleanup() {
  console.log("Cleaning up authority demo fixture...");

  // Delete in FK-safe order: children before parents
  await prisma.delegation.deleteMany({ where: { customerId: IDS.customer } });
  await prisma.obligationUpdate.deleteMany({
    where: { obligationState: { customerId: IDS.customer } },
  });
  await prisma.settlementEvent.deleteMany({
    where: { obligationState: { customerId: IDS.customer } },
  });
  await prisma.pendingRedemption.deleteMany({ where: { reserveId: IDS.reserve } });
  await prisma.usageEvent.deleteMany({ where: { customerId: IDS.customer } });
  await prisma.obligationState.deleteMany({ where: { customerId: IDS.customer } });
  await prisma.creditLine.deleteMany({ where: { customerId: IDS.customer } });
  await prisma.agentIdentity.deleteMany({ where: { id: { in: [IDS.agent1, IDS.agent2] } } });
  await prisma.reserve.deleteMany({ where: { id: IDS.reserve } });
  await prisma.tool.deleteMany({ where: { providerId: IDS.provider } });
  await prisma.provider.deleteMany({ where: { id: IDS.provider } });
  await prisma.customer.deleteMany({ where: { id: IDS.customer } });

  // Clean demo state file
  if (fs.existsSync(ROOT_KEY_FILE)) fs.unlinkSync(ROOT_KEY_FILE);

  console.log("Done. Authority demo records removed.");
  console.log("Canonical fixture is untouched.");
}

async function seed() {
  const existing = await prisma.customer.findUnique({ where: { id: IDS.customer } });
  if (existing) {
    console.log("Authority demo fixture already exists. Run with --cleanup to remove first.");
    return;
  }

  // --- Dedicated provider + tool ---
  const provKeys = generateKeypair();
  const provider = await prisma.provider.create({
    data: {
      id: IDS.provider,
      name: "Bolt Tools",
      publicKey: provKeys.publicKey,
      privateKey: provKeys.privateKey,
    },
  });

  const tool = await prisma.tool.create({
    data: {
      id: IDS.tool,
      providerId: provider.id,
      name: "Text Analysis",
      description: "Analyze text (authority demo tool)",
      endpoint: "http://localhost:3000/api/demo-tool/analyze",
      costPerCall: BigInt(100_000_000),
    },
  });
  console.log(`Created provider: ${provider.name} (${provider.id})`);
  console.log(`Created tool: ${tool.name} (${tool.costPerCall.toString()} nanoCredits/call)`);

  // --- Self-custody customer with real keypair ---
  const custKeys = generateKeypair();
  const customer = await prisma.customer.create({
    data: {
      id: IDS.customer,
      name: "Bolt Labs",
      publicKey: custKeys.publicKey,
      privateKey: "", // empty = self-custody
      signingMode: "self-custody",
      contactEmail: "ops@boltlabs.io",
    },
  });
  console.log(`Created customer: ${customer.name} (self-custody)`);

  // Save root key to demo-local file (NOT in ~/.chaincash-secrets/)
  if (!fs.existsSync(DEMO_STATE_DIR)) fs.mkdirSync(DEMO_STATE_DIR, { recursive: true });
  fs.writeFileSync(ROOT_KEY_FILE, JSON.stringify({
    publicKey: custKeys.publicKey,
    privateKey: custKeys.privateKey,
    note: "Authority demo root key. Used by test-authority-loop.ts. Not a blockchain secret.",
  }, null, 2), { mode: 0o600 });
  console.log(`Saved root key to ${ROOT_KEY_FILE}`);

  // --- Reserve (DB-only) ---
  const fakeTokenId = crypto.randomBytes(32).toString("hex");
  const fakeTrackerNftId = crypto.randomBytes(32).toString("hex");
  await prisma.reserve.create({
    data: {
      id: IDS.reserve,
      customerId: customer.id,
      debtorPubKey: custKeys.publicKey,
      reserveTokenId: fakeTokenId,
      trackerNftId: fakeTrackerNftId,
      valueNanoErg: BigInt(500_000_000),
      contractVersion: "v2",
      lifecycle: "active",
    },
  });
  console.log(`Created reserve: 0.5 ERG (DB-only)`);

  // --- Credit line ---
  await prisma.creditLine.create({
    data: {
      id: IDS.creditLine,
      providerId: provider.id,
      customerId: customer.id,
      limitAmount: BigInt(50_000_000_000),
      alertThreshold: 0.8,
    },
  });
  console.log(`Created credit line: Bolt Labs ↔ Bolt Tools ($50 limit)`);

  // --- Agent identities ---
  await prisma.agentIdentity.create({
    data: {
      id: IDS.agent1,
      customerId: customer.id,
      label: "auto-researcher",
      apiKey: "auth-demo-key-001",
    },
  });
  await prisma.agentIdentity.create({
    data: {
      id: IDS.agent2,
      customerId: customer.id,
      label: "ops-monitor",
      apiKey: "auth-demo-key-002",
    },
  });
  console.log(`Created agents: auto-researcher (key-001), ops-monitor (key-002)`);

  // --- Obligation ---
  await prisma.obligationState.create({
    data: {
      id: IDS.obligation,
      providerId: provider.id,
      customerId: customer.id,
      currentAmount: BigInt(0),
      debtorPubKey: custKeys.publicKey,
      creditorPubKey: provKeys.publicKey,
      settlementStatus: "current",
    },
  });
  console.log(`Created obligation: Bolt Labs → Bolt Tools ($0)`);

  // --- Delegation 1: Active, approaching cap, bound to agent-001 ---
  const now = new Date();
  const sessionKeys1 = generateKeypair();
  const expiresAt1 = new Date(now.getTime() + 5 * 24 * 3600_000);
  const authMsg1 = buildDelegationMessage(
    custKeys.publicKey, IDS.agent1, sessionKeys1.publicKey,
    provider.id, "*", BigInt(20_000_000_000), expiresAt1.toISOString()
  );
  const authSig1 = await signMessage(authMsg1, custKeys.privateKey);

  await prisma.delegation.create({
    data: {
      id: IDS.delegationActive,
      customerId: customer.id,
      agentIdentityId: IDS.agent1,
      sessionPubKey: sessionKeys1.publicKey,
      scopeProviderIds: provider.id,
      scopeToolIds: "*",
      spendCap: BigInt(20_000_000_000),
      spentSoFar: BigInt(16_500_000_000),
      expiresAt: expiresAt1,
      authMessage: authMsg1,
      authSignature: authSig1,
      status: "active",
    },
  });
  console.log(`Created delegation: active, bound to auto-researcher, $16.50/$20 (82.5%)`);

  // --- Delegation 2: Expired, bound to agent-001 ---
  const sessionKeys2 = generateKeypair();
  const expiredAt = new Date(now.getTime() - 2 * 24 * 3600_000);
  const authMsg2 = buildDelegationMessage(
    custKeys.publicKey, IDS.agent1, sessionKeys2.publicKey,
    "*", "*", BigInt(10_000_000_000), expiredAt.toISOString()
  );
  const authSig2 = await signMessage(authMsg2, custKeys.privateKey);

  await prisma.delegation.create({
    data: {
      id: IDS.delegationExpired,
      customerId: customer.id,
      agentIdentityId: IDS.agent1,
      sessionPubKey: sessionKeys2.publicKey,
      scopeProviderIds: "*",
      scopeToolIds: "*",
      spendCap: BigInt(10_000_000_000),
      spentSoFar: BigInt(8_000_000_000),
      expiresAt: expiredAt,
      authMessage: authMsg2,
      authSignature: authSig2,
      status: "expired",
    },
  });
  console.log(`Created delegation: expired, bound to auto-researcher, $8/$10`);

  console.log("");
  console.log("=== Authority demo fixture ready ===");
  console.log("");
  console.log("Pool dashboard (/pool) will show:");
  console.log("  - Demo Debtor: tracker-managed (canonical)");
  console.log("  - Bolt Labs: delegated authority (this fixture)");
  console.log("");
  console.log("Run the full authority loop test:");
  console.log("  npx tsx scripts/test-authority-loop.ts");
  console.log("");
  console.log("Cleanup:");
  console.log("  npx tsx scripts/seed-authority-demo.ts --cleanup");
}

async function main() {
  try {
    if (process.argv.includes("--cleanup")) {
      await cleanup();
    } else {
      await seed();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
