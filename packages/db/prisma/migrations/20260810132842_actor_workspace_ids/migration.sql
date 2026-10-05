-- AlterTable
ALTER TABLE "Actor" ADD COLUMN     "workspaceIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: bu alan eklenmeden once yazilmis Actor satirlari (ornegin
-- prisma/seed.ts ile olusturulmus cihan-personal/tenant-b-demo) gercek
-- Membership satirlarina sahip ama workspaceIds bos kalir. Var olan
-- Membership'lerden tek seferlik cikarim yapilir; bundan sonrasi uygulama
-- katmaninin sorumlulugundadir (bkz. schema.prisma Actor yorumu).
UPDATE "Actor" a
SET "workspaceIds" = COALESCE(
  (SELECT array_agg(m."workspaceId") FROM "Membership" m WHERE m."actorId" = a.id),
  ARRAY[]::TEXT[]
);
