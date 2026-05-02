/**
 * Backfill apiKeyHash for AgentIdentity rows that pre-date slice 8A.
 *
 * Idempotent: rows with apiKeyHash already set are skipped. Safe to re-run.
 *
 * Usage:
 *   cd agent-tab && npx tsx scripts/backfill-agent-key-hash.ts
 */

import { PrismaClient } from "@prisma/client";
import { hashAgentApiKey } from "../src/lib/agent-key-hash";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.agentIdentity.findMany({
    where: { apiKeyHash: null },
    select: { id: true, label: true, apiKey: true },
  });

  console.log(`Found ${rows.length} AgentIdentity row(s) needing backfill.`);

  let populated = 0;
  for (const row of rows) {
    const apiKeyHash = hashAgentApiKey(row.apiKey);
    await prisma.agentIdentity.update({
      where: { id: row.id },
      data: { apiKeyHash },
    });
    populated++;
    console.log(`  populated id=${row.id} label=${row.label}`);
  }

  console.log(`Done. Populated ${populated} row(s).`);
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
