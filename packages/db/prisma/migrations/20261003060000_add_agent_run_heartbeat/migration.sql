-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

-- Existing AgentRun RLS policy remains unchanged. The column is nullable on
-- purpose: rows that were already running keep NULL and claimRun reads that
-- as startedAt, so no backfill is needed (and none would pass FORCE RLS).
