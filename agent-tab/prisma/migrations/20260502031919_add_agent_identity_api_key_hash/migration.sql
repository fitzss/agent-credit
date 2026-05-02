-- AlterTable
ALTER TABLE "AgentIdentity" ADD COLUMN "apiKeyHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_apiKeyHash_key" ON "AgentIdentity"("apiKeyHash");
