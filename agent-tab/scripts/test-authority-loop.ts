/**
 * End-to-end regression: delegated authority loop.
 *
 * Proves: create delegation → proxy call with session key → session-key
 * signing of pending update → spentSoFar increments by exact delta →
 * obligation balance increments by exact delta → pool dashboard reflects
 * updated state.
 *
 * Delta-based: captures before-state, performs one action, asserts exact
 * deltas. Safe to run repeatedly on accumulated state.
 *
 * Prerequisites:
 *   1. Agent Tab running on http://localhost:3000
 *   2. Authority demo fixture seeded:
 *      npx tsx scripts/seed-authority-demo.ts
 *
 * Run:
 *   cd agent-tab && npx tsx scripts/test-authority-loop.ts
 *
 * Relation to validate.sh:
 *   validate.sh tests the canonical settlement/guardrail harness (12 checks).
 *   This script tests the delegated authority loop (6 checks).
 *   Both should pass for a fully validated system.
 */

import { generateKeypair, signMessage } from "../src/lib/crypto";
import { buildDelegationMessage } from "../src/lib/tracker/delegation";
import { operatorCookieHeader } from "./lib/test-session";
import * as fs from "fs";
import * as path from "path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BASE = "http://localhost:3000";
const RESERVE_ID = "auth-demo-reserve-001";
const TOOL_ID = "auth-demo-tool-analyze-001";
const AGENT_ID = "auth-demo-agent-001";
const AGENT_KEY = "auth-demo-key-001";
const PROVIDER_ID = "auth-demo-bolt-tools-001";
const OBLIGATION_ID = "auth-demo-obl-001";
const ROOT_KEY_FILE = path.join(__dirname, "..", ".demo-state", "authority-demo-root.json");
const TOOL_COST = BigInt(100_000_000); // must match the tool's costPerCall in nanoCredits

let passed = 0;
let failed = 0;

