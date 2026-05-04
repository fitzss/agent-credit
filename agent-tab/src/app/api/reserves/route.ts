import { prisma } from "@/lib/prisma";
import { deployReserve, getReserveStatus, deriveContractVersion } from "@/lib/sidecar-client";
import { NextRequest, NextResponse } from "next/server";
import { requireOperator, authErrorResponse } from "@/lib/auth";

/**
 * Reserve management — app-layer endpoints that bridge to JVM sidecar.
 */

export async function GET(req: NextRequest) {
  const customerId = req.nextUrl.searchParams.get("customerId");
  const where = customerId ? { customerId } : {};
  const reserves = await prisma.reserve.findMany({ where, orderBy: { createdAt: "desc" } });
  const serializable = reserves.map(r => ({ ...r, valueNanoErg: r.valueNanoErg.toString() }));
  return NextResponse.json(serializable);
}

/**
 * Create a reserve deployment request.
 * Calls the JVM sidecar to generate the Ergo deployment transaction.
 * Stores the reserve record in lifecycle state "requested".
 */
export async function POST(req: NextRequest) {
  try {
    await requireOperator();
  } catch (e) {
    return authErrorResponse(e);
  }

  const body = await req.json();
  const { customerId, trackerNftId, reserveTokenId, initialCollateralNanoErg } = body;

  if (!customerId || !trackerNftId || !reserveTokenId) {
    return NextResponse.json(
      { error: "Missing required fields: customerId, trackerNftId, reserveTokenId" },
      { status: 400 }
    );
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  try {
    // Call JVM sidecar for deployment request generation
    const deployResult = await deployReserve({
      ownerPubKeyHex: customer.publicKey,
      trackerNftId,
      reserveTokenId,
      initialCollateralNanoErg: initialCollateralNanoErg || 1000000000,
    });

    // Derive contract version from the deployed address
    const contractVersion = await deriveContractVersion(deployResult.reserveAddress);

    // Store reserve record
    const reserve = await prisma.reserve.create({
      data: {
        customerId,
        debtorPubKey: customer.publicKey,
        reserveTokenId,
        trackerNftId,
        reserveAddress: deployResult.reserveAddress,
        contractVersion,
        lifecycle: "requested",
      },
    });

    return NextResponse.json({
      reserve,
      deployment: deployResult,
    }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Sidecar error: ${msg}` }, { status: 502 });
  }
}

/**
 * Refresh reserve status from Ergo testnet (via sidecar).
 * Computes redeemability based on identity match between
 * customer pubkey, obligation debtorPubKey, and on-chain R4 ownerPubKey.
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { reserveId } = body;

  if (!reserveId) {
    return NextResponse.json({ error: "Missing reserveId" }, { status: 400 });
  }

  const reserve = await prisma.reserve.findUnique({
    where: { id: reserveId },
    include: { customer: true },
  });
  if (!reserve) {
    return NextResponse.json({ error: "Reserve not found" }, { status: 404 });
  }

  try {
    const status = await getReserveStatus(reserve.reserveTokenId);

    if (status.found) {
      // Re-derive contract version from stored reserveAddress on each refresh
      const contractVersion = await deriveContractVersion(reserve.reserveAddress);

      const updated = await prisma.reserve.update({
        where: { id: reserveId },
        data: {
          boxId: status.boxId,
          valueNanoErg: BigInt(status.valueNanoErg ?? 0),
          avlTreeDigest: status.avlTreeDigest,
          creationHeight: status.creationHeight,
          contractVersion,
          lifecycle: "active",
        },
      });

      // Redeemability check: customer pubkey must match on-chain R4
      const onChainOwner = status.ownerPubKey ?? "";
      const customerKey = reserve.customer.publicKey;
      const dbDebtorKey = reserve.debtorPubKey;
      const identityMatch = onChainOwner === customerKey && customerKey === dbDebtorKey;
      const onChainTrackerMatch = status.trackerNftId === reserve.trackerNftId;

      const redeemability = {
        redeemable: identityMatch && onChainTrackerMatch,
        checks: {
          customerKeyMatchesOnChainR4: onChainOwner === customerKey,
          debtorPubKeyMatchesCustomer: dbDebtorKey === customerKey,
          trackerNftIdMatchesOnChain: onChainTrackerMatch,
          onChainOwnerPubKey: onChainOwner,
          customerPubKey: customerKey,
          reserveDebtorPubKey: dbDebtorKey,
        },
      };

      const serializable = { ...updated, valueNanoErg: updated.valueNanoErg.toString() };
      return NextResponse.json({ reserve: serializable, onChainStatus: status, redeemability });
    } else {
      const serializable = { ...reserve, valueNanoErg: reserve.valueNanoErg.toString() };
      return NextResponse.json({
        reserve: serializable,
        onChainStatus: status,
        note: "Reserve not yet found on-chain. It may still be in the mempool.",
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Sidecar error: ${msg}` }, { status: 502 });
  }
}
