-- CreateTable
CREATE TABLE "Reserve" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "debtorPubKey" TEXT NOT NULL,
    "reserveTokenId" TEXT NOT NULL,
    "trackerNftId" TEXT NOT NULL,
    "boxId" TEXT,
    "valueNanoErg" BIGINT NOT NULL DEFAULT 0,
    "avlTreeDigest" TEXT,
    "creationHeight" INTEGER,
    "reserveAddress" TEXT,
    "lifecycle" TEXT NOT NULL DEFAULT 'requested',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reserve_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Reserve_reserveTokenId_key" ON "Reserve"("reserveTokenId");
