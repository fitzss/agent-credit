/**
 * Backfill apiKeyPreview for AgentIdentity rows that pre-date slice 8B-1.
 *
 * Idempotent: rows with apiKeyPreview already set are skipped. Safe to re-run.
 *
 * Preview format: "…" + last 4 chars of raw apiKey, matching the slice-7
 * derived format that the customer page already renders.
 *
 * Usage:
 *   cd agent-tab && npx tsx scripts/backfill-agent-key-preview.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function previewFromRaw(rawKey: string): string {
  return `…${rawKey.slice(-4)}`;
}

async function main() {
  const rows = await prisma.agentIdentity.findMany({
    where: { apiKeyPreview: null },
    select: { id: true, label: true, apiKey: true },
  });

  console.log(`Found ${rows.length} AgentIdentity row(s) needing backfill.`);

  let populated = 0;
  for (const row of rows) {
    const apiKeyPreview = previewFromRaw(row.apiKey);
    await prisma.agentIdentity.update({
      where: { id: row.id },
      data: { apiKeyPreview },
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
