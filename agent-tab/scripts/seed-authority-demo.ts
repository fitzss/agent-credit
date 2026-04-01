/**
 * On-demand authority demo fixture.
 *
 * Creates a self-custody customer ("Bolt Labs") with an active reserve,
 * obligations, and two delegations (one active at ~75% cap, one expired)
 * so the Pool dashboard's Agent Authority section is populated.
 *
 * Does NOT touch the canonical tracker-managed fixture (Demo Debtor).
 *
 * Usage:
 *   cd agent-tab && npx tsx scripts/seed-authority-demo.ts
 *
 * Cleanup:
 *   npx tsx scripts/seed-authority-demo.ts --cleanup
 */

import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const prisma = new PrismaClient();

// Deterministic IDs so cleanup is easy and idempotent
const AUTHORITY_CUSTOMER_ID = "auth-demo-bolt-labs-001";
const AUTHORITY_RESERVE_ID = "auth-demo-reserve-001";
const AUTHORITY_DELEGATION_ACTIVE_ID = "auth-demo-deleg-active-001";
const AUTHORITY_DELEGATION_EXPIRED_ID = "auth-demo-deleg-expired-001";
const AUTHORITY_OBLIGATION_1_ID = "auth-demo-obl-toolsmith-001";
const AUTHORITY_OBLIGATION_2_ID = "auth-demo-obl-compute-001";
const AUTHORITY_AGENT_ID = "auth-demo-agent-001";

function generateKeypair() {
  const privKey = crypto.randomBytes(32).toString("hex");
  // Fake compressed pubkey (33 bytes, 02 prefix) — sufficient for DB/UI
  const pubKey = "02" + crypto.randomBytes(32).toString("hex");
  return { publicKey: pubKey, privateKey: privKey };
}

async function cleanup() {
  console.log("Cleaning up authority demo fixture...");

  await prisma.delegation.deleteMany({
    where: { id: { in: [AUTHORITY_DELEGATION_ACTIVE_ID, AUTHORITY_DELEGATION_EXPIRED_ID] } },
  });
  await prisma.obligationState.deleteMany({
    where: { id: { in: [AUTHORITY_OBLIGATION_1_ID, AUTHORITY_OBLIGATION_2_ID] } },
  });
  await prisma.agentIdentity.deleteMany({
    where: { id: AUTHORITY_AGENT_ID },
  });
  await prisma.reserve.deleteMany({
    where: { id: AUTHORITY_RESERVE_ID },
  });
  await prisma.customer.deleteMany({
    where: { id: AUTHORITY_CUSTOMER_ID },
  });

  console.log("Done. Authority demo records removed.");
  console.log("Canonical fixture is untouched.");
}

