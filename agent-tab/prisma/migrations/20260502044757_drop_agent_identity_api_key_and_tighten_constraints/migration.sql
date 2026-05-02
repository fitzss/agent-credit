-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPreview" TEXT NOT NULL,
    "allowedToolIds" TEXT NOT NULL DEFAULT '*',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AgentIdentity" ("allowedToolIds", "apiKeyHash", "apiKeyPreview", "createdAt", "customerId", "id", "label", "status", "updatedAt") SELECT "allowedToolIds", "apiKeyHash", "apiKeyPreview", "createdAt", "customerId", "id", "label", "status", "updatedAt" FROM "AgentIdentity";
DROP TABLE "AgentIdentity";
ALTER TABLE "new_AgentIdentity" RENAME TO "AgentIdentity";
CREATE UNIQUE INDEX "AgentIdentity_apiKeyHash_key" ON "AgentIdentity"("apiKeyHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
