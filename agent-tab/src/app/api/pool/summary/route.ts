import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

/**
 * Pool summary endpoint (Phase 1a+b).
 * Assembles pool health, reserve state, obligation readiness, and
 * authority/delegation visibility from Prisma only (never calls sidecar).
 */

const NANO_PER_CREDIT = 1_000_000_000;

type SettlementReadiness =
  | "ready"
  | "no-debt"
  | "pending-redemption"
  | "insufficient-reserve"
  | "reserve-inactive";

type PoolStatus = "healthy" | "low-coverage" | "depleted" | "offline";

export async function GET() {
  // Active reserves with customer info
  const reserves = await prisma.reserve.findMany({
    where: { lifecycle: "active" },
    include: { customer: true },
    orderBy: { updatedAt: "desc" },
  });

  if (reserves.length === 0) {
    return NextResponse.json({
      reserves: [],
      obligations: [],
      poolHealth: {
        totalReserveValueNanoErg: "0",
        totalObligationsCredits: 0,
        coverageRatio: 0,
        poolStatus: "offline" as PoolStatus,
      },
      authority: {
        delegations: [],
        summary: {
          authorityMode: "offline",
          activeDelegations: 0,
          approachingCap: 0,
          approachingExpiry: 0,
          exhausted: 0,
          expired: 0,
          revoked: 0,
        },
      },
    });
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

  // Total obligations in credits
  const totalObligationsCredits = obligations.reduce(
    (sum, o) => sum + o.currentAmount,
    0
  );
  const totalObligationsNanoErg = BigInt(
    Math.round(totalObligationsCredits * NANO_PER_CREDIT)
  );

  // Coverage ratio
  const coverageRatio =
    totalObligationsNanoErg > 0
      ? Number(totalReserveValueNanoErg) / Number(totalObligationsNanoErg)
      : totalReserveValueNanoErg > 0
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
    if (o.currentAmount <= 0) {
      settlementReadiness = "no-debt";
    } else if (!reserve || reserve.lifecycle !== "active") {
      settlementReadiness = "reserve-inactive";
    } else if (pendingByObligation.has(o.id)) {
      settlementReadiness = "pending-redemption";
    } else if (
      reserve.valueNanoErg <
      BigInt(Math.round(o.currentAmount * NANO_PER_CREDIT))
    ) {
      settlementReadiness = "insufficient-reserve";
    }

    return {
      id: o.id,
      providerId: o.providerId,
      providerName: o.provider.name,
      customerId: o.customerId,
      customerName: o.customer.name,
      currentAmount: o.currentAmount,
      version: o.version,
      settlementStatus: o.settlementStatus,
      debtorPubKey: o.debtorPubKey,
      creditorPubKey: o.creditorPubKey,
      latestSignature: o.latestSignature,
      creditLimit: cl?.limitAmount ?? null,
      alertThreshold: cl?.alertThreshold ?? null,
      reserveId: reserve?.id ?? null,
      settlementReadiness,
    };
  });

  // --- Phase 1b: Authority / delegation visibility ---

  // Delegations for pool customers only
  const delegations = await prisma.delegation.findMany({
    where: { customerId: { in: poolCustomerIds } },
    include: { customer: true },
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
    const utilization = d.spendCap > 0 ? d.spentSoFar / d.spendCap : 0;
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
      sessionPubKey: d.sessionPubKey,
      scopeProviders,
      scopeTools,
      spendCap: d.spendCap,
      spentSoFar: d.spentSoFar,
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
      customer: { id: r.customer.id, name: r.customer.name, publicKey: r.customer.publicKey },
    })),
    obligations: obligationsWithReadiness,
    poolHealth: {
      totalReserveValueNanoErg: totalReserveValueNanoErg.toString(),
      totalObligationsCredits,
      coverageRatio: coverageRatio === Infinity ? null : Math.round(coverageRatio * 100) / 100,
      poolStatus,
    },
    authority: {
      delegations: delegationsWithCompliance,
      summary: authoritySummary,
    },
  });
}