async function seed() {
  // Check if already seeded
  const existing = await prisma.customer.findUnique({ where: { id: AUTHORITY_CUSTOMER_ID } });
  if (existing) {
    console.log("Authority demo fixture already exists. Run with --cleanup to remove first.");
    return;
  }

  // Find existing providers to scope delegations to real provider IDs
  const providers = await prisma.provider.findMany({ take: 10 });
  if (providers.length === 0) {
    console.log("No providers found. Run the demo fixture setup or seed first.");
    return;
  }

  const provider1 = providers[0]; // e.g., DataMesh AI or ToolSmith AI
  const provider2 = providers.length > 1 ? providers[1] : providers[0];

  console.log(`Using providers: ${provider1.name}, ${provider2.name}`);

  // Create self-custody customer
  const custKeys = generateKeypair();
  const customer = await prisma.customer.create({
    data: {
      id: AUTHORITY_CUSTOMER_ID,
      name: "Bolt Labs",
      publicKey: custKeys.publicKey,
      privateKey: "", // empty = self-custody
      signingMode: "self-custody",
      contactEmail: "ops@boltlabs.io",
    },
  });
  console.log(`Created customer: ${customer.name} (${customer.id})`);

  // Create a reserve for this customer (DB-only, not on-chain)
  // This makes Bolt Labs appear in the /pool view
  const fakeTokenId = crypto.randomBytes(32).toString("hex");
  const fakeTrackerNftId = crypto.randomBytes(32).toString("hex");
  const reserve = await prisma.reserve.create({
    data: {
      id: AUTHORITY_RESERVE_ID,
      customerId: customer.id,
      debtorPubKey: custKeys.publicKey,
      reserveTokenId: fakeTokenId,
      trackerNftId: fakeTrackerNftId,
      valueNanoErg: BigInt(500_000_000), // 0.5 ERG
      contractVersion: "v2",
      lifecycle: "active",
    },
  });
  console.log(`Created reserve: ${reserve.id} (0.5 ERG, DB-only)`);

  // Create agent identity
  const agent = await prisma.agentIdentity.create({
    data: {
      id: AUTHORITY_AGENT_ID,
      customerId: customer.id,
      label: "auto-researcher",
      apiKey: "auth-demo-key-001",
    },
  });
  console.log(`Created agent: ${agent.label}`);

  // Create obligations
  await prisma.obligationState.create({
    data: {
      id: AUTHORITY_OBLIGATION_1_ID,
      providerId: provider1.id,
      customerId: customer.id,
      currentAmount: 0.08,
      debtorPubKey: custKeys.publicKey,
      creditorPubKey: provider1.publicKey,
      settlementStatus: "current",
    },
  });
  await prisma.obligationState.create({
    data: {
      id: AUTHORITY_OBLIGATION_2_ID,
      providerId: provider2.id,
      customerId: customer.id,
      currentAmount: 0.03,
      debtorPubKey: custKeys.publicKey,
      creditorPubKey: provider2.publicKey,
      settlementStatus: "current",
    },
  });
  console.log(`Created obligations: $0.08 (${provider1.name}), $0.03 (${provider2.name})`);

  // Delegation 1: Active, ~75% consumed
  const now = new Date();
  const sessionKeys1 = generateKeypair();
  const expiresAt1 = new Date(now.getTime() + 5 * 24 * 3600_000); // 5 days from now
  const authMsg1 = `agentab:delegate:v1|${custKeys.publicKey}|${sessionKeys1.publicKey}|${provider1.id}|*|20.00000000|${expiresAt1.toISOString()}`;

  await prisma.delegation.create({
    data: {
      id: AUTHORITY_DELEGATION_ACTIVE_ID,
      customerId: customer.id,
      sessionPubKey: sessionKeys1.publicKey,
      scopeProviderIds: provider1.id,
      scopeToolIds: "*",
      spendCap: 20.0,
      spentSoFar: 16.5, // 82.5% — triggers approaching-cap threshold (>=80%)
      expiresAt: expiresAt1,
      authMessage: authMsg1,
      authSignature: "demo-signature-not-verified",
      status: "active",
    },
  });
  console.log(`Created delegation: active, $16.50/$20 spent (82.5%), expires in 5 days`);

  // Delegation 2: Expired
  const sessionKeys2 = generateKeypair();
  const expiredAt = new Date(now.getTime() - 2 * 24 * 3600_000); // 2 days ago
  const authMsg2 = `agentab:delegate:v1|${custKeys.publicKey}|${sessionKeys2.publicKey}|*|*|10.00000000|${expiredAt.toISOString()}`;

  await prisma.delegation.create({
    data: {
      id: AUTHORITY_DELEGATION_EXPIRED_ID,
      customerId: customer.id,
      sessionPubKey: sessionKeys2.publicKey,
      scopeProviderIds: "*",
      scopeToolIds: "*",
      spendCap: 10.0,
      spentSoFar: 8.0,
      expiresAt: expiredAt,
      authMessage: authMsg2,
      authSignature: "demo-signature-not-verified",
      status: "expired",
    },
  });
  console.log(`Created delegation: expired, $8/$10 spent, expired 2 days ago`);

  console.log("");
  console.log("=== Authority demo fixture ready ===");
  console.log("");
  console.log("The /pool page will now show:");
  console.log("  - Demo Debtor reserve: tracker-managed (canonical fixture)");
  console.log("  - Bolt Labs reserve: delegated authority (this fixture)");
  console.log("    - 1 active delegation at 82% cap (Approaching Cap)");
  console.log("    - 1 expired delegation");
  console.log("");
  console.log("To remove: npx tsx scripts/seed-authority-demo.ts --cleanup");
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
