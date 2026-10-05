-- MANUAL ONLY. Prisma does not execute this file during migrate deploy.
-- Destructive: client message idempotency protection is removed.
-- For a successfully applied migration, use this SQL in a NEW forward migration.
BEGIN;
DROP INDEX "Message_workspaceId_clientMessageId_key";
ALTER TABLE "Message" DROP COLUMN "clientMessageId";
COMMIT;
