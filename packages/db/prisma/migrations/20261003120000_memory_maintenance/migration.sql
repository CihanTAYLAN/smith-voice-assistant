-- Kayitlar silinmez; onceki icerik ve yeni kayda baglanti korunur.
ALTER TABLE "Memory"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "supersededById" TEXT,
  ADD CONSTRAINT "Memory_status_check" CHECK ("status" IN ('active', 'superseded'));
CREATE INDEX "Memory_workspaceId_status_idx" ON "Memory"("workspaceId", "status");

CREATE TABLE "MemoryGap" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "sourceMemoryIds" TEXT[] NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "answer" TEXT,
  "answerMemoryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "askedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "MemoryGap_status_check" CHECK ("status" IN ('open', 'asked', 'answered', 'dismissed')),
  CONSTRAINT "MemoryGap_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MemoryGap_workspaceId_dedupeKey_key" ON "MemoryGap"("workspaceId", "dedupeKey");
CREATE INDEX "MemoryGap_workspaceId_status_createdAt_idx" ON "MemoryGap"("workspaceId", "status", "createdAt");

ALTER TABLE "MemoryGap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemoryGap" FORCE ROW LEVEL SECURITY;
CREATE POLICY "MemoryGap_workspace_isolation" ON "MemoryGap"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "MemoryGap" TO smith_app;
