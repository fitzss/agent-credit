/**
 * Negative-path regression: delegated authority guardrails.
 *
 * Proves that the system rejects invalid delegated-authority attempts
 * WITHOUT advancing commercial state. Each test:
 *   1. Captures before-state (obligation balance, delegation spentSoFar)
 *   2. Creates a flawed delegation and attempts a proxy call
 *   3. Asserts HTTP 409 with expected error code
 *   4. Asserts obligation balance and delegation spend are unchanged
 *   5. Cleans up
 *
 * Prerequisites:
 *   1. Agent Tab running on http://localhost:3000
 *   2. Authority demo fixture seeded:
 *      npx tsx scripts/seed-authority-demo.ts
 *
 * Run:
 *   cd agent-tab && npx tsx scripts/test-authority-guardrails.ts
 *
 * Relation to other regressions:
 *   validate.sh              — 12 checks, canonical settlement guardrails
 *   test-authority-loop.ts   — 6 checks, positive delegated authority loop
 *   test-authority-guardrails — 4 checks, negative delegated authority rejection
 */

import { PrismaClient } from "@prisma/client";
import { generateKeypair, signMessage } from "../src/lib/crypto";
import { buildDelegationMessage } from "../src/lib/tracker/delegation";
import { operatorCookieHeader } from "./lib/test-session";

const AGENT_1_ID = "auth-demo-agent-001";
const AGENT_2_ID = "auth-demo-agent-002";
const AGENT_2_KEY = "auth-demo-key-002";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

const BASE = "http://localhost:3000";
const RESERVE_ID = "auth-demo-reserve-001";
const TOOL_ID = "auth-demo-tool-analyze-001";
const AGENT_KEY = "auth-demo-key-001";
const PROVIDER_ID = "auth-demo-bolt-tools-001";
const CUSTOMER_ID = "auth-demo-bolt-labs-001";
const OBLIGATION_ID = "auth-demo-obl-001";
const ROOT_KEY_FILE = path.join(__dirname, "..", ".demo-state", "authority-demo-root.json");

let passed = 0;
let failed = 0;

function pass(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? ` (${detail})` : ""}`);
  failed++;
}

async function proxyCall(sessionPubKey: string, agentKey: string = AGENT_KEY) {
  const res = await fetch(`${BASE}/api/proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-api-key": agentKey,
      "x-tool-id": TOOL_ID,
      "x-session-pubkey": sessionPubKey,
    },
    body: JSON.stringify({ text: "guardrail test" }),
  });
  return { status: res.status, data: await res.json() };
}

async function getObligationBalance(): Promise<bigint> {
  const obl = await prisma.obligationState.findUnique({ where: { id: OBLIGATION_ID } });
  return obl?.currentAmount ?? BigInt(0);
}

async function cleanupDelegation(id: string) {
  await prisma.delegation.deleteMany({ where: { id } });
}

