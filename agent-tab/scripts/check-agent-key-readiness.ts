/**
 * Pre-flight check for slice 8B-2 destructive migration.
 *
 * Asserts:
 *   - every AgentIdentity row has non-null apiKeyHash
 *   - every AgentIdentity row has non-null apiKeyPreview
 *   - no two rows share the same apiKeyHash
 *
 * Exits 0 if safe to apply slice 8B-2 migration.
 * Exits 1 if any check fails. The migration MUST NOT be applied if this
 * script returns nonzero — the redefine-table INSERT…SELECT would either
 * abort on NOT NULL or silently violate the new unique index.
 *
 * Usage:
 *   cd agent-tab && npx tsx scripts/check-agent-key-readiness.ts
 */

import { PrismaClient } from "@prisma/client";

// Raw SQL is used here intentionally. Once slice 8B-2 has applied, the typed
// Prisma schema forbids `where: { apiKeyHash: null }` because the column is
// NOT NULL — but the script must still be runnable to verify the state of an
// older DB (one that pre-dates 8B-2) before re-running the migration on it.

type CountRow = { c: bigint };

async function main() {
  const prisma = new PrismaClient();
  try {
    const [{ c: total }] = await prisma.$queryRawUnsafe<CountRow[]>(
      `SELECT COUNT(*) AS c FROM "AgentIdentity"`,
    );
    const [{ c: nullHash }] = await prisma.$queryRawUnsafe<CountRow[]>(
      `SELECT COUNT(*) AS c FROM "AgentIdentity" WHERE "apiKeyHash" IS NULL`,
    );
    const [{ c: nullPreview }] = await prisma.$queryRawUnsafe<CountRow[]>(
      `SELECT COUNT(*) AS c FROM "AgentIdentity" WHERE "apiKeyPreview" IS NULL`,
    );
    const dupRows = await prisma.$queryRawUnsafe<{ apiKeyHash: string; c: bigint }[]>(
      `SELECT "apiKeyHash", COUNT(*) AS c FROM "AgentIdentity" GROUP BY "apiKeyHash" HAVING COUNT(*) > 1`,
    );

    const result = {
      total: Number(total),
      nullHash: Number(nullHash),
      nullPreview: Number(nullPreview),
      dupHashes: dupRows.length,
    };
    const ok = result.nullHash === 0 && result.nullPreview === 0 && result.dupHashes === 0;

    console.log(JSON.stringify({ ...result, ok }, null, 2));

    if (!ok) {
      console.error("Readiness check FAILED. Do not apply slice 8B-2 migration.");
      process.exit(1);
    }
    console.log("OK — safe to apply slice 8B-2 migration.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Readiness check error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
