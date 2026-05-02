/**
 * Trust-signal gate v0 — route-level proof.
 *
 * Proves the partner trust-signal gate at /api/delegations:
 *   - valid signal accepted (delegation created)
 *   - no signal still accepted (backward compat)
 *   - invalid signal rejected (no DB write)
 *   - unknown issuer rejected (no DB write)
 *   - malformed request rejected, both directions (no DB write)
 *
 * Self-contained: creates a minimal self-custody customer + agent inline,
 * runs the tests, cleans up. Uses the helper's built-in test-issuer-v0.
 *
 * Prerequisites:
 *   1. Agent Tab running on http://localhost:3000
 *
 * Run:
 *   cd agent-tab && npx tsx scripts/test-trust-signal-gate.ts
 */

import { PrismaClient } from "@prisma/client";
import { generateKeypair, signMessage } from "../src/lib/crypto";
import { buildDelegationMessage } from "../src/lib/tracker/delegation";
import { hashAgentApiKey } from "../src/lib/agent-key-hash";

const prisma = new PrismaClient();

const BASE = "http://localhost:3000";
const TEST_CUSTOMER_ID = "trust-signal-test-customer-v0";
const TEST_AGENT_ID = "trust-signal-test-agent-v0";

let passed = 0;
let failed = 0;

