-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_workspaceId_surface_key" ON "Device"("workspaceId", "surface");

-- CreateIndex
CREATE INDEX "Device_workspaceId_lastSeenAt_idx" ON "Device"("workspaceId", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: Device tenant verisidir. smith_app rolu politikaya tabi; migration rolu
-- (smith, superuser) bypass eder. Set edilmemis workspace_id → NULL karsilastirmasi
-- → sifir satir (fail-closed). Memory/Session ile ayni desen.
ALTER TABLE "Device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Device" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Device_workspace_isolation" ON "Device";
CREATE POLICY "Device_workspace_isolation" ON "Device"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

-- smith_app rolune yeni tabloda yetki.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Device" TO smith_app;
