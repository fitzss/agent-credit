import { prisma } from "@/lib/prisma";
import { tracker, TrackerError } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";

/**
 * Metering proxy — app-layer responsibility.
 * Authenticates agent, checks credit line, calls upstream tool,
 * then delegates note update to the tracker.
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-agent-api-key");
  const toolId = req.headers.get("x-tool-id");
  const sessionPubKey = req.headers.get("x-session-pubkey");

  if (!apiKey || !toolId) {
    return NextResponse.json({ error: "Missing x-agent-api-key or x-tool-id header" }, { status: 400 });
  }

  // --- App layer: authenticate ---
  const agent = await prisma.agentIdentity.findUnique({
    where: { apiKey },
    include: { customer: true },
  });
  if (!agent || agent.status !== "active") {
    return NextResponse.json({ error: "Invalid or inactive agent identity" }, { status: 401 });
  }
  if (agent.customer.status !== "active") {
    return NextResponse.json({ error: "Customer account suspended" }, { status: 403 });
  }

  // --- App layer: look up tool ---
  const tool = await prisma.tool.findUnique({
    where: { id: toolId },
    include: { provider: true },
  });
  if (!tool || tool.status !== "active") {
    return NextResponse.json({ error: "Tool not found or inactive" }, { status: 404 });
  }

  if (agent.allowedToolIds !== "*" && !agent.allowedToolIds.split(",").includes(toolId)) {
    await logUsage(agent.id, toolId, tool.providerId, agent.customerId, 0, "denied");
    return NextResponse.json({ error: "Agent not authorized for this tool" }, { status: 403 });
  }

  // --- App layer: check credit line ---
  const creditLine = await prisma.creditLine.findUnique({
    where: { providerId_customerId: { providerId: tool.providerId, customerId: agent.customerId } },
  });
  if (!creditLine || creditLine.status !== "active") {
    await logUsage(agent.id, toolId, tool.providerId, agent.customerId, 0, "denied");
    return NextResponse.json({ error: "No active credit line with this provider" }, { status: 403 });
  }

  // Quick limit check (tracker also enforces, but fail fast)
  const note = await prisma.obligationState.findUnique({
    where: { providerId_customerId: { providerId: tool.providerId, customerId: agent.customerId } },
  });
  const exposure = (note?.currentAmount ?? 0) + (note?.pendingAmount ?? 0);
  if (exposure + tool.costPerCall > creditLine.limitAmount) {
    await logUsage(agent.id, toolId, tool.providerId, agent.customerId, tool.costPerCall, "denied");
    return NextResponse.json({
      error: "Credit limit exceeded",
      currentBalance: note?.currentAmount ?? 0,
      pendingBalance: note?.pendingAmount ?? 0,
      limit: creditLine.limitAmount,
      remaining: creditLine.limitAmount - exposure,
    }, { status: 402 });
  }

  // --- App layer: call upstream tool ---
  let toolResponse: { status: number; body: unknown };
  try {
    const body = await req.text();
    const upstream = await fetch(tool.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body || undefined,
    });
    const responseBody = await upstream.text();
    toolResponse = { status: upstream.status, body: tryParseJson(responseBody) };
  } catch {
    toolResponse = { status: 502, body: { error: "Upstream tool unavailable" } };
  }

  // No service → no debt
  if (toolResponse.status >= 400) {
    await logUsage(agent.id, toolId, tool.providerId, agent.customerId, 0, "error");
    return NextResponse.json({
      toolResponse: toolResponse.body,
      toolStatus: toolResponse.status,
      tab: {
        balance: note?.currentAmount ?? 0,
        pending: note?.pendingAmount ?? 0,
        limit: creditLine.limitAmount,
        remaining: creditLine.limitAmount - exposure,
        version: note?.version ?? 0,
        signature: note?.latestSignature ?? null,
        alert: null,
        charged: false,
      },
    });
  }

  // --- Tracker: propose note update ---
  const isSelfCustody = agent.customer.signingMode === "self-custody";
  const trackerKey = isSelfCustody ? undefined : agent.customer.privateKey;

  try {
    const result = await tracker.proposeNoteUpdate(
      {
        debtorPubKey: agent.customer.publicKey,
        creditorPubKey: tool.provider.publicKey,
        delta: tool.costPerCall,
        expectedVersion: note?.version ?? 0,
        requestId: uuid(),
        sessionPubKey: sessionPubKey || undefined,
        toolId,
        toolName: tool.name,
        providerId: tool.providerId,
        providerName: tool.provider.name,
      },
      trackerKey
    );

    // Fix customerId/providerId on newly created notes
    if (!note) {
      await prisma.obligationState.update({
        where: { id: result.noteId },
        data: { customerId: agent.customerId, providerId: tool.providerId },
      });
    }

    // --- App layer: log usage ---
    await logUsage(agent.id, toolId, tool.providerId, agent.customerId, tool.costPerCall, "success");

    const totalExposure = result.currentAmount + result.pendingAmount;
    const utilization = creditLine.limitAmount > 0 ? totalExposure / creditLine.limitAmount : 0;
    const alert = utilization >= 1.0 ? "limit_reached" : utilization >= creditLine.alertThreshold ? "threshold_warning" : null;

    return NextResponse.json({
      toolResponse: toolResponse.body,
      toolStatus: toolResponse.status,
      tab: {
        balance: result.currentAmount,
        pending: result.pendingAmount,
        limit: creditLine.limitAmount,
        remaining: creditLine.limitAmount - totalExposure,
        utilization: Math.round(utilization * 100) / 100,
        version: result.version,
        signature: isSelfCustody ? null : (result as { canonicalMessage: string }).canonicalMessage ? undefined : null,
        alert,
        ...(isSelfCustody
          ? {
              pendingSignature: true,
              canonicalMessage: result.canonicalMessage,
              obligationId: result.noteId,
              updateId: result.updateId,
              delegationId: result.delegationId,
            }
          : {}),
      },
    });
  } catch (e) {
    if (e instanceof TrackerError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }
}

async function logUsage(
  agentIdentityId: string, toolId: string, providerId: string,
  customerId: string, amountCharged: number, outcome: string
) {
  await prisma.usageEvent.create({
    data: { agentIdentityId, toolId, providerId, customerId, amountCharged, outcome },
  });
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
