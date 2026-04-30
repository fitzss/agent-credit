/**
 * Read-only DB check: does the auth-demo fixture exist?
 *
 * Replaces the previous bash preflight that hit /api/pool/summary
 * unauthenticated. Pure read; never writes or modifies anything.
 *
 * Usage:
 *   npx tsx scripts/lib/check-auth-demo-fixture.ts
 *   # exit 0 if fixture present, exit 1 otherwise
 */
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const reserve = await prisma.reserve.findFirst({
      where: { id: { startsWith: "auth-demo" }, lifecycle: "active" },
      select: { id: true },
    });
    process.exit(reserve ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
