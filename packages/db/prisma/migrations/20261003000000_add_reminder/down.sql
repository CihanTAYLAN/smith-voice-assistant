-- MANUAL ONLY. Prisma does not execute this file during migrate deploy.
-- Destructive: back up Reminder data and stop reminder consumers first.
-- For a successfully applied migration, use this SQL in a NEW forward migration.
BEGIN;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "Reminder" FROM smith_app;
DROP POLICY "Reminder_workspace_isolation" ON "Reminder";
ALTER TABLE "Reminder" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" DROP CONSTRAINT "Reminder_actorId_fkey";
ALTER TABLE "Reminder" DROP CONSTRAINT "Reminder_workspaceId_fkey";
DROP INDEX "Reminder_workspaceId_actorId_idempotencyKey_key";
DROP INDEX "Reminder_workspaceId_deliveredAt_cancelledAt_dueAt_idx";
DROP TABLE "Reminder";
COMMIT;
