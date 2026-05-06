import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { toJsonSafe } from "@/lib/json-safe";
import { hashAgentApiKey, previewAgentApiKey } from "@/lib/agent-key-hash";
import { requireSession, authErrorResponse } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  // Strict body discipline: empty body or empty object {} is allowed.
  // Anything else (malformed JSON, null, array, scalar, non-empty object)
  // is rejected. Rotate is a credential-lifecycle endpoint — silently
  // ignoring unknown fields hides client bugs.
  const text = await req.text();
  if (text.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (Object.keys(body as Record<string, unknown>).length > 0) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const { id } = await params;
  const agent = await prisma.agentIdentity.findUnique({
    where: { id },
    select: {
      id: true,
      customerId: true,
      customer: { select: { ownerUserId: true } },
    },
  });

  if (user.role === "operator") {
    if (!agent) {
      return NextResponse.json({ error: "Agent identity not found" }, { status: 404 });
    }
  } else {
    if (!agent || agent.customer.ownerUserId !== user.id) {
      return NextResponse.json(
        { error: "agent identity not owned by current user" },
        { status: 403 },
      );
    }
  }

  // The raw apiKey is generated in-memory only and never stored. Same
  // contract as POST /api/agent-identities — the response is the one and
  // only place the new raw key ever leaves the server.
  const rawKey = randomUUID();
  const apiKeyHash = hashAgentApiKey(rawKey);
  const apiKeyPreview = previewAgentApiKey(rawKey);
  const updated = await prisma.agentIdentity.update({
    where: { id },
    data: { apiKeyHash, apiKeyPreview },
  });

  const { apiKeyHash: _h, ...safe } = updated;
  return NextResponse.json(toJsonSafe({ ...safe, apiKey: rawKey }));
}
