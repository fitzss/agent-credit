import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

/**
 * Phase 1a: Pool summary endpoint.
 * Assembles pool health, reserve state, obligation readiness, and
 * basic tracker info from Prisma only (never calls the sidecar).
 *
 * Policy / authority model is deferred to Phase 1b.
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
  });
}
