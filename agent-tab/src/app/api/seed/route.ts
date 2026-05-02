import { prisma } from "@/lib/prisma";
import { generateKeypair, buildCanonicalMessage, signMessage } from "@/lib/crypto";
import { buildDelegationMessageV1 } from "@/lib/tracker/delegation";
import { hashAgentApiKey } from "@/lib/agent-key-hash";
import { NextRequest, NextResponse } from "next/server";
import { requireOperator, authErrorResponse } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "seed disabled in production" },
      { status: 403 },
    );
  }

  let operator;
  try {
    operator = await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

  const baseUrl = new URL(req.url).origin;

  // Clean existing data (order matters for foreign keys)
  await prisma.obligationUpdate.deleteMany();
  await prisma.usageEvent.deleteMany();
  await prisma.settlementEvent.deleteMany();
  await prisma.obligationState.deleteMany();
  await prisma.delegation.deleteMany();
  await prisma.creditLine.deleteMany();
  await prisma.agentIdentity.deleteMany();
  await prisma.tool.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.provider.deleteMany();

  // --- Provider 1: ToolSmith AI (text tools) ---
  const p1Keys = generateKeypair();
  const provider1 = await prisma.provider.create({
    data: {
      name: "ToolSmith AI",
      publicKey: p1Keys.publicKey,
      privateKey: p1Keys.privateKey,
    },
  });

  const analyzeTool = await prisma.tool.create({
    data: {
      providerId: provider1.id,
      name: "Text Analysis",
      description: "Analyze text for word count, reading level, and structure",
      endpoint: `${baseUrl}/api/demo-tool/analyze`,
      costPerCall: BigInt(100_000_000),
    },
  });

  const summarizeTool = await prisma.tool.create({
    data: {
      providerId: provider1.id,
      name: "Text Summary",
      description: "Extract key sentences from text content",
      endpoint: `${baseUrl}/api/demo-tool/summarize`,
      costPerCall: BigInt(250_000_000),
    },
  });

  // --- Provider 2: Compute Labs (LLM completion) ---
  const p2Keys = generateKeypair();
  const provider2 = await prisma.provider.create({
    data: {
      name: "Compute Labs",
      publicKey: p2Keys.publicKey,
      privateKey: p2Keys.privateKey,
    },
  });

  const completionTool = await prisma.tool.create({
    data: {
      providerId: provider2.id,
      name: "LLM Completion",
      description: "AI language model completion via Anthropic Claude",
      endpoint: `${baseUrl}/api/demo-tool/completion`,
      costPerCall: BigInt(50_000_000),
    },
  });

  // --- Customer: Acme Startup ---
  const custKeys = generateKeypair();
  const customer = await prisma.customer.create({
    data: {
      name: "Acme Startup",
      publicKey: custKeys.publicKey,
      privateKey: custKeys.privateKey,
      contactEmail: "team@acme.dev",
      ownerUserId: operator.id,
    },
  });

  // Agent identities
  const agent1 = await prisma.agentIdentity.create({
    data: {
      customerId: customer.id,
      label: "incident-responder",
      apiKey: "agent-key-demo-001",
      apiKeyHash: hashAgentApiKey("agent-key-demo-001"),
    },
  });

  const agent2 = await prisma.agentIdentity.create({
    data: {
      customerId: customer.id,
      label: "research-assistant",
      apiKey: "agent-key-demo-002",
      apiKeyHash: hashAgentApiKey("agent-key-demo-002"),
    },
  });

  // --- Credit Lines (one per provider-customer pair) ---
  await prisma.creditLine.create({
    data: {
      providerId: provider1.id,
      customerId: customer.id,
      limitAmount: BigInt(50_000_000_000),
      alertThreshold: 0.8,
    },
  });

  await prisma.creditLine.create({
    data: {
      providerId: provider2.id,
      customerId: customer.id,
      limitAmount: BigInt(25_000_000_000),
      alertThreshold: 0.8,
    },
  });

  // --- Obligations ---
  const obl1 = await prisma.obligationState.create({
    data: {
      providerId: provider1.id,
      customerId: customer.id,
      debtorPubKey: custKeys.publicKey,
      creditorPubKey: p1Keys.publicKey,
    },
  });

  const obl2 = await prisma.obligationState.create({
    data: {
      providerId: provider2.id,
      customerId: customer.id,
      debtorPubKey: custKeys.publicKey,
      creditorPubKey: p2Keys.publicKey,
    },
  });

  // --- Simulate usage for Provider 1 (text tools) ---
  const now = new Date();
  let cum1 = BigInt(0);
  let ver1 = 0;

  for (let i = 0; i < 6; i++) {
    const tool = i % 2 === 0 ? analyzeTool : summarizeTool;
    const ts = new Date(now.getTime() - (10 - i) * 3600_000);
    cum1 += tool.costPerCall;
    ver1++;

    const msg = buildCanonicalMessage(custKeys.publicKey, p1Keys.publicKey, cum1, ver1, ts.toISOString());
    const sig = await signMessage(msg, custKeys.privateKey);

    await prisma.usageEvent.create({
      data: {
        agentIdentityId: agent1.id,
        toolId: tool.id,
        providerId: provider1.id,
        customerId: customer.id,
        amountCharged: tool.costPerCall,
        timestamp: ts,
        outcome: "success",
      },
    });

    await prisma.obligationUpdate.create({
      data: {
        obligationStateId: obl1.id,
        version: ver1,
        previousAmount: cum1 - tool.costPerCall,
        newAmount: cum1,
        delta: tool.costPerCall,
        canonicalMessage: msg,
        signature: sig,
        type: "charge",
      },
    });
  }

  // Update obligation 1 final state
  const finalMsg1 = buildCanonicalMessage(custKeys.publicKey, p1Keys.publicKey, cum1, ver1, now.toISOString());
  const finalSig1 = await signMessage(finalMsg1, custKeys.privateKey);
  await prisma.obligationState.update({
    where: { id: obl1.id },
    data: { currentAmount: cum1, version: ver1, latestSignedMessage: finalMsg1, latestSignature: finalSig1 },
  });

  // --- Simulate usage for Provider 2 (LLM completion) ---
  let cum2 = BigInt(0);
  let ver2 = 0;

  for (let i = 0; i < 4; i++) {
    const ts = new Date(now.getTime() - (8 - i * 2) * 3600_000);
    cum2 += completionTool.costPerCall;
    ver2++;

    const msg = buildCanonicalMessage(custKeys.publicKey, p2Keys.publicKey, cum2, ver2, ts.toISOString());
    const sig = await signMessage(msg, custKeys.privateKey);

    await prisma.usageEvent.create({
      data: {
        agentIdentityId: agent2.id,
        toolId: completionTool.id,
        providerId: provider2.id,
        customerId: customer.id,
        amountCharged: completionTool.costPerCall,
        timestamp: ts,
        outcome: "success",
      },
    });

    await prisma.obligationUpdate.create({
      data: {
        obligationStateId: obl2.id,
        version: ver2,
        previousAmount: cum2 - completionTool.costPerCall,
        newAmount: cum2,
        delta: completionTool.costPerCall,
        canonicalMessage: msg,
        signature: sig,
        type: "charge",
      },
    });
  }

  // Update obligation 2 final state
  const finalMsg2 = buildCanonicalMessage(custKeys.publicKey, p2Keys.publicKey, cum2, ver2, now.toISOString());
  const finalSig2 = await signMessage(finalMsg2, custKeys.privateKey);
  await prisma.obligationState.update({
    where: { id: obl2.id },
    data: { currentAmount: cum2, version: ver2, latestSignedMessage: finalMsg2, latestSignature: finalSig2 },
  });

  // --- Customer 2: Self-Custody Demo (Bolt Labs) ---
  const cust2Keys = generateKeypair();
  const customer2 = await prisma.customer.create({
    data: {
      name: "Bolt Labs",
      publicKey: cust2Keys.publicKey,
      privateKey: "", // empty — self-custody
      signingMode: "self-custody",
      contactEmail: "ops@boltlabs.io",
      ownerUserId: operator.id,
    },
  });

  const agent3 = await prisma.agentIdentity.create({
    data: {
      customerId: customer2.id,
      label: "auto-researcher",
      apiKey: "agent-key-demo-003",
      apiKeyHash: hashAgentApiKey("agent-key-demo-003"),
    },
  });

  // Credit line with ToolSmith AI
  await prisma.creditLine.create({
    data: {
      providerId: provider1.id,
      customerId: customer2.id,
      limitAmount: BigInt(30_000_000_000),
      alertThreshold: 0.8,
    },
  });

  await prisma.obligationState.create({
    data: {
      providerId: provider1.id,
      customerId: customer2.id,
      debtorPubKey: cust2Keys.publicKey,
      creditorPubKey: p1Keys.publicKey,
    },
  });

  // --- Delegation for Bolt Labs ---
  // Customer generates a session keypair and signs a delegation with their root key
  const sessionKeys = generateKeypair();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000); // 7 days
  const delegationAuthMessage = buildDelegationMessageV1(
    cust2Keys.publicKey,
    sessionKeys.publicKey,
    provider1.id, // scoped to ToolSmith AI
    "*", // all tools
    BigInt(20_000_000_000), // 20 credits spend cap
    expiresAt.toISOString()
  );
  const delegationAuthSig = await signMessage(delegationAuthMessage, cust2Keys.privateKey);

  const delegation = await prisma.delegation.create({
    data: {
      customerId: customer2.id,
      sessionPubKey: sessionKeys.publicKey,
      scopeProviderIds: provider1.id,
      scopeToolIds: "*",
      spendCap: BigInt(20_000_000_000),
      expiresAt,
      authMessage: delegationAuthMessage,
      authSignature: delegationAuthSig,
    },
  });

  return NextResponse.json({
    message: "Seeded successfully",
    providers: [
      { id: provider1.id, name: "ToolSmith AI", publicKey: p1Keys.publicKey },
      { id: provider2.id, name: "Compute Labs", publicKey: p2Keys.publicKey },
    ],
    customers: [
      { id: customer.id, name: "Acme Startup", publicKey: custKeys.publicKey, signingMode: "tracker" },
      {
        id: customer2.id,
        name: "Bolt Labs",
        publicKey: cust2Keys.publicKey,
        privateKey: cust2Keys.privateKey, // returned ONCE so the customer can save it
        signingMode: "self-custody",
      },
    ],
    agents: [
      { id: agent1.id, apiKey: agent1.apiKey, label: "incident-responder" },
      { id: agent2.id, apiKey: agent2.apiKey, label: "research-assistant" },
      { id: agent3.id, apiKey: agent3.apiKey, label: "auto-researcher" },
    ],
    tools: {
      analyze: analyzeTool.id,
      summarize: summarizeTool.id,
      completion: completionTool.id,
    },
    obligations: [
      { id: obl1.id, provider: "ToolSmith AI", balance: cum1.toString(), version: ver1 },
      { id: obl2.id, provider: "Compute Labs", balance: cum2.toString(), version: ver2 },
    ],
    delegation: {
      id: delegation.id,
      sessionPubKey: sessionKeys.publicKey,
      sessionPrivateKey: sessionKeys.privateKey, // returned ONCE for agent config
      spendCap: "20.00",
      scopeProvider: "ToolSmith AI",
      expiresAt: expiresAt.toISOString(),
    },
  });
}
