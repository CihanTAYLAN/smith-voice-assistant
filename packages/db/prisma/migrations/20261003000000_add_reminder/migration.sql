-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "claimToken" TEXT,
    "claimExpiresAt" TIMESTAMPTZ(3),
    "idempotencyKey" VARCHAR(80),
    "source" TEXT NOT NULL DEFAULT 'voice',

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reminder_workspaceId_deliveredAt_cancelledAt_dueAt_idx" ON "Reminder"("workspaceId", "deliveredAt", "cancelledAt", "dueAt");
CREATE UNIQUE INDEX "Reminder_workspaceId_actorId_idempotencyKey_key" ON "Reminder"("workspaceId", "actorId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match the existing tenant policies: smith is the migration superuser;
-- smith_app is subject to RLS. An unset workspace setting fails closed.
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Reminder_workspace_isolation" ON "Reminder";
CREATE POLICY "Reminder_workspace_isolation" ON "Reminder"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "Reminder" TO smith_app;
