/**
 * End-to-end proof: delegated authority loop.
 *
 * Proves: create delegation → proxy call with session key → session-key
 * signing of pending update → spentSoFar increment → pool dashboard
 * reflects updated utilization.
 *
 * Prerequisites:
 *   1. Agent Tab running on http://localhost:3000
 *   2. Authority demo fixture seeded:
 *      npx tsx scripts/seed-authority-demo.ts
 *
 * Run:
 *   cd agent-tab && npx tsx scripts/test-authority-loop.ts
 *
 * What it proves:
 *   - The full delegated authority chain works end-to-end
 *   - Delegation scope is validated by the tracker
 *   - Session key signatures are verified on commitment
 *   - Delegation spend cap decrements correctly
 *   - The pool summary API reflects the updated state
 */

import { generateKeypair, signMessage } from "../src/lib/crypto";
import { buildDelegationMessage } from "../src/lib/tracker/delegation";
import * as fs from "fs";
import * as path from "path";

const BASE = "http://localhost:3000";
const RESERVE_ID = "auth-demo-reserve-001";
const TOOL_ID = "auth-demo-tool-analyze-001";
const AGENT_KEY = "auth-demo-key-001";
const PROVIDER_ID = "auth-demo-bolt-tools-001";
const ROOT_KEY_FILE = path.join(__dirname, "..", ".demo-state", "authority-demo-root.json");

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

async function get(url: string) {
  const res = await fetch(url);
  return { status: res.status, data: await res.json() };
}

async function main() {
  console.log("========================================");
  console.log("  Delegated Authority Loop — E2E Proof");
  console.log("========================================\n");

  // --- Load root key ---
  if (!fs.existsSync(ROOT_KEY_FILE)) {
    console.log("Root key file not found. Run: npx tsx scripts/seed-authority-demo.ts");
    process.exit(1);
  }
  const rootKeyData = JSON.parse(fs.readFileSync(ROOT_KEY_FILE, "utf-8"));
  const rootPubKey: string = rootKeyData.publicKey;
  const rootPrivKey: string = rootKeyData.privateKey;
  console.log(`Root key loaded: ${rootPubKey.substring(0, 16)}...`);

  // --- Step 1: Create delegation via API ---
  console.log("\nStep 1: Create delegation");

  const session = generateKeypair();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString(); // 24h
  const delegationMsg = buildDelegationMessage(
    rootPubKey, session.publicKey,
    PROVIDER_ID, "*", 5.0, expiresAt
  );
  const delegationSig = await signMessage(delegationMsg, rootPrivKey);

  const { status: createStatus, data: createData } = await post(`${BASE}/api/delegations`, {
    customerId: "auth-demo-bolt-labs-001",
    sessionPubKey: session.publicKey,
    scopeProviderIds: PROVIDER_ID,
    scopeToolIds: "*",
    spendCap: 5.0,
    expiresAt,
    authSignature: delegationSig,
  });

  if (createStatus === 201 && createData.delegationId) {
    pass(`Delegation created: ${createData.delegationId.substring(0, 16)}...`);
  } else {
    fail("Create delegation", createData.error || `status ${createStatus}`);
    console.log("\nAborting — cannot continue without delegation.");
    process.exit(1);
  }
  const delegationId = createData.delegationId;

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
    pass("Proxy returned pending signature");
  } else if (proxyStatus === 200 && proxyData.tab) {
    // Tracker-managed path — still valid but different
    pass(`Proxy succeeded (tracker-managed path, balance: ${proxyData.tab.balance})`);
  } else {
    fail("Proxy call", proxyData.error || `status ${proxyStatus}`);
    console.log("  Response:", JSON.stringify(proxyData).substring(0, 200));
    // Clean up delegation before exit
    await del(`${BASE}/api/delegations`, { id: delegationId });
    process.exit(1);
  }

  // --- Step 3: Sign with session key ---
  console.log("\nStep 3: Sign pending update with session private key");

  const obligationId = proxyData.tab.obligationId;
  const updateId = proxyData.tab.updateId;
  const canonicalMessage = proxyData.tab.canonicalMessage;
  const returnedDelegationId = proxyData.tab.delegationId;

  if (!canonicalMessage || !updateId || !obligationId) {
    fail("Missing pending update fields", `obligationId=${obligationId} updateId=${updateId}`);
    await del(`${BASE}/api/delegations`, { id: delegationId });
    process.exit(1);
  }

  const sessionSig = await signMessage(canonicalMessage, session.privateKey);

  const { status: signStatus, data: signData } = await post(
    `${BASE}/api/obligations/${obligationId}/sign`,
    { signature: sessionSig, updateId, delegationId: returnedDelegationId }
  );

  if (signStatus === 200 && signData.verified && signData.delegated) {
    pass(`Signed and committed (verified: ${signData.verified}, delegated: ${signData.delegated})`);
  } else {
    fail("Sign commitment", signData.error || `status ${signStatus}`);
    await del(`${BASE}/api/delegations`, { id: delegationId });
    process.exit(1);
  }

  // --- Step 4: Verify spentSoFar incremented ---
  console.log("\nStep 4: Verify delegation spend cap decremented");

  const { data: poolData } = await get(`${BASE}/api/pool/summary?reserveId=${RESERVE_ID}`);
  const testDelegation = poolData.authority?.delegations?.find(
    (d: { id: string }) => d.id === delegationId
  );

  if (testDelegation && testDelegation.spentSoFar > 0) {
    pass(`spentSoFar: $${testDelegation.spentSoFar.toFixed(2)} / $${testDelegation.spendCap.toFixed(2)} (${Math.round(testDelegation.utilization * 100)}%)`);
  } else if (testDelegation) {
    fail("spentSoFar not incremented", `got ${testDelegation.spentSoFar}`);
  } else {
    fail("Delegation not found in pool summary");
  }

  // --- Step 5: Verify obligation updated ---
  console.log("\nStep 5: Verify obligation balance updated");

  const obligation = poolData.obligations?.find(
    (o: { id: string }) => o.id === obligationId
  );

  if (obligation && obligation.currentAmount > 0) {
    pass(`Obligation balance: $${obligation.currentAmount.toFixed(2)} (${obligation.providerName})`);
  } else if (obligation) {
    fail("Obligation balance not updated", `got ${obligation.currentAmount}`);
  } else {
    fail("Obligation not found in pool summary");
  }

  // --- Step 6: Pool authority mode reflects delegation ---
  console.log("\nStep 6: Pool authority shows updated state");

  const summary = poolData.authority?.summary;
  if (summary && summary.authorityMode === "delegated" && summary.activeDelegations > 0) {
    pass(`Authority mode: ${summary.authorityMode}, active: ${summary.activeDelegations}`);
  } else {
    fail("Authority mode not delegated or no active delegations");
  }

  // --- Cleanup: revoke test delegation ---
  await del(`${BASE}/api/delegations`, { id: delegationId });

  // --- Summary ---
  console.log("\n========================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("========================================");

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
