-- CreateTable
CREATE TABLE "ObligationUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationStateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousAmount" REAL NOT NULL,
    "newAmount" REAL NOT NULL,
    "delta" REAL NOT NULL,
    "canonicalMessage" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObligationUpdate_obligationStateId_fkey" FOREIGN KEY ("obligationStateId") REFERENCES "ObligationState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL DEFAULT '',
    "privateKey" TEXT NOT NULL DEFAULT '',
    "contactEmail" TEXT,
    "defaultSettlementTerms" TEXT NOT NULL DEFAULT 'net30',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Customer" ("contactEmail", "createdAt", "defaultSettlementTerms", "id", "name", "status", "updatedAt") SELECT "contactEmail", "createdAt", "defaultSettlementTerms", "id", "name", "status", "updatedAt" FROM "Customer";
DROP TABLE "Customer";
ALTER TABLE "new_Customer" RENAME TO "Customer";
CREATE TABLE "new_ObligationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "currentAmount" REAL NOT NULL DEFAULT 0,
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
INSERT INTO "new_ObligationState" ("createdAt", "currentAmount", "customerId", "id", "lastUpdatedAt", "providerId", "settlementStatus", "version") SELECT "createdAt", "currentAmount", "customerId", "id", "lastUpdatedAt", "providerId", "settlementStatus", "version" FROM "ObligationState";
DROP TABLE "ObligationState";
ALTER TABLE "new_ObligationState" RENAME TO "ObligationState";
CREATE UNIQUE INDEX "ObligationState_providerId_customerId_key" ON "ObligationState"("providerId", "customerId");
CREATE TABLE "new_Provider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL DEFAULT '',
    "privateKey" TEXT NOT NULL DEFAULT '',
    "settlementPrefs" TEXT NOT NULL DEFAULT 'manual',
    "defaultDueDays" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Provider" ("createdAt", "defaultDueDays", "id", "name", "settlementPrefs", "status", "updatedAt") SELECT "createdAt", "defaultDueDays", "id", "name", "settlementPrefs", "status", "updatedAt" FROM "Provider";
DROP TABLE "Provider";
ALTER TABLE "new_Provider" RENAME TO "Provider";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
