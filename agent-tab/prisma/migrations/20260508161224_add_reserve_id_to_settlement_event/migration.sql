-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SettlementEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationStateId" TEXT NOT NULL,
    "reserveId" TEXT,
    "amount" BIGINT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "redemptionTxId" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettlementEvent_obligationStateId_fkey" FOREIGN KEY ("obligationStateId") REFERENCES "ObligationState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SettlementEvent_reserveId_fkey" FOREIGN KEY ("reserveId") REFERENCES "Reserve" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SettlementEvent" ("amount", "id", "method", "obligationStateId", "redemptionTxId", "status", "timestamp") SELECT "amount", "id", "method", "obligationStateId", "redemptionTxId", "status", "timestamp" FROM "SettlementEvent";
DROP TABLE "SettlementEvent";
ALTER TABLE "new_SettlementEvent" RENAME TO "SettlementEvent";
CREATE UNIQUE INDEX "SettlementEvent_redemptionTxId_key" ON "SettlementEvent"("redemptionTxId");
CREATE INDEX "SettlementEvent_reserveId_idx" ON "SettlementEvent"("reserveId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
