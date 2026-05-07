/**
 * Default operator + ownership backfill (production envelope, slice 2).
 *
 * Idempotent. Upserts one operator User by email, then claims every
 * Customer with ownerUserId = null for that user. Customers that already
 * have an owner are left untouched.
 *
 * Env:
 *   DEFAULT_OPERATOR_EMAIL  — required in production. In dev falls back
 *                             to operator@agent-credit.local.
 *
 * Usage:
 *   npx tsx scripts/backfill-default-operator.ts
 *   # or
 *   npm run backfill:operator
 */

import { PrismaClient } from "@prisma/client";

const DEV_DEFAULT_EMAIL = "operator@agent-credit.local";

async function main(): Promise<void> {
  const isProd = process.env.NODE_ENV === "production";
  const email =
    process.env.DEFAULT_OPERATOR_EMAIL ?? (isProd ? null : DEV_DEFAULT_EMAIL);

  if (!email) {
    console.error(
      "DEFAULT_OPERATOR_EMAIL is required when NODE_ENV=production. " +
        "Set it before running this script.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    // Snapshot pre-state: how many customers already had a non-null owner
    // before this run. The transaction below only touches null-owner rows,
    // so this number is invariant across the run.
    const alreadyOwned = await prisma.customer.count({
      where: { ownerUserId: { not: null } },
    });

    const { operator, claim } = await prisma.$transaction(async (tx) => {
      const operator = await tx.user.upsert({
        where: { email },
        // On re-run, re-assert the operator role in case it was edited.
        update: { role: "operator" },
        // Pre-set emailVerified: this user is provisioned internally, not
        // through the magic-link signup path.
        create: {
          email,
          role: "operator",
          emailVerified: new Date(),
        },
      });

      const claim = await tx.customer.updateMany({
        where: { ownerUserId: null },
        data: { ownerUserId: operator.id },
      });

      return { operator, claim };
    });

    console.log("operator email      :", operator.email);
    console.log("operator user id    :", operator.id);
    console.log("customers assigned  :", claim.count);
    console.log("customers already   :", alreadyOwned);
  } catch (err) {
    console.error("backfill failed:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
