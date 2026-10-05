-- pgvector: taze DB'de de kurulu olsun (idempotent).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Memory_workspaceId_createdAt_idx" ON "Memory"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Memory_workspaceId_sourceType_sourceId_key" ON "Memory"("workspaceId", "sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HNSW index: cosine benzerligi icin yaklasik en-yakin-komsu. Buyuk tabloda
-- bile sabit-zamana yakin arama; kesin taramaya gore buyuk kazanc.
CREATE INDEX "Memory_embedding_hnsw_idx" ON "Memory"
  USING hnsw ("embedding" vector_cosine_ops);

-- RLS: Memory tenant verisidir. smith_app rolu politikaya tabi; migration
-- rolu (smith, superuser) bypass eder. Set edilmemis workspace_id → NULL
-- karsilastirmasi → sifir satir (fail-closed). rlsPolicyFor ile ayni desen.
ALTER TABLE "Memory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Memory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Memory_workspace_isolation" ON "Memory";
CREATE POLICY "Memory_workspace_isolation" ON "Memory"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

-- smith_app rolune yeni tabloda yetki.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Memory" TO smith_app;
