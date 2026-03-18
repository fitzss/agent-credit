-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL DEFAULT '',
    "privateKey" TEXT NOT NULL DEFAULT '',
    "signingMode" TEXT NOT NULL DEFAULT 'tracker',
    "contactEmail" TEXT,
    "defaultSettlementTerms" TEXT NOT NULL DEFAULT 'net30',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Customer" ("contactEmail", "createdAt", "defaultSettlementTerms", "id", "name", "privateKey", "publicKey", "status", "updatedAt") SELECT "contactEmail", "createdAt", "defaultSettlementTerms", "id", "name", "privateKey", "publicKey", "status", "updatedAt" FROM "Customer";
DROP TABLE "Customer";
ALTER TABLE "new_Customer" RENAME TO "Customer";
CREATE TABLE "new_ObligationUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationStateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousAmount" REAL NOT NULL,
    "newAmount" REAL NOT NULL,
    "delta" REAL NOT NULL,
    "canonicalMessage" TEXT NOT NULL,
    "signature" TEXT NOT NULL DEFAULT '',
    "signatureStatus" TEXT NOT NULL DEFAULT 'signed',
    "type" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObligationUpdate_obligationStateId_fkey" FOREIGN KEY ("obligationStateId") REFERENCES "ObligationState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ObligationUpdate" ("canonicalMessage", "delta", "id", "newAmount", "obligationStateId", "previousAmount", "signature", "timestamp", "type", "version") SELECT "canonicalMessage", "delta", "id", "newAmount", "obligationStateId", "previousAmount", "signature", "timestamp", "type", "version" FROM "ObligationUpdate";
DROP TABLE "ObligationUpdate";
ALTER TABLE "new_ObligationUpdate" RENAME TO "ObligationUpdate";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
