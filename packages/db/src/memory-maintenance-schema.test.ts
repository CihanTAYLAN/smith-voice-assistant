import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { newMemoryGapId } from './ids.js';

const sql = readFileSync(
  new URL('../prisma/migrations/20261003120000_memory_maintenance/migration.sql', import.meta.url),
  'utf8',
);
describe('hafiza bakimi migration sozlesmesi', () => {
  it('gap kimligi sozlesmeye uyar', () => {
    expect(newMemoryGapId()).toMatch(/^gap_[0-9a-z]{32}$/);
  });
  it('yeni tablo tenant, zorunlu RLS ve tekillik tasir', () => {
    expect(sql).toContain('"workspaceId" TEXT NOT NULL');
    expect(sql).toContain('ALTER TABLE "MemoryGap" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "MemoryGap" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('USING ("workspaceId" = current_setting(\'smith.workspace_id\', true))');
    expect(sql).toContain(
      'WITH CHECK ("workspaceId" = current_setting(\'smith.workspace_id\', true))',
    );
    expect(sql).toContain('ON "MemoryGap"("workspaceId", "dedupeKey")');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON "MemoryGap" TO smith_app');
  });
  it('eski kayitlar aktif kalir, durum degerleri CHECK ile sinirli', () => {
    expect(sql).toContain('"status" TEXT NOT NULL DEFAULT \'active\'');
    expect(sql).toContain("CHECK (\"status\" IN ('active', 'superseded'))");
    expect(sql).toContain("CHECK (\"status\" IN ('open', 'asked', 'answered', 'dismissed'))");
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM/i);
  });
});
