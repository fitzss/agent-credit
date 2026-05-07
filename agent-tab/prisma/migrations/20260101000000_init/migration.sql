-- CreateTable
CREATE TABLE "Provider" (
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

-- CreateTable
CREATE TABLE "Customer" (
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

-- CreateTable
CREATE TABLE "AgentIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "allowedToolIds" TEXT NOT NULL DEFAULT '*',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "endpoint" TEXT NOT NULL,
    "costPerCall" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tool_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreditLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "limitAmount" BIGINT NOT NULL,
    "alertThreshold" REAL NOT NULL DEFAULT 0.8,
    "dueDays" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CreditLine_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CreditLine_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Delegation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "agentIdentityId" TEXT,
    "sessionPubKey" TEXT NOT NULL,
    "scopeProviderIds" TEXT NOT NULL DEFAULT '*',
    "scopeToolIds" TEXT NOT NULL DEFAULT '*',
    "spendCap" BIGINT NOT NULL,
    "spentSoFar" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "authMessage" TEXT NOT NULL,
    "authSignature" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Delegation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Delegation_agentIdentityId_fkey" FOREIGN KEY ("agentIdentityId") REFERENCES "AgentIdentity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ObligationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "currentAmount" BIGINT NOT NULL DEFAULT 0,
    "pendingAmount" BIGINT NOT NULL DEFAULT 0,
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

-- CreateTable
CREATE TABLE "ObligationUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationStateId" TEXT NOT NULL,
    "delegationId" TEXT,
    "agentIdentityId" TEXT,
    "version" INTEGER NOT NULL,
    "previousAmount" BIGINT NOT NULL,
    "newAmount" BIGINT NOT NULL,
    "delta" BIGINT NOT NULL,
    "canonicalMessage" TEXT NOT NULL,
    "signature" TEXT NOT NULL DEFAULT '',
    "signatureStatus" TEXT NOT NULL DEFAULT 'signed',
    "type" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObligationUpdate_obligationStateId_fkey" FOREIGN KEY ("obligationStateId") REFERENCES "ObligationState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ObligationUpdate_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "Delegation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

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
    "contractVersion" TEXT NOT NULL DEFAULT 'v1',
    "lifecycle" TEXT NOT NULL DEFAULT 'requested',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reserve_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentIdentityId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amountCharged" BIGINT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestRef" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    CONSTRAINT "UsageEvent_agentIdentityId_fkey" FOREIGN KEY ("agentIdentityId") REFERENCES "AgentIdentity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UsageEvent_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UsageEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UsageEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SettlementEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationStateId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "redemptionTxId" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettlementEvent_obligationStateId_fkey" FOREIGN KEY ("obligationStateId") REFERENCES "ObligationState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PendingRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "txId" TEXT NOT NULL,
    "reserveId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "grossRedeemNanoErg" BIGINT NOT NULL,
    "feeNanoErg" BIGINT NOT NULL DEFAULT 0,
    "netPayoutNanoErg" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PendingRedemption_reserveId_fkey" FOREIGN KEY ("reserveId") REFERENCES "Reserve" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PendingRedemption_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "ObligationState" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackerDeployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackerNftId" TEXT NOT NULL,
    "debtorPubKey" TEXT NOT NULL,
    "creditorPubKey" TEXT NOT NULL,
    "totalDebtNanoErg" BIGINT NOT NULL,
    "boxId" TEXT NOT NULL,
    "trackerPubKeyHex" TEXT NOT NULL,
    "treeDigestHex" TEXT NOT NULL,
    "txId" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TrackerBox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackerNftId" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "trackerPubKeyHex" TEXT NOT NULL,
    "treeDigestHex" TEXT NOT NULL,
    "txId" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TrackerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackerBoxId" TEXT NOT NULL,
    "debtorPubKey" TEXT NOT NULL,
    "creditorPubKey" TEXT NOT NULL,
    "totalDebtNanoErg" BIGINT NOT NULL,
    CONSTRAINT "TrackerEntry_trackerBoxId_fkey" FOREIGN KEY ("trackerBoxId") REFERENCES "TrackerBox" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DebtTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromObligationId" TEXT NOT NULL,
    "toObligationId" TEXT NOT NULL,
    "amountCredits" BIGINT NOT NULL,
    "amountNanoErg" BIGINT NOT NULL,
    "debtorPubKey" TEXT NOT NULL,
    "fromCreditorPubKey" TEXT NOT NULL,
    "toCreditorPubKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_apiKey_key" ON "AgentIdentity"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLine_providerId_customerId_key" ON "CreditLine"("providerId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ObligationState_providerId_customerId_key" ON "ObligationState"("providerId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Reserve_reserveTokenId_key" ON "Reserve"("reserveTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementEvent_redemptionTxId_key" ON "SettlementEvent"("redemptionTxId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingRedemption_txId_key" ON "PendingRedemption"("txId");

-- CreateIndex
CREATE INDEX "TrackerDeployment_trackerNftId_debtorPubKey_creditorPubKey_isCurrent_idx" ON "TrackerDeployment"("trackerNftId", "debtorPubKey", "creditorPubKey", "isCurrent");

-- CreateIndex
CREATE INDEX "TrackerBox_trackerNftId_isCurrent_idx" ON "TrackerBox"("trackerNftId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "TrackerEntry_trackerBoxId_debtorPubKey_creditorPubKey_key" ON "TrackerEntry"("trackerBoxId", "debtorPubKey", "creditorPubKey");