function pass(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? ` (${detail})` : ""}`);
  failed++;
}

async function post(url: string, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function del(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(url: string, headers?: Record<string, string>) {
  const res = await fetch(url, { headers });
  return { status: res.status, data: await res.json() };
}

interface PoolObligation {
  id: string;
  currentAmount: string;
  providerName: string;
}

interface PoolDelegation {
  id: string;
  spentSoFar: string;
  spendCap: string;
  utilization: number;
  complianceState: string;
  agentLabel: string | null;
}

async function getPoolState(cookie: string) {
  const { data } = await get(
    `${BASE}/api/pool/summary?reserveId=${RESERVE_ID}`,
    { Cookie: cookie },
  );
  const obligation = data.obligations?.find((o: PoolObligation) => o.id === OBLIGATION_ID);
  return {
    obligationBalance: BigInt(obligation?.currentAmount ?? "0"),
    activeDelegations: data.authority?.summary?.activeDelegations ?? 0,
    authorityMode: data.authority?.summary?.authorityMode ?? "unknown",
    findDelegation: (id: string) =>
      data.authority?.delegations?.find((d: PoolDelegation) => d.id === id),
  };
}

async function main() {
  console.log("==========================================");
  console.log("  Delegated Authority Loop — Regression");
  console.log("==========================================\n");

  // --- Load root key ---
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

  // --- Capture before-state ---
  const before = await getPoolState(COOKIE);
  console.log("Before state:");
  console.log(`  Obligation balance: ${before.obligationBalance.toString()} nanoCredits`);
  console.log(`  Active delegations: ${before.activeDelegations}`);
  console.log(`  Authority mode: ${before.authorityMode}`);

  // --- Step 1: Create agent-bound delegation ---
  console.log("\nStep 1: Create agent-bound delegation ($5 cap, bound to auto-researcher, 24h)");

  const session = generateKeypair();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  const delegationMsg = buildDelegationMessage(
    rootPubKey, AGENT_ID, session.publicKey,
    PROVIDER_ID, "*", BigInt(5_000_000_000), expiresAt
  );
  const delegationSig = await signMessage(delegationMsg, rootPrivKey);

  const { status: createStatus, data: createData } = await post(`${BASE}/api/delegations`, {
    customerId: "auth-demo-bolt-labs-001",
    agentIdentityId: AGENT_ID,
    sessionPubKey: session.publicKey,
    scopeProviderIds: PROVIDER_ID,
    scopeToolIds: "*",
    spendCap: "5.0",
    expiresAt,
    authSignature: delegationSig,
  });

  if (createStatus === 201 && createData.delegationId && createData.agentIdentityId === AGENT_ID) {
    pass("Agent-bound delegation created (v2 format)");
  } else {
    fail("Create delegation", createData.error || `status ${createStatus}`);
    process.exit(1);
  }
  const delegationId = createData.delegationId;

  // Verify delegation count incremented
  const afterCreate = await getPoolState(COOKIE);
  if (afterCreate.activeDelegations === before.activeDelegations + 1) {
    pass(`Active delegations: ${before.activeDelegations} → ${afterCreate.activeDelegations}`);
  } else {
    fail("Delegation count delta", `expected +1, got ${before.activeDelegations} → ${afterCreate.activeDelegations}`);
  }

  // --- Step 2: Proxy call with session key ---
  console.log("\nStep 2: Proxy call with x-session-pubkey");

  const { status: proxyStatus, data: proxyData } = await post(
    `${BASE}/api/proxy`,
    { text: "The quick brown fox jumps over the lazy dog." },
    {
      "x-agent-api-key": AGENT_KEY,
      "x-tool-id": TOOL_ID,
      "x-session-pubkey": session.publicKey,
    }
  );

  if (proxyStatus === 200 && proxyData.tab?.pendingSignature === true) {
    pass("Proxy returned pendingSignature with canonicalMessage");
  } else {
    fail("Proxy call", proxyData.error || `status ${proxyStatus}`);
    await del(`${BASE}/api/delegations`, { id: delegationId });
    process.exit(1);
  }

  const obligationId = proxyData.tab.obligationId;
  const updateId = proxyData.tab.updateId;
  const canonicalMessage = proxyData.tab.canonicalMessage;
  const returnedDelegationId = proxyData.tab.delegationId;

  // --- Step 3: Sign with session key ---
  console.log("\nStep 3: Sign pending update with session private key");

  const sessionSig = await signMessage(canonicalMessage, session.privateKey);

  const { status: signStatus, data: signData } = await post(
    `${BASE}/api/obligations/${obligationId}/sign`,
    { signature: sessionSig, updateId, delegationId: returnedDelegationId }
  );

  if (signStatus === 200 && signData.verified === true && signData.delegated === true) {
    pass("Committed: verified=true, delegated=true");
  } else {
    fail("Sign commitment", signData.error || `verified=${signData.verified} delegated=${signData.delegated}`);
    await del(`${BASE}/api/delegations`, { id: delegationId });
    await prisma.$disconnect();
    process.exit(1);
  }

  // --- Step 3b: Verify agent binding on committed ObligationUpdate ---
  console.log("\nStep 3b: Verify agent binding persisted on ObligationUpdate");

  const committedUpdate = await prisma.obligationUpdate.findUnique({ where: { id: updateId } });
  if (committedUpdate && committedUpdate.agentIdentityId === AGENT_ID) {
    pass(`ObligationUpdate.agentIdentityId = ${AGENT_ID.substring(0, 20)}...`);
  } else {
    fail("Agent binding not persisted", `got ${committedUpdate?.agentIdentityId}`);
  }

  if (committedUpdate && committedUpdate.delegationId === delegationId) {
    pass(`ObligationUpdate.delegationId matches created delegation`);
  } else {
    fail("Delegation ID not persisted", `got ${committedUpdate?.delegationId}`);
  }

  // --- Step 4: Assert exact deltas ---
  console.log("\nStep 4: Verify exact deltas");

  const after = await getPoolState(COOKIE);
  const testDelegation = after.findDelegation(delegationId);

  // Delegation spentSoFar should be exactly TOOL_COST (fresh delegation, one call)
  const spentSoFar = BigInt(testDelegation?.spentSoFar ?? "0");
  if (testDelegation && spentSoFar === TOOL_COST) {
    pass(`Delegation spentSoFar: 0 → ${spentSoFar.toString()} (delta: +${TOOL_COST.toString()})`);
  } else {
    fail("Delegation spentSoFar delta", `expected ${TOOL_COST.toString()}, got ${spentSoFar.toString()}`);
  }

  // Obligation balance should have increased by exactly TOOL_COST
  const obligationDelta = after.obligationBalance - before.obligationBalance;
  if (obligationDelta === TOOL_COST) {
    pass(`Obligation balance: ${before.obligationBalance.toString()} → ${after.obligationBalance.toString()} (delta: +${obligationDelta.toString()})`);
  } else {
    fail("Obligation balance delta", `expected +${TOOL_COST.toString()}, got +${obligationDelta.toString()}`);
  }

  // Pool summary should show agent label on the delegation
  if (testDelegation && testDelegation.agentLabel === "auto-researcher") {
    pass("Pool summary: delegation has agentLabel = auto-researcher");
  } else {
    fail("Pool summary agentLabel", `got ${testDelegation?.agentLabel}`);
  }

  // --- Cleanup: revoke test delegation ---
  await del(`${BASE}/api/delegations`, { id: delegationId });
  await prisma.$disconnect();
  const afterCleanup = await getPoolState(COOKIE);

  console.log("\nAfter state (test delegation revoked):");
  console.log(`  Obligation balance: ${afterCleanup.obligationBalance.toString()} nanoCredits`);
  console.log(`  Active delegations: ${afterCleanup.activeDelegations}`);

  // --- Summary ---
  console.log("\n==========================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("==========================================");

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
