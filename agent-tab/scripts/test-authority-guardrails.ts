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
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

const BASE = "http://localhost:3000";
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

async function proxyCall(sessionPubKey: string) {
  const res = await fetch(`${BASE}/api/proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-api-key": AGENT_KEY,
      "x-tool-id": TOOL_ID,
      "x-session-pubkey": sessionPubKey,
    },
    body: JSON.stringify({ text: "guardrail test" }),
  });
  return { status: res.status, data: await res.json() };
}

async function getObligationBalance(): Promise<number> {
  const obl = await prisma.obligationState.findUnique({ where: { id: OBLIGATION_ID } });
  return obl?.currentAmount ?? 0;
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
          spendCap: 50.0,
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
        pass(`No mutation: obligation balance unchanged ($${balanceBefore.toFixed(2)})`);
      } else {
        fail("Obligation mutated on rejection", `$${balanceBefore.toFixed(2)} → $${balanceAfter.toFixed(2)}`);
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
          spendCap: 50.0,
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
        pass(`No mutation: obligation balance unchanged ($${balanceBefore.toFixed(2)})`);
      } else {
        fail("Obligation mutated on rejection", `$${balanceBefore.toFixed(2)} → $${balanceAfter.toFixed(2)}`);
      }

      // Also verify the delegation's spentSoFar was not touched
      const del = await prisma.delegation.findUnique({ where: { id: testId } });
      if (del && del.spentSoFar === 0) {
        pass("No mutation: delegation spentSoFar unchanged ($0.00)");
      } else {
        fail("Delegation spentSoFar mutated", `got $${del?.spentSoFar?.toFixed(2)}`);
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
          spendCap: 0.05, // tool costs $0.10 — exceeds cap
          spentSoFar: 0,
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
        pass(`No mutation: obligation balance unchanged ($${balanceBefore.toFixed(2)})`);
      } else {
        fail("Obligation mutated on rejection", `$${balanceBefore.toFixed(2)} → $${balanceAfter.toFixed(2)}`);
      }

      const del = await prisma.delegation.findUnique({ where: { id: testId } });
      if (del && del.spentSoFar === 0) {
        pass("No mutation: delegation spentSoFar unchanged ($0.00)");
      } else {
        fail("Delegation spentSoFar mutated", `got $${del?.spentSoFar?.toFixed(2)}`);
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
      // Create via API (valid signature) then revoke
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const authMsg = buildDelegationMessage(
        rootPubKey, session.publicKey, PROVIDER_ID, "*", 50.0, expiresAt
      );
      const authSig = await signMessage(authMsg, rootPrivKey);

      const createRes = await fetch(`${BASE}/api/delegations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: CUSTOMER_ID,
          sessionPubKey: session.publicKey,
          scopeProviderIds: PROVIDER_ID,
          scopeToolIds: "*",
          spendCap: 50.0,
          expiresAt,
          authSignature: authSig,
        }),
      });
      const createData = await createRes.json();
      delegationId = createData.delegationId;

      // Revoke it
      await fetch(`${BASE}/api/delegations`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
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
        pass(`No mutation: obligation balance unchanged ($${balanceBefore.toFixed(2)})`);
      } else {
        fail("Obligation mutated on rejection", `$${balanceBefore.toFixed(2)} → $${balanceAfter.toFixed(2)}`);
      }
    } finally {
      if (delegationId) await cleanupDelegation(delegationId);
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
