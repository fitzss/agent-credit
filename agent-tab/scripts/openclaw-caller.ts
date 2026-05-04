/**
 * OpenClaw caller — a thin external agent that exercises the bounded-buyer v0
 * demo end-to-end against the running Agent Tab.
 *
 *   --mode=positive   one valid call against a fresh delegation
 *   --mode=negative   one valid call, then one over-cap call (proves the wall)
 *   --mode=demo       (default) same as negative, the full happy-then-blocked story
 *   --cleanup         remove any leftover openclaw-* delegations and exit
 *
 * Prerequisites: Ergo node + sidecar + Next.js running per CLAUDE.md, and
 * `npx tsx scripts/seed-authority-demo.ts` already executed (provides the
 * Bolt Labs root key in .demo-state/authority-demo-root.json).
 *
 * Determinism: this script does NOT rely on the seeded delegation's
 * spent-so-far state. It mints a fresh delegation each run with a cap
 * computed from the live tool cost so the second call is guaranteed to
 * exceed it. No "two or three calls should hit the wall" hand-waving.
 */

import { PrismaClient } from "@prisma/client";
import { generateKeypair, signMessage } from "../src/lib/crypto";
import { buildDelegationMessage } from "../src/lib/tracker/delegation";
import { formatCredits } from "../src/lib/credits";
import { operatorCookieHeader } from "./lib/test-session";
import * as fs from "fs";
import * as path from "path";

const BASE = "http://localhost:3000";
const CUSTOMER_ID = "auth-demo-bolt-labs-001";
const TOOL_ID = "auth-demo-tool-analyze-001";
const PROVIDER_ID = "auth-demo-bolt-tools-001";
const AGENT_ID = "auth-demo-agent-001";
const AGENT_KEY = "auth-demo-key-001";
const ROOT_KEY_FILE = path.join(__dirname, "..", ".demo-state", "authority-demo-root.json");

const prisma = new PrismaClient();

// Slice 9: /api/delegations now requires a session. main() mints this once;
// createFreshDelegation() and cleanup() read it before issuing requests.
let COOKIE: string = "";

type Mode = "positive" | "negative" | "demo";

function log(msg: string) { console.log(msg); }
function step(msg: string) { console.log(`\n→ ${msg}`); }
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function bad(msg: string): never { console.log(`  ✗ ${msg}`); process.exit(1); }

interface RootKey { publicKey: string; privateKey: string }

function loadRootKey(): RootKey {
  if (!fs.existsSync(ROOT_KEY_FILE)) {
    bad(`Root key not found at ${ROOT_KEY_FILE}. Run: npx tsx scripts/seed-authority-demo.ts`);
  }
  return JSON.parse(fs.readFileSync(ROOT_KEY_FILE, "utf-8"));
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

async function del(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status };
}

async function fetchToolCost(): Promise<bigint> {
  const tool = await prisma.tool.findUnique({ where: { id: TOOL_ID } });
  if (!tool) bad(`Tool ${TOOL_ID} not found — fixture missing?`);
  return tool.costPerCall;
}

interface FreshDelegation {
  delegationId: string;
  sessionPubKey: string;
  sessionPrivKey: string;
  spendCap: bigint;
}

async function createFreshDelegation(
  label: string,
  capNanoCredits: bigint,
  root: RootKey,
): Promise<FreshDelegation> {
  const session = generateKeypair();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  const authMsg = buildDelegationMessage(
    root.publicKey,
    AGENT_ID,
    session.publicKey,
    PROVIDER_ID,
    "*",
    capNanoCredits,
    expiresAt,
  );
  const authSig = await signMessage(authMsg, root.privateKey);

  const capCreditsStr = formatCredits(capNanoCredits);
  const { status, data } = await post(`${BASE}/api/delegations`, {
    customerId: CUSTOMER_ID,
    agentIdentityId: AGENT_ID,
    sessionPubKey: session.publicKey,
    scopeProviderIds: PROVIDER_ID,
    scopeToolIds: "*",
    spendCap: capCreditsStr,
    expiresAt,
    authSignature: authSig,
  }, { Cookie: COOKIE });

  if (status !== 201 || typeof data.delegationId !== "string") {
    bad(`Delegation creation failed (${status}): ${JSON.stringify(data)}`);
  }

  log(`  delegation ${(data.delegationId as string).substring(0, 16)}…  cap=${capCreditsStr} credits (${capNanoCredits} nanoCredits)  agent=${AGENT_ID}  label=${label}`);
  return {
    delegationId: data.delegationId as string,
    sessionPubKey: session.publicKey,
    sessionPrivKey: session.privateKey,
    spendCap: capNanoCredits,
  };
}

async function makeProxyCall(sessionPubKey: string) {
  const { status, data } = await post(
    `${BASE}/api/proxy`,
    { text: "OpenClaw v0 bounded-buyer demo call." },
    {
      "x-agent-api-key": AGENT_KEY,
      "x-tool-id": TOOL_ID,
      "x-session-pubkey": sessionPubKey,
    },
  );
  return { status, data };
}

async function signPendingUpdate(
  obligationId: string,
  updateId: string,
  delegationId: string,
  canonicalMessage: string,
  sessionPrivKey: string,
) {
  const sig = await signMessage(canonicalMessage, sessionPrivKey);
  const { status, data } = await post(
    `${BASE}/api/obligations/${obligationId}/sign`,
    { signature: sig, updateId, delegationId },
  );
  return { status, data };
}

async function readDelegation(delegationId: string) {
  const d = await prisma.delegation.findUnique({ where: { id: delegationId } });
  if (!d) bad(`Delegation ${delegationId} disappeared mid-run`);
  return d;
}

