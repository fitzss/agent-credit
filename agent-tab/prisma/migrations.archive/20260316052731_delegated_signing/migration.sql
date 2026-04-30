/*
  Warnings:

  - The required column `nonce` was added to the `ObligationUpdate` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- CreateTable
CREATE TABLE "Delegation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "sessionPubKey" TEXT NOT NULL,
    "scopeProviderIds" TEXT NOT NULL DEFAULT '*',
    "scopeToolIds" TEXT NOT NULL DEFAULT '*',
    "spendCap" REAL NOT NULL,
    "spentSoFar" REAL NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "authMessage" TEXT NOT NULL,
    "authSignature" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Delegation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ObligationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "currentAmount" REAL NOT NULL DEFAULT 0,
    "pendingAmount" REAL NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "debtorPubKey" TEXT NOT NULL DEFAULT '',
    "creditorPubKey" TEXT NOT NULL DEFAULT '',
    "latestSignedMessage" TEXT,
    "latestSignature" TEXT,
    "settlementStatus" TEXT NOT NULL DEFAULT 'current',
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObligationState_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ObligationState_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ObligationState" ("createdAt", "creditorPubKey", "currentAmount", "customerId", "debtorPubKey", "id", "lastUpdatedAt", "latestSignature", "latestSignedMessage", "providerId", "settlementStatus", "version") SELECT "createdAt", "creditorPubKey", "currentAmount", "customerId", "debtorPubKey", "id", "lastUpdatedAt", "latestSignature", "latestSignedMessage", "providerId", "settlementStatus", "version" FROM "ObligationState";
DROP TABLE "ObligationState";
ALTER TABLE "new_ObligationState" RENAME TO "ObligationState";
CREATE UNIQUE INDEX "ObligationState_providerId_customerId_key" ON "ObligationState"("providerId", "customerId");
CREATE TABLE "new_ObligationUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationStateId" TEXT NOT NULL,
    "delegationId" TEXT,
    "version" INTEGER NOT NULL,
    "previousAmount" REAL NOT NULL,
    "newAmount" REAL NOT NULL,
    "delta" REAL NOT NULL,
    "canonicalMessage" TEXT NOT NULL,
    "signature" TEXT NOT NULL DEFAULT '',
    "signatureStatus" TEXT NOT NULL DEFAULT 'signed',
    "type" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObligationUpdate_obligationStateId_fkey" FOREIGN KEY ("obligationStateId") REFERENCES "ObligationState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ObligationUpdate_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "Delegation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ObligationUpdate" ("canonicalMessage", "delta", "id", "newAmount", "obligationStateId", "previousAmount", "signature", "signatureStatus", "timestamp", "type", "version") SELECT "canonicalMessage", "delta", "id", "newAmount", "obligationStateId", "previousAmount", "signature", "signatureStatus", "timestamp", "type", "version" FROM "ObligationUpdate";
DROP TABLE "ObligationUpdate";
ALTER TABLE "new_ObligationUpdate" RENAME TO "ObligationUpdate";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
