-- Mission Control tablolari (ADR 0007).
--
-- ELLE DUZELTME 1: Prisma bu migration'i uretirken basa
-- `DROP INDEX "Memory_embedding_hnsw_idx"` koydu ve o satir SILINDI. Sebep:
-- HNSW indeksi elle yazilmis bir migration'dan gelir (pgvector operator
-- class'i Prisma semasinda ifade edilemez), dolayisiyla Prisma onu "fazlalik"
-- sanip her yeni migration'da dusurmek ister. Kosmasina izin verilseydi
-- semantik arama sessizce kesin taramaya duser, hicbir test kirmizi olmaz ve
-- yavaslama uretimde ortaya cikardi. Yeni migration uretilirken bu satir HER
-- SEFERINDE silinmelidir.
--
-- ELLE DUZELTME 2: RLS politikalari ve smith_app yetkileri dosyanin sonuna
-- eklendi (Prisma bunlari uretmez).

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "soul" TEXT NOT NULL,
    "model" TEXT,
    "parentId" TEXT,
    "device" TEXT NOT NULL DEFAULT 'wsl',
    "workRoots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'inbox',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "assigneeId" TEXT,
    "parentId" TEXT,
    "deliverable" TEXT,
    "artifactPath" TEXT,
    "createdBy" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "agentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'note',
    "body" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "agentId" TEXT,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'claude-code',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "externalSessionId" TEXT,
    "exitCode" INTEGER,
    "costMicros" INTEGER DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "logPath" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_workspaceId_status_idx" ON "Agent"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_workspaceId_slug_key" ON "Agent"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "Task_workspaceId_status_priority_idx" ON "Task"("workspaceId", "status", "priority");

-- CreateIndex
CREATE INDEX "Task_workspaceId_assigneeId_idx" ON "Task"("workspaceId", "assigneeId");

-- CreateIndex
CREATE INDEX "TaskComment_workspaceId_taskId_createdAt_idx" ON "TaskComment"("workspaceId", "taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskEvent_workspaceId_createdAt_idx" ON "TaskEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_taskId_idx" ON "AgentRun"("workspaceId", "taskId");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_agentId_startedAt_idx" ON "AgentRun"("workspaceId", "agentId", "startedAt");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS: bes tablonun tamami tenant verisidir. smith_app rolu politikaya
-- tabidir; migration rolu (smith, superuser) bypass eder. Oturum degiskeni
-- set edilmemisse current_setting(...) NULL doner ve karsilastirma hicbir
-- satiri getirmez → fail-closed. rlsPolicyFor ile ayni desen.
-- ---------------------------------------------------------------------------

ALTER TABLE "Agent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Agent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Agent_workspace_isolation" ON "Agent";
CREATE POLICY "Agent_workspace_isolation" ON "Agent"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Task_workspace_isolation" ON "Task";
CREATE POLICY "Task_workspace_isolation" ON "Task"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

ALTER TABLE "TaskComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskComment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TaskComment_workspace_isolation" ON "TaskComment";
CREATE POLICY "TaskComment_workspace_isolation" ON "TaskComment"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

ALTER TABLE "TaskEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TaskEvent_workspace_isolation" ON "TaskEvent";
CREATE POLICY "TaskEvent_workspace_isolation" ON "TaskEvent"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

ALTER TABLE "AgentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AgentRun_workspace_isolation" ON "AgentRun";
CREATE POLICY "AgentRun_workspace_isolation" ON "AgentRun"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

-- smith_app rolune yeni tablolarda yetki. TaskEvent append-only olsun diye
-- UPDATE/DELETE VERILMEZ: akis bir kayittir, gecmisi degistirme yolu yoktur.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Agent" TO smith_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Task" TO smith_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TaskComment" TO smith_app;
GRANT SELECT, INSERT ON "TaskEvent" TO smith_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentRun" TO smith_app;
