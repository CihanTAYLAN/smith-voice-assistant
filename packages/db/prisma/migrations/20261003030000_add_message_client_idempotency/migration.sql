-- AlterTable
ALTER TABLE "Message" ADD COLUMN "clientMessageId" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_clientMessageId_key" ON "Message"("workspaceId", "clientMessageId");

-- Existing Message RLS policy remains unchanged. PostgreSQL unique indexes
-- permit multiple NULL values, preserving unkeyed append behavior.