function pass(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? ` (${detail})` : ""}`);
  failed++;
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function setupFixture() {
  // Create a minimal self-custody customer + agent for the proof.
  const custKeys = generateKeypair();
  await prisma.customer.create({
    data: {
      id: TEST_CUSTOMER_ID,
      name: "Trust Signal Test Customer",
      publicKey: custKeys.publicKey,
      privateKey: "",
      signingMode: "self-custody",
    },
  });
  await prisma.agentIdentity.create({
    data: {
      id: TEST_AGENT_ID,
      customerId: TEST_CUSTOMER_ID,
      label: "trust-signal-test-agent",
      apiKey: "trust-signal-test-key-v0",
      apiKeyHash: hashAgentApiKey("trust-signal-test-key-v0"),
      apiKeyPreview: "…y-v0",
    },
  });
  return custKeys;
}

async function teardownFixture() {
  await prisma.delegation.deleteMany({ where: { customerId: TEST_CUSTOMER_ID } });
  await prisma.agentIdentity.deleteMany({ where: { id: TEST_AGENT_ID } });
  await prisma.customer.deleteMany({ where: { id: TEST_CUSTOMER_ID } });
}

async function buildDelegationBody(
  custKeys: { publicKey: string; privateKey: string },
  extra: Record<string, unknown> = {}
) {
  const session = generateKeypair();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const authMessage = buildDelegationMessage(
    custKeys.publicKey,
    TEST_AGENT_ID,
    session.publicKey,
    "*",
    "*",
    BigInt(5_000_000_000),
    expiresAt
  );
  const authSignature = await signMessage(authMessage, custKeys.privateKey);
  return {
    customerId: TEST_CUSTOMER_ID,
    agentIdentityId: TEST_AGENT_ID,
    sessionPubKey: session.publicKey,
    scopeProviderIds: "*",
    scopeToolIds: "*",
    spendCap: "5.0",
    expiresAt,
    authSignature,
    ...extra,
  };
}

async function delegationCount(): Promise<number> {
  return prisma.delegation.count({ where: { customerId: TEST_CUSTOMER_ID } });
}

async function main() {
  console.log("============================================");
  console.log("  Trust-Signal Gate v0 — Route-Level Proof");
  console.log("============================================\n");

  // Clean up any leftover state from prior runs
  await teardownFixture();

  let custKeys;
  try {
    custKeys = await setupFixture();
  } catch (e) {
    console.error("Setup failed:", (e as Error).message);
    process.exit(1);
  }

  try {
    // ============================================================
    // Test 1: Valid signal accepted, delegation created
    // ============================================================
    console.log("Test 1: Valid signal accepted");
    {
      const body = await buildDelegationBody(custKeys, {
        trustSignalIssuer: "test-issuer-v0",
        trustSignal: "valid-test-signal",
      });
      const { status, data } = await post(`${BASE}/api/delegations`, body);

      if (status === 201 && data.delegationId) {
        pass(`Delegation created (${data.delegationId.substring(0, 16)}...)`);
        // cleanup the created delegation
        await prisma.delegation.delete({ where: { id: data.delegationId } });
      } else {
        fail("Expected 201 created", `got ${status} ${data.error || ""}`);
      }
    }

    // ============================================================
    // Test 2: Backward compat — no signal still accepted
    // ============================================================
    console.log("\nTest 2: No signal (backward compat)");
    {
      const body = await buildDelegationBody(custKeys);
      const { status, data } = await post(`${BASE}/api/delegations`, body);

      if (status === 201 && data.delegationId) {
        pass("Delegation created without trust signal (backward compat)");
        await prisma.delegation.delete({ where: { id: data.delegationId } });
      } else {
        fail("Expected 201 created", `got ${status} ${data.error || ""}`);
      }
    }

    // ============================================================
    // Test 3: Invalid signal rejected
    // ============================================================
    console.log("\nTest 3: Invalid signal rejected");
    {
      const before = await delegationCount();
      const body = await buildDelegationBody(custKeys, {
        trustSignalIssuer: "test-issuer-v0",
        trustSignal: "wrong-signal",
      });
      const { status, data } = await post(`${BASE}/api/delegations`, body);

      if (status === 403 && data.code === "INVALID_SIGNAL") {
        pass("Rejected: 403 INVALID_SIGNAL");
      } else {
        fail("Expected 403 INVALID_SIGNAL", `got ${status} ${data.code || data.error}`);
      }

      const after = await delegationCount();
      if (after === before) {
        pass(`No mutation: delegation count unchanged (${before})`);
      } else {
        fail("Delegation count mutated", `${before} → ${after}`);
      }
    }

    // ============================================================
    // Test 4: Unknown issuer rejected
    // ============================================================
    console.log("\nTest 4: Unknown issuer rejected");
    {
      const before = await delegationCount();
      const body = await buildDelegationBody(custKeys, {
        trustSignalIssuer: "nonexistent-issuer",
        trustSignal: "any-value",
      });
      const { status, data } = await post(`${BASE}/api/delegations`, body);

      if (status === 400 && data.code === "UNKNOWN_ISSUER") {
        pass("Rejected: 400 UNKNOWN_ISSUER");
      } else {
        fail("Expected 400 UNKNOWN_ISSUER", `got ${status} ${data.code || data.error}`);
      }

      const after = await delegationCount();
      if (after === before) {
        pass(`No mutation: delegation count unchanged (${before})`);
      } else {
        fail("Delegation count mutated", `${before} → ${after}`);
      }
    }

    // ============================================================
    // Test 5: Malformed — issuer without signal
    // ============================================================
    console.log("\nTest 5: Malformed (issuer without signal)");
    {
      const before = await delegationCount();
      const body = await buildDelegationBody(custKeys, {
        trustSignalIssuer: "test-issuer-v0",
        // trustSignal omitted
      });
      const { status, data } = await post(`${BASE}/api/delegations`, body);

      if (status === 400 && data.code === "MALFORMED_REQUEST") {
        pass("Rejected: 400 MALFORMED_REQUEST");
      } else {
        fail("Expected 400 MALFORMED_REQUEST", `got ${status} ${data.code || data.error}`);
      }

      const after = await delegationCount();
      if (after === before) {
        pass(`No mutation: delegation count unchanged (${before})`);
      } else {
        fail("Delegation count mutated", `${before} → ${after}`);
      }
    }

    // ============================================================
    // Test 6: Malformed — signal without issuer
    // ============================================================
    console.log("\nTest 6: Malformed (signal without issuer)");
    {
      const before = await delegationCount();
      const body = await buildDelegationBody(custKeys, {
        trustSignal: "valid-test-signal",
        // trustSignalIssuer omitted
      });
      const { status, data } = await post(`${BASE}/api/delegations`, body);

      if (status === 400 && data.code === "MALFORMED_REQUEST") {
        pass("Rejected: 400 MALFORMED_REQUEST");
      } else {
        fail("Expected 400 MALFORMED_REQUEST", `got ${status} ${data.code || data.error}`);
      }

      const after = await delegationCount();
      if (after === before) {
        pass(`No mutation: delegation count unchanged (${before})`);
      } else {
        fail("Delegation count mutated", `${before} → ${after}`);
      }
    }
  } finally {
    await teardownFixture();
    await prisma.$disconnect();
  }

  console.log("\n============================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("============================================");

  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error("Fatal:", e.message);
  await teardownFixture();
  await prisma.$disconnect();
  process.exit(1);
});
