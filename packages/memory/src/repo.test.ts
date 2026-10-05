import { createWorkspaceScope, ForbiddenError, type Role } from '@smith/tenancy';
import { describe, expect, it, vi } from 'vitest';

import { countMemories, deleteMemory, listMemories, searchMemories, upsertMemory } from './repo.js';

/**
 * Profil hafizasinin (sourceType 'profile') ihtiyac duydugu genel sorgular.
 * Sahte transaction yalniz Prisma'ya giden `where` bicimini yakalar: tenant
 * filtresi ve gizlilik filtresi veritabanina GIDIYOR mu (TS tarafinda
 * suzulup gecmiyor mu) sorusunun cevabi buradadir.
 */

const WORKSPACE_ID = 'ws_aaaaaaaaaaaaaaaaaaaa';
const ACTOR_ID = 'act_bbbbbbbbbbbbbbbbbbbb';

const scopeOf = (role: Role) =>
  createWorkspaceScope({ workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, role });

interface Where {
  workspaceId?: string;
  sourceType?: string;
  sourceId?: string;
  sensitivity?: { in: string[] };
}

function fakeTx(result: { deleted?: number; counted?: number } = {}) {
  const findMany = vi.fn((_args: { where: Where }) => Promise.resolve([]));
  const deleteMany = vi.fn((_args: { where: Where }) =>
    Promise.resolve({ count: result.deleted ?? 1 }),
  );
  const count = vi.fn((_args: { where: Where }) => Promise.resolve(result.counted ?? 0));
  return { tx: { memory: { findMany, deleteMany, count } } as never, findMany, deleteMany, count };
}

describe('listMemories gizlilik filtresi', () => {
  it('allowedSensitivity verilmezse sinif filtresi YOK (dashboard secret dahil gorur)', async () => {
    const { tx, findMany } = fakeTx();

    await listMemories(tx, scopeOf('member'), { sourceType: 'profile' });

    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceType: 'profile',
      status: 'active',
    });
  });

  it('allowedSensitivity SQL where kosuluna girer, tenant ve tur filtresi yerinde kalir', async () => {
    const { tx, findMany } = fakeTx();

    await listMemories(tx, scopeOf('viewer'), {
      sourceType: 'profile',
      allowedSensitivity: ['public', 'personal'],
    });

    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceType: 'profile',
      sensitivity: { in: ['public', 'personal'] },
      status: 'active',
    });
  });

  it('dashboard listesinden sourceId ve keyword eslesen kayitlari savunma olarak cikarir', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'mem_1',
        content: 'Acme karari',
        sourceType: 'note',
        sourceId: 'note:1',
        sensitivity: 'personal',
        createdAt: new Date('2026-10-03T00:00:00Z'),
        status: 'active',
        supersededById: null,
      },
      {
        id: 'mem_2',
        content: 'temiz',
        sourceType: 'obsidian',
        sourceId: 'obsidian:acme/a.md',
        sensitivity: 'personal',
        createdAt: new Date('2026-10-03T00:00:00Z'),
        status: 'active',
        supersededById: null,
      },
      {
        id: 'mem_3',
        content: 'Globex karari',
        sourceType: 'note',
        sourceId: 'note:3',
        sensitivity: 'personal',
        createdAt: new Date('2026-10-03T00:00:00Z'),
        status: 'active',
        supersededById: null,
      },
    ]);
    const tx = { memory: { findMany } } as never;

    const rows = await listMemories(tx, scopeOf('viewer'), {
      contextExclude: 'obsidian:acme/*,kw:acme',
    });

    expect(rows.map((row) => row.id)).toEqual(['mem_3']);
  });
});

describe('hafiza dislama kapilari', () => {
  it('eslesen yaziyi kilit ve SQL calistirmadan atlar', async () => {
    const execute = vi.fn();

    await upsertMemory({ $executeRaw: execute } as never, scopeOf('member'), {
      sourceType: 'obsidian',
      sourceId: 'obsidian:ACME/a.md',
      content: 'not',
      embedding: [1],
      contextExclude: 'obsidian:acme/*',
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('recall sonucundan eslesen kayitlari asla dondurmez', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        id: 'mem_1',
        content: 'Acme karari',
        sourceType: 'note',
        sourceId: 'note:1',
        similarity: 0.99,
      },
      {
        id: 'mem_2',
        content: 'Globex karari',
        sourceType: 'note',
        sourceId: 'note:2',
        similarity: 0.8,
      },
    ]);

    const rows = await searchMemories({ $queryRaw: query } as never, scopeOf('viewer'), [1], {
      contextExclude: 'kw:acme',
    });

    expect(rows.map((row) => row.id)).toEqual(['mem_2']);
  });
});

describe('deleteMemory', () => {
  const source = { sourceType: 'profile', sourceId: 'profile:sehir' };

  it('yalniz (workspaceId, sourceType, sourceId) ucluyle tek kaynagi siler', async () => {
    const { tx, deleteMany } = fakeTx({ deleted: 1 });

    await expect(deleteMemory(tx, scopeOf('member'), source)).resolves.toBe(true);

    expect(deleteMany.mock.calls[0]?.[0].where).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceType: 'profile',
      sourceId: 'profile:sehir',
    });
  });

  it('satir yoksa false doner ve hata atmaz (idempotent)', async () => {
    const { tx } = fakeTx({ deleted: 0 });

    await expect(deleteMemory(tx, scopeOf('member'), source)).resolves.toBe(false);
  });

  it('viewer silemez: veritabanina inmeden ForbiddenError', async () => {
    const { tx, deleteMany } = fakeTx();

    await expect(deleteMemory(tx, scopeOf('viewer'), source)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('countMemories', () => {
  it('workspace ve tur ile sayar', async () => {
    const { tx, count } = fakeTx({ counted: 7 });

    await expect(countMemories(tx, scopeOf('viewer'), { sourceType: 'profile' })).resolves.toBe(7);

    expect(count.mock.calls[0]?.[0].where).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceType: 'profile',
      status: 'active',
    });
  });
});
