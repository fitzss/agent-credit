import { prisma } from "@/lib/prisma";
import { formatCredits, nanoCreditsToNanoErg } from "@/lib/credits";
import { NextRequest, NextResponse } from "next/server";
import {
  requireSession,
  requireCustomerOwned,
  authErrorResponse,
} from "@/lib/auth";

/**
 * Pool summary endpoint (Phase 1a+b).
 *
 * ?reserveId=X  → full detail for a single pool (scoped to that reserve's customer)
 * (no param)    → lightweight list of active reserves for the pool selector
 *
 * Auth (slice 3):
 *   - requireSession first; unauthenticated → JSON 401, no DB lookup.
 *   - Selector mode: operator sees all; customer sees only reserves whose
 *     customer.ownerUserId === user.id.
 *   - Detail mode: load reserve → 404 if missing → requireCustomerOwned
 *     (operator bypass inside) → 403 if mismatch.
 */

type SettlementReadiness =
  | "ready"
  | "no-debt"
  | "pending-redemption"
  | "insufficient-reserve"
  | "reserve-inactive";

type PoolStatus = "healthy" | "low-coverage" | "depleted" | "offline";

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch (e) {
    return authErrorResponse(e);
  }

  const reserveId = req.nextUrl.searchParams.get("reserveId");

  // --- Selector mode: return lightweight reserve list ---
  if (!reserveId) {
    const where =
      user.role === "operator"
        ? { lifecycle: "active" }
        : { lifecycle: "active", customer: { ownerUserId: user.id } };
    const allReserves = await prisma.reserve.findMany({
      where,
      include: { customer: true },
      orderBy: { updatedAt: "desc" },
    });

    const reserveList = await Promise.all(
      allReserves.map(async (r) => {
        const obligationCount = await prisma.obligationState.count({
          where: { customerId: r.customerId },
        });
        const delegationCount = await prisma.delegation.count({
          where: { customerId: r.customerId },
        });
        return {
          id: r.id,
          customerName: r.customer.name,
          customerId: r.customer.id,
          valueNanoErg: r.valueNanoErg.toString(),
          lifecycle: r.lifecycle,
          contractVersion: r.contractVersion,
          obligationCount,
          authorityMode: delegationCount > 0 ? "delegated" : "tracker-managed",
        };
      })
    );

    return NextResponse.json({ mode: "selector", reserves: reserveList });
  }

  // --- Detail mode: full pool data scoped to one reserve ---
  const reserves = await prisma.reserve.findMany({
    where: { id: reserveId, lifecycle: "active" },
    include: { customer: true },
  });

  if (reserves.length === 0) {
    return NextResponse.json({ error: "reserve not found" }, { status: 404 });
  }

  try {
    await requireCustomerOwned(reserves[0].customerId);
  } catch (e) {
    return authErrorResponse(e);
  }

  // All customer IDs that have active reserves
  const poolCustomerIds = [...new Set(reserves.map((r) => r.customerId))];

  // Obligations for pool customers, with provider and credit line info
  const obligations = await prisma.obligationState.findMany({
    where: { customerId: { in: poolCustomerIds } },
    include: { provider: true, customer: true },
  });

  // Credit lines for lookups
  const creditLines = await prisma.creditLine.findMany({
    where: { customerId: { in: poolCustomerIds } },
  });
  const creditLineMap = new Map(
    creditLines.map((cl) => [`${cl.providerId}:${cl.customerId}`, cl])
  );

  // Pending redemptions
  const pendingRedemptions = await prisma.pendingRedemption.findMany({
    where: { status: "pending" },
  });
  const pendingByObligation = new Set(
    pendingRedemptions.map((pr) => pr.obligationId)
  );

  // Total reserve value
  const totalReserveValueNanoErg = reserves.reduce(
    (sum, r) => sum + r.valueNanoErg,
    BigInt(0)
  );

  // Total obligations in nanoCredits
  const totalObligationsNanoCredits = obligations.reduce(
    (sum, o) => sum + o.currentAmount,
    BigInt(0)
  );
  // v1: nanoCredits = nanoERG
  const totalObligationsNanoErg = totalObligationsNanoCredits;

  // Coverage ratio
  const coverageRatio =
    totalObligationsNanoErg > BigInt(0)
      ? Number(totalReserveValueNanoErg) / Number(totalObligationsNanoErg)
      : totalReserveValueNanoErg > BigInt(0)
        ? Infinity
        : 0;

  // Pool status
  let poolStatus: PoolStatus = "healthy";
  if (totalReserveValueNanoErg === BigInt(0)) {
    poolStatus = "depleted";
  } else if (coverageRatio < 1.0) {
    poolStatus = "low-coverage";
  }

  // Compute settlement readiness per obligation
  const obligationsWithReadiness = obligations.map((o) => {
    const cl = creditLineMap.get(`${o.providerId}:${o.customerId}`);
    const reserve = reserves.find((r) => r.customerId === o.customerId);

    let settlementReadiness: SettlementReadiness = "ready";
    if (o.currentAmount <= BigInt(0)) {
      settlementReadiness = "no-debt";
    } else if (!reserve || reserve.lifecycle !== "active") {
      settlementReadiness = "reserve-inactive";
    } else if (pendingByObligation.has(o.id)) {
      settlementReadiness = "pending-redemption";
    } else if (
      reserve.valueNanoErg < nanoCreditsToNanoErg(o.currentAmount)
    ) {
      settlementReadiness = "insufficient-reserve";
    }

    return {
      id: o.id,
      providerId: o.providerId,
      providerName: o.provider.name,
      customerId: o.customerId,
      customerName: o.customer.name,
      currentAmount: o.currentAmount.toString(),
      version: o.version,
      settlementStatus: o.settlementStatus,
      debtorPubKey: o.debtorPubKey,
      creditorPubKey: o.creditorPubKey,
      latestSignature: o.latestSignature,
      creditLimit: cl?.limitAmount?.toString() ?? null,
      alertThreshold: cl?.alertThreshold ?? null,
      reserveId: reserve?.id ?? null,
      settlementReadiness,
    };
  });

  // --- Phase 1b: Authority / delegation visibility ---

  // Delegations for pool customers only
  const delegations = await prisma.delegation.findMany({
    where: { customerId: { in: poolCustomerIds } },
    include: { customer: true, agentIdentity: true },
    orderBy: { createdAt: "desc" },
  });

  // Resolve provider names from obligations already fetched
  const providerNameMap = new Map<string, string>();
  obligations.forEach((o) => providerNameMap.set(o.providerId, o.provider.name));

  // Resolve tool names for scoped delegations
  const scopedToolIds = delegations
    .filter((d) => d.scopeToolIds !== "*")
    .flatMap((d) => d.scopeToolIds.split(","))
    .filter(Boolean);
  const toolNameMap = new Map<string, string>();
  if (scopedToolIds.length > 0) {
    const tools = await prisma.tool.findMany({
      where: { id: { in: [...new Set(scopedToolIds)] } },
    });
    tools.forEach((t) => toolNameMap.set(t.id, t.name));
  }

  type DelegationCompliance =
    | "active"
    | "approaching-cap"
    | "approaching-expiry"
    | "exhausted"
    | "expired"
    | "revoked";

  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  const delegationsWithCompliance = delegations.map((d) => {
    const utilization = d.spendCap > BigInt(0) ? Number(d.spentSoFar) / Number(d.spendCap) : 0;
    const timeRemainingMs = d.expiresAt.getTime() - now;

    let complianceState: DelegationCompliance = "active";
    if (d.status === "exhausted") {
      complianceState = "exhausted";
    } else if (d.status === "expired" || (d.status === "active" && timeRemainingMs <= 0)) {
      complianceState = "expired";
    } else if (d.status === "revoked") {
      complianceState = "revoked";
    } else if (d.status === "active" && utilization >= 0.8) {
      complianceState = "approaching-cap";
    } else if (d.status === "active" && timeRemainingMs < TWENTY_FOUR_HOURS) {
      complianceState = "approaching-expiry";
    }

    // Resolve scope to names
    const scopeProviders =
      d.scopeProviderIds === "*"
        ? "All providers"
        : d.scopeProviderIds
            .split(",")
            .map((id) => providerNameMap.get(id) || id.substring(0, 8) + "...")
            .join(", ");
    const scopeTools =
      d.scopeToolIds === "*"
        ? "All tools"
        : d.scopeToolIds
            .split(",")
            .map((id) => toolNameMap.get(id) || id.substring(0, 8) + "...")
            .join(", ");

    return {
      id: d.id,
      customerId: d.customerId,
      customerName: d.customer.name,
      agentIdentityId: d.agentIdentityId,
      agentLabel: d.agentIdentity?.label ?? null,
      sessionPubKey: d.sessionPubKey,
      scopeProviders,
      scopeTools,
      spendCap: d.spendCap.toString(),
      spentSoFar: d.spentSoFar.toString(),
      utilization: Math.round(utilization * 100) / 100,
      expiresAt: d.expiresAt.toISOString(),
      timeRemainingMs,
      status: d.status,
      complianceState,
    };
  });

  // Determine authority mode per customer
  const customerSigningModes = new Map<string, string>();
  reserves.forEach((r) =>
    customerSigningModes.set(r.customerId, r.customer.publicKey ? "tracker-managed" : "self-custody")
  );
  // Check if any pool customer actually has delegations
  const customersWithDelegations = new Set(delegations.map((d) => d.customerId));
  const authorityMode = poolCustomerIds.some((cid) => customersWithDelegations.has(cid))
    ? "delegated"
    : "tracker-managed";

  const authoritySummary = {
    authorityMode,
    activeDelegations: delegationsWithCompliance.filter((d) =>
      ["active", "approaching-cap", "approaching-expiry"].includes(d.complianceState)
    ).length,
    approachingCap: delegationsWithCompliance.filter((d) => d.complianceState === "approaching-cap").length,
    approachingExpiry: delegationsWithCompliance.filter((d) => d.complianceState === "approaching-expiry").length,
    exhausted: delegationsWithCompliance.filter((d) => d.complianceState === "exhausted").length,
    expired: delegationsWithCompliance.filter((d) => d.complianceState === "expired").length,
    revoked: delegationsWithCompliance.filter((d) => d.complianceState === "revoked").length,
  };

  // --- Phase 1c: Tracker state + settlement history ---

  // Current tracker boxes for each reserve's tracker NFT
  const trackerNftIds = reserves.map((r) => r.trackerNftId).filter(Boolean);
  const trackerBoxes = trackerNftIds.length > 0
    ? await prisma.trackerBox.findMany({
        where: { trackerNftId: { in: trackerNftIds }, isCurrent: true },
        include: { entries: true },
      })
    : [];

  const trackerData = trackerBoxes.map((tb) => ({
    id: tb.id,
    trackerNftId: tb.trackerNftId,
    boxId: tb.boxId,
    trackerPubKeyHex: tb.trackerPubKeyHex,
    treeDigestHex: tb.treeDigestHex,
    isCurrent: tb.isCurrent,
    entries: tb.entries.map((e) => {
      // Resolve creditor to provider name
      const provName = providerNameMap.get(
        obligations.find((o) => o.creditorPubKey === e.creditorPubKey)?.providerId || ""
      );
      return {
        id: e.id,
        debtorPubKey: e.debtorPubKey,
        creditorPubKey: e.creditorPubKey,
        totalDebtNanoErg: e.totalDebtNanoErg.toString(),
        creditorName: provName || e.creditorPubKey.substring(0, 16) + "...",
      };
    }),
  }));

  // Agents for pool customers (for delegation create dropdown)
  const agents = await prisma.agentIdentity.findMany({
    where: { customerId: { in: poolCustomerIds }, status: "active" },
    select: { id: true, label: true, customerId: true },
  });

  // Recent settlement events for pool obligations (last 10)
  const obligationIds = obligations.map((o) => o.id);
  const recentSettlements = obligationIds.length > 0
    ? await prisma.settlementEvent.findMany({
        where: { obligationStateId: { in: obligationIds } },
        include: { obligationState: { include: { provider: true } } },
        orderBy: { timestamp: "desc" },
        take: 10,
      })
    : [];

  const settlementsData = recentSettlements.map((s) => ({
    id: s.id,
    obligationStateId: s.obligationStateId,
    providerName: s.obligationState.provider.name,
    amount: s.amount.toString(),
    method: s.method,
    status: s.status,
    redemptionTxId: s.redemptionTxId,
    timestamp: s.timestamp.toISOString(),
  }));

  // Recent agent activity (last 25 proxy calls — success, denied, error)
  const recentUsage = await prisma.usageEvent.findMany({
    where: { customerId: { in: poolCustomerIds } },
    include: {
      agentIdentity: { select: { id: true, label: true } },
      tool: { select: { id: true, name: true } },
      provider: { select: { id: true, name: true } },
    },
    orderBy: { timestamp: "desc" },
    take: 25,
  });

  const recentUsageData = recentUsage.map((e) => ({
    id: e.id,
    agentIdentityId: e.agentIdentityId,
    agentLabel: e.agentIdentity?.label ?? null,
    toolId: e.toolId,
    toolName: e.tool?.name ?? null,
    providerId: e.providerId,
    providerName: e.provider?.name ?? null,
    amountCharged: e.amountCharged.toString(),
    outcome: e.outcome,
    timestamp: e.timestamp.toISOString(),
  }));

  // Active providers — populates the Create Delegation form's Provider Scope dropdown
  const providers = await prisma.provider.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    reserves: reserves.map((r) => ({
      id: r.id,
      reserveTokenId: r.reserveTokenId,
      trackerNftId: r.trackerNftId,
      valueNanoErg: r.valueNanoErg.toString(),
      lifecycle: r.lifecycle,
      contractVersion: r.contractVersion,
      avlTreeDigest: r.avlTreeDigest,
      updatedAt: r.updatedAt.toISOString(),
      customer: { id: r.customer.id, name: r.customer.name, publicKey: r.customer.publicKey, signingMode: r.customer.signingMode },
    })),
    obligations: obligationsWithReadiness,
    poolHealth: {
      totalReserveValueNanoErg: totalReserveValueNanoErg.toString(),
      totalObligationsNanoCredits: totalObligationsNanoCredits.toString(),
      coverageRatio: coverageRatio === Infinity ? null : Math.round(coverageRatio * 100) / 100,
      poolStatus,
    },
    authority: {
      delegations: delegationsWithCompliance,
      summary: authoritySummary,
    },
    agents,
    providers,
    tracker: trackerData,
    settlements: settlementsData,
    recentUsage: recentUsageData,
  });
}