async function main() {
  console.log("=============================================");
  console.log("  Authority Guardrails — Negative Regression");
  console.log("=============================================\n");

  if (!fs.existsSync(ROOT_KEY_FILE)) {
    console.log("Root key not found. Run: npx tsx scripts/seed-authority-demo.ts");
    process.exit(1);
  }
  const rootKeyData = JSON.parse(fs.readFileSync(ROOT_KEY_FILE, "utf-8"));
  const rootPubKey: string = rootKeyData.publicKey;
  const rootPrivKey: string = rootKeyData.privateKey;

  // Slice 3: /api/pool/summary now requires a session. Mint an operator
  // cookie locally; same JWT shape a real magic-link login produces.
  const COOKIE = await operatorCookieHeader(prisma);

  // ================================================================
  // Test 1: Wrong provider scope
  // ================================================================
  console.log("Test 1: Wrong provider scope");
  {
    const testId = "auth-guard-wrong-scope";
    const session = generateKeypair();
    const balanceBefore = await getObligationBalance();

    try {
      await prisma.delegation.create({
        data: {
          id: testId,
          customerId: CUSTOMER_ID,
          sessionPubKey: session.publicKey,
          scopeProviderIds: "nonexistent-provider-00000000",
          scopeToolIds: "*",
          spendCap: BigInt(50_000_000_000),
          expiresAt: new Date(Date.now() + 3600_000),
          authMessage: "test-only",
          authSignature: "test-only",
          status: "active",
        },
      });

      const { status, data } = await proxyCall(session.publicKey);

      if (status === 409 && data.code === "DELEGATION_SCOPE_VIOLATED") {
        pass("Rejected: 409 DELEGATION_SCOPE_VIOLATED");
      } else {
        fail("Expected 409 DELEGATION_SCOPE_VIOLATED", `got ${status} ${data.code || data.error}`);
      }

      const balanceAfter = await getObligationBalance();
      if (balanceAfter === balanceBefore) {
        pass(`No mutation: obligation balance unchanged (${balanceBefore.toString()})`);
      } else {
        fail("Obligation mutated on rejection", `${balanceBefore.toString()} → ${balanceAfter.toString()}`);
      }
    } finally {
      await cleanupDelegation(testId);
    }
  }

  // ================================================================
  // Test 2: Expired delegation
  // ================================================================
  console.log("\nTest 2: Expired delegation");
  {
    const testId = "auth-guard-expired";
    const session = generateKeypair();
    const balanceBefore = await getObligationBalance();

    try {
      await prisma.delegation.create({
        data: {
          id: testId,
          customerId: CUSTOMER_ID,
          sessionPubKey: session.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: BigInt(50_000_000_000),
          expiresAt: new Date(Date.now() - 3600_000), // 1 hour ago
          authMessage: "test-only",
          authSignature: "test-only",
          status: "active", // still "active" in DB — runtime expiry check
        },
      });

      const { status, data } = await proxyCall(session.publicKey);

      if (status === 409 && data.code === "DELEGATION_SCOPE_VIOLATED") {
        pass("Rejected: 409 DELEGATION_SCOPE_VIOLATED (expired)");
      } else {
        fail("Expected 409 DELEGATION_SCOPE_VIOLATED", `got ${status} ${data.code || data.error}`);
      }

      const balanceAfter = await getObligationBalance();
      if (balanceAfter === balanceBefore) {
        pass(`No mutation: obligation balance unchanged (${balanceBefore.toString()})`);
      } else {
        fail("Obligation mutated on rejection", `${balanceBefore.toString()} → ${balanceAfter.toString()}`);
      }

      // Also verify the delegation's spentSoFar was not touched
      const del = await prisma.delegation.findUnique({ where: { id: testId } });
      if (del && del.spentSoFar === BigInt(0)) {
        pass("No mutation: delegation spentSoFar unchanged (0)");
      } else {
        fail("Delegation spentSoFar mutated", `got ${del?.spentSoFar?.toString()}`);
      }
    } finally {
      await cleanupDelegation(testId);
    }
  }

  // ================================================================
  // Test 3: Exceeded spend cap
  // ================================================================
  console.log("\nTest 3: Exceeded spend cap");
  {
    const testId = "auth-guard-cap-exceeded";
    const session = generateKeypair();
    const balanceBefore = await getObligationBalance();

    try {
      await prisma.delegation.create({
        data: {
          id: testId,
          customerId: CUSTOMER_ID,
          sessionPubKey: session.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: BigInt(50_000_000), // tool costs 100M nanoCredits — exceeds cap
          spentSoFar: BigInt(0),
          expiresAt: new Date(Date.now() + 3600_000),
          authMessage: "test-only",
          authSignature: "test-only",
          status: "active",
        },
      });

      const { status, data } = await proxyCall(session.publicKey);

      if (status === 409 && data.code === "DELEGATION_SCOPE_VIOLATED") {
        pass("Rejected: 409 DELEGATION_SCOPE_VIOLATED (cap exceeded)");
      } else {
        fail("Expected 409 DELEGATION_SCOPE_VIOLATED", `got ${status} ${data.code || data.error}`);
      }

      const balanceAfter = await getObligationBalance();
      if (balanceAfter === balanceBefore) {
        pass(`No mutation: obligation balance unchanged (${balanceBefore.toString()})`);
      } else {
        fail("Obligation mutated on rejection", `${balanceBefore.toString()} → ${balanceAfter.toString()}`);
      }

      const del = await prisma.delegation.findUnique({ where: { id: testId } });
      if (del && del.spentSoFar === BigInt(0)) {
        pass("No mutation: delegation spentSoFar unchanged (0)");
      } else {
        fail("Delegation spentSoFar mutated", `got ${del?.spentSoFar?.toString()}`);
      }
    } finally {
      await cleanupDelegation(testId);
    }
  }

  // ================================================================
  // Test 4: Revoked delegation
  // ================================================================
  console.log("\nTest 4: Revoked delegation");
  {
    const session = generateKeypair();
    const balanceBefore = await getObligationBalance();
    let delegationId = "";

    try {
      // Create via API (valid signature, agent-bound) then revoke
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const authMsg = buildDelegationMessage(
        rootPubKey, AGENT_1_ID, session.publicKey, PROVIDER_ID, "*", BigInt(50_000_000_000), expiresAt
      );
      const authSig = await signMessage(authMsg, rootPrivKey);

      const createRes = await fetch(`${BASE}/api/delegations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: COOKIE },
        body: JSON.stringify({
          customerId: CUSTOMER_ID,
          agentIdentityId: AGENT_1_ID,
          sessionPubKey: session.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: "50.0",
          expiresAt,
          authSignature: authSig,
        }),
      });
      const createData = await createRes.json();
      delegationId = createData.delegationId;

      // Revoke it
      await fetch(`${BASE}/api/delegations`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: COOKIE },
        body: JSON.stringify({ id: delegationId }),
      });

      // Attempt proxy call with revoked delegation's session key
      const { status, data } = await proxyCall(session.publicKey);

      if (status === 409 && data.code === "DELEGATION_NOT_FOUND") {
        pass("Rejected: 409 DELEGATION_NOT_FOUND (revoked)");
      } else {
        fail("Expected 409 DELEGATION_NOT_FOUND", `got ${status} ${data.code || data.error}`);
      }

      const balanceAfter = await getObligationBalance();
      if (balanceAfter === balanceBefore) {
        pass(`No mutation: obligation balance unchanged (${balanceBefore.toString()})`);
      } else {
        fail("Obligation mutated on rejection", `${balanceBefore.toString()} → ${balanceAfter.toString()}`);
      }
    } finally {
      if (delegationId) await cleanupDelegation(delegationId);
    }
  }

  // ================================================================
  // Test 5: Wrong agent, same customer
  // ================================================================
  console.log("\nTest 5: Wrong agent (agent-002 uses agent-001's delegation)");
  {
    const testId = "auth-guard-wrong-agent";
    const session = generateKeypair();
    const balanceBefore = await getObligationBalance();

    try {
      // Create delegation bound to agent-001
      await prisma.delegation.create({
        data: {
          id: testId,
          customerId: CUSTOMER_ID,
          agentIdentityId: AGENT_1_ID,
          sessionPubKey: session.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: BigInt(50_000_000_000),
          expiresAt: new Date(Date.now() + 3600_000),
          authMessage: "test-only",
          authSignature: "test-only",
          status: "active",
        },
      });

      // Proxy call with agent-002's API key but agent-001's delegation session key
      const { status, data } = await proxyCall(session.publicKey, AGENT_2_KEY);

      if (status === 409 && data.code === "AGENT_DELEGATION_MISMATCH") {
        pass("Rejected: 409 AGENT_DELEGATION_MISMATCH");
      } else {
        fail("Expected 409 AGENT_DELEGATION_MISMATCH", `got ${status} ${data.code || data.error}`);
      }

      const balanceAfter = await getObligationBalance();
      if (balanceAfter === balanceBefore) {
        pass(`No mutation: obligation balance unchanged (${balanceBefore.toString()})`);
      } else {
        fail("Obligation mutated on rejection", `${balanceBefore.toString()} → ${balanceAfter.toString()}`);
      }

      const del = await prisma.delegation.findUnique({ where: { id: testId } });
      if (del && del.spentSoFar === BigInt(0)) {
        pass("No mutation: delegation spentSoFar unchanged (0)");
      } else {
        fail("Delegation spentSoFar mutated", `got ${del?.spentSoFar?.toString()}`);
      }
    } finally {
      await cleanupDelegation(testId);
    }
  }

  // ================================================================
  // Test 6: Delegation creation for foreign agent
  // ================================================================
  console.log("\nTest 6: Create delegation for foreign-customer agent");
  {
    try {
      const session = generateKeypair();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const authMsg = buildDelegationMessage(
        rootPubKey, "nonexistent-agent-id", session.publicKey, PROVIDER_ID, "*", BigInt(50_000_000_000), expiresAt
      );
      const authSig = await signMessage(authMsg, rootPrivKey);

      const res = await fetch(`${BASE}/api/delegations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: COOKIE },
        body: JSON.stringify({
          customerId: CUSTOMER_ID,
          agentIdentityId: "nonexistent-agent-id",
          sessionPubKey: session.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: "50.0",
          expiresAt,
          authSignature: authSig,
        }),
      });

      if (res.status === 400) {
        pass("Rejected: 400 (agent not found or foreign)");
      } else {
        fail("Expected 400 rejection", `got ${res.status}`);
      }
    } catch (e) {
      fail("Unexpected error", (e as Error).message);
    }
  }

  // ================================================================
  // Test 7: Mismatched commit path (cross-delegation)
  // ================================================================
  console.log("\nTest 7: Cross-delegation commit (D1 initiates, commit with D2)");
  {
    const testD1 = "auth-guard-cross-d1";
    const testD2 = "auth-guard-cross-d2";
    const session1 = generateKeypair();
    const session2 = generateKeypair();
    const balanceBefore = await getObligationBalance();

    try {
      // D1 bound to agent-001
      await prisma.delegation.create({
        data: {
          id: testD1,
          customerId: CUSTOMER_ID,
          agentIdentityId: AGENT_1_ID,
          sessionPubKey: session1.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: BigInt(50_000_000_000),
          expiresAt: new Date(Date.now() + 3600_000),
          authMessage: "test-only",
          authSignature: "test-only",
          status: "active",
        },
      });

      // D2 bound to agent-002
      await prisma.delegation.create({
        data: {
          id: testD2,
          customerId: CUSTOMER_ID,
          agentIdentityId: AGENT_2_ID,
          sessionPubKey: session2.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: BigInt(50_000_000_000),
          expiresAt: new Date(Date.now() + 3600_000),
          authMessage: "test-only",
          authSignature: "test-only",
          status: "active",
        },
      });

      // Proxy call with agent-001 using D1's session key (should succeed as pending)
      const { status: proxyStatus, data: proxyData } = await proxyCall(session1.publicKey, AGENT_KEY);

      if (proxyStatus !== 200 || !proxyData.tab?.pendingSignature) {
        fail("Proxy call should have succeeded with pending", `got ${proxyStatus}`);
      } else {
        // Attempt to commit using D2's delegationId (D2 is bound to agent-002, update has agent-001)
        const sessionSig = await signMessage(proxyData.tab.canonicalMessage, session1.privateKey);
        const signRes = await fetch(`${BASE}/api/obligations/${proxyData.tab.obligationId}/sign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signature: sessionSig,
            updateId: proxyData.tab.updateId,
            delegationId: testD2, // D2 is bound to agent-002, but update was initiated by agent-001
          }),
        });
        const signData = await signRes.json();

        // Rejection may come as AGENT_DELEGATION_MISMATCH (409) or SIGNATURE_INVALID (403)
        // depending on check ordering. Both prove the cross-delegation commit is blocked.
        if (signRes.status >= 400) {
          pass(`Rejected: ${signRes.status} ${signData.code || signData.error}`);
        } else {
          fail("Expected rejection for cross-delegation commit", `got ${signRes.status}`);
        }
      }

      const balanceAfter = await getObligationBalance();
      if (balanceAfter === balanceBefore) {
        pass(`No mutation: obligation balance unchanged (${balanceBefore.toString()})`);
      } else {
        fail("Obligation mutated", `${balanceBefore.toString()} → ${balanceAfter.toString()}`);
      }
    } finally {
      await cleanupDelegation(testD1);
      await cleanupDelegation(testD2);
    }
  }

  // ================================================================
  // Test 8: Legacy/unbound delegation backward compatibility
  // ================================================================
  console.log("\nTest 8: Legacy unbound delegation (backward compat)");
  {
    const testId = "auth-guard-legacy";
    const session = generateKeypair();

    try {
      // Create unbound delegation (agentIdentityId = null)
      await prisma.delegation.create({
        data: {
          id: testId,
          customerId: CUSTOMER_ID,
          agentIdentityId: null,
          sessionPubKey: session.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: BigInt(50_000_000_000),
          expiresAt: new Date(Date.now() + 3600_000),
          authMessage: "legacy-test",
          authSignature: "legacy-test",
          status: "active",
        },
      });

      // Proxy call with agent-001 should succeed (unbound = any agent)
      const { status, data } = await proxyCall(session.publicKey, AGENT_KEY);

      if (status === 200 && data.tab?.pendingSignature === true) {
        pass("Legacy delegation accepted by any agent (pendingSignature)");
      } else if (status === 200) {
        pass("Legacy delegation accepted by any agent");
      } else {
        fail("Expected legacy delegation to work", `got ${status} ${data.error || ""}`);
      }

      // Check pool summary labels it as unbound
      const poolRes = await fetch(
        `${BASE}/api/pool/summary?reserveId=${RESERVE_ID}`,
        { headers: { Cookie: COOKIE } },
      );
      const poolData = await poolRes.json();
      const legacyDel = poolData.authority?.delegations?.find(
        (d: { id: string }) => d.id === testId
      );
      if (legacyDel && legacyDel.agentLabel === null) {
        pass("Pool summary: delegation has null agentLabel (unbound)");
      } else {
        fail("Expected null agentLabel for legacy", `got ${legacyDel?.agentLabel}`);
      }
    } finally {
      await cleanupDelegation(testId);
    }
  }

  // ================================================================
  // Summary
  // ================================================================
  await prisma.$disconnect();

  console.log("\n=============================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("=============================================");

  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error("Fatal:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