async function runPositive(d: FreshDelegation): Promise<void> {
  step("Positive call — agent issues one in-bound proxy call");
  const { status, data } = await makeProxyCall(d.sessionPubKey);
  if (status !== 200) bad(`Proxy returned ${status}: ${JSON.stringify(data)}`);
  const tab = data.tab as Record<string, unknown> | undefined;
  if (!tab?.pendingSignature) bad(`Proxy did not return pendingSignature: ${JSON.stringify(data)}`);

  const obligationId = tab.obligationId as string;
  const updateId = tab.updateId as string;
  const returnedDelegationId = tab.delegationId as string;
  const canonicalMessage = tab.canonicalMessage as string;

  const sign = await signPendingUpdate(obligationId, updateId, returnedDelegationId, canonicalMessage, d.sessionPrivKey);
  if (sign.status !== 200 || sign.data.verified !== true) {
    bad(`Sign-commit failed (${sign.status}): ${JSON.stringify(sign.data)}`);
  }
  ok("Proxy 200 → session-signed → committed (verified=true, delegated=true)");

  const after = await readDelegation(d.delegationId);
  const expected = (await fetchToolCost());
  if (after.spentSoFar !== expected) {
    bad(`spentSoFar expected ${expected}, got ${after.spentSoFar}`);
  }
  ok(`delegation.spentSoFar = ${after.spentSoFar} nanoCredits (one tool cost charged)`);
}

async function runNegative(d: FreshDelegation): Promise<void> {
  step("Negative call — agent attempts to exceed spend cap");

  const before = await readDelegation(d.delegationId);
  const remaining = d.spendCap - before.spentSoFar;
  log(`  before: spentSoFar=${before.spentSoFar}, cap=${d.spendCap}, remaining=${remaining}`);

  const cost = await fetchToolCost();
  if (remaining >= cost) {
    bad(`Pre-condition violated: remaining (${remaining}) >= costPerCall (${cost}). The next call would not exceed the cap.`);
  }

  const { status, data } = await makeProxyCall(d.sessionPubKey);
  if (status !== 409) {
    bad(`Expected 409 DELEGATION_SCOPE_VIOLATED, got ${status}: ${JSON.stringify(data)}`);
  }
  if (data.code !== "DELEGATION_SCOPE_VIOLATED") {
    bad(`Expected code DELEGATION_SCOPE_VIOLATED, got ${data.code}`);
  }
  ok(`Proxy returned 409 ${data.code}`);

  const after = await readDelegation(d.delegationId);
  if (after.spentSoFar !== before.spentSoFar) {
    bad(`spentSoFar moved despite rejection: ${before.spentSoFar} → ${after.spentSoFar}`);
  }
  ok(`delegation.spentSoFar unchanged at ${after.spentSoFar} (the wall held)`);

  const obligation = await prisma.obligationState.findFirst({
    where: { customerId: CUSTOMER_ID, providerId: PROVIDER_ID },
  });
  if (!obligation) bad("Obligation state vanished");
  ok(`obligationState.currentAmount = ${obligation.currentAmount} (unchanged by rejected call)`);
}

const SEED_DELEGATION_IDS = new Set([
  "auth-demo-deleg-active-001",
  "auth-demo-deleg-expired-001",
]);

async function cleanup(): Promise<void> {
  step("Cleanup — removing extra delegations on Bolt Labs (seed delegations preserved)");
  const all = await prisma.delegation.findMany({ where: { customerId: CUSTOMER_ID } });
  const stale = all.filter((d) => !SEED_DELEGATION_IDS.has(d.id));
  for (const d of stale) {
    await del(`${BASE}/api/delegations`, { id: d.id }, { Cookie: COOKIE });
  }
  ok(`Cleaned ${stale.length} delegation(s); ${all.length - stale.length} seed delegation(s) preserved`);
}

async function main() {
  const args = process.argv.slice(2);

  // Mint operator cookie before any /api/delegations call (cleanup or normal).
  COOKIE = await operatorCookieHeader(prisma);

  if (args.includes("--cleanup")) {
    await cleanup();
    await prisma.$disconnect();
    return;
  }

  const modeArg = args.find((a) => a.startsWith("--mode="));
  const mode: Mode = (modeArg?.split("=")[1] as Mode) ?? "demo";
  if (!["positive", "negative", "demo"].includes(mode)) {
    bad(`Unknown mode: ${mode}. Use positive | negative | demo.`);
  }

  log("==========================================");
  log(`  OpenClaw caller — mode=${mode}`);
  log("==========================================");

  const root = loadRootKey();
  const cost = await fetchToolCost();
  log(`  tool cost: ${cost} nanoCredits ($${(Number(cost) / 1_000_000_000).toFixed(2)})`);

  if (mode === "positive") {
    step("Mint fresh delegation with cap = 2× tool cost (room for one positive call)");
    const d = await createFreshDelegation("openclaw-positive", cost * BigInt(2), root);
    await runPositive(d);
  } else if (mode === "negative") {
    step("Mint fresh delegation with cap = tool cost + 1 nanoCredit (one positive then one over-cap)");
    const d = await createFreshDelegation("openclaw-negative", cost + BigInt(1), root);
    await runPositive(d);
    await runNegative(d);
  } else {
    step("Mint fresh delegation with cap = tool cost + 1 nanoCredit (full bounded-buyer demo)");
    const d = await createFreshDelegation("openclaw-demo", cost + BigInt(1), root);
    await runPositive(d);
    await runNegative(d);
  }

  log("\n==========================================");
  log("  Done. Refresh /pool/auth-demo-reserve-001 to see:");
  log("    • the new delegation with utilization");
  log("    • a success row in Recent Agent Activity");
  if (mode !== "positive") log("    • a denied row in Recent Agent Activity");
  log("==========================================");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("Fatal:", e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
