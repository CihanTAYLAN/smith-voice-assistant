import type { Tx } from '@smith/db';
import { createWorkspaceScope } from '@smith/tenancy';
import { describe, expect, it, vi } from 'vitest';

import {
  answerMemoryGap,
  findMemoryGap,
  listMemoryGaps,
  openMemoryGap,
  transitionMemoryGap,
  MemoryGapConflict,
  memoryGapAnswerContent,
} from './gaps.js';
import { buildRecallBlock } from './recall.js';
import {
  consolidateMemories,
  findGapCandidates,
  findMemoryClusters,
  type MaintenanceMemory,
} from './maintenance-repo.js';
import { listMemories, searchMemories, upsertMemory } from './repo.js';

const scope = createWorkspaceScope({
  workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa',
  actorId: 'act_bbbbbbbbbbbbbbbbbbbb',
  role: 'member',
});
const sources: MaintenanceMemory[] = [1, 2, 3].map((i) => ({
  id: `mem_${i}`,
  content: `Cihan kahveyi sade icer ${i}`,
  sensitivity: 'personal',
  sourceType: 'note',
  sourceId: `note:${i}`,
}));

function fixture() {
  const rows = sources.map((s) => ({
    ...s,
    status: 'active',
    supersededById: null as string | null,
  }));
  const gaps: {
    id: string;
    workspaceId: string;
    sourceMemoryIds: string[];
    question: string;
    status: string;
    answer?: string;
    answerMemoryId?: string;
    dedupeKey: string;
  }[] = [];
  const sql: string[] = [];
  const execute = vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?');
    sql.push(text);
    if (text.includes('INSERT INTO "Memory"')) {
      const [id, ws, sourceId, content] = values;
      expect(ws).toBe(scope.workspaceId);
      rows.push({
        id: String(id),
        content: String(content),
        sensitivity: 'personal',
        sourceType: text.includes("'answer'") ? 'answer' : 'consolidated',
        sourceId: String(sourceId),
        status: 'active',
        supersededById: null,
      });
      expect(sourceId).toBeTruthy();
    }
    return Promise.resolve(1);
  });
  const query = vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
    sql.push(parts.join('?'));
    const ids = values[1] as string[];
    return Promise.resolve(rows.filter((s) => s.status === 'active' && ids.includes(s.id)));
  });
  const updateMany = vi.fn(
    (args: {
      where: { workspaceId: string; id: { in: string[] }; status: string };
      data: { status: string; supersededById: string };
    }) => {
      expect(args.where.workspaceId).toBe(scope.workspaceId);
      const matched = rows.filter(
        (s) => args.where.id.in.includes(s.id) && s.status === args.where.status,
      );
      matched.forEach((s) => Object.assign(s, args.data));
      return Promise.resolve({ count: matched.length });
    },
  );
  const tx = {
    $executeRaw: execute,
    $queryRaw: query,
    memory: {
      updateMany,
      findMany: vi.fn((args?: { where?: { id?: { in?: string[] } } }) =>
        Promise.resolve(
          args?.where?.id?.in ? rows.filter((row) => args.where?.id?.in?.includes(row.id)) : rows,
        ),
      ),
    },
    memoryGap: {
      findFirst: vi.fn((args: { where: { id?: string; workspaceId: string } }) =>
        Promise.resolve(
          gaps.find(
            (g) =>
              g.workspaceId === args.where.workspaceId &&
              (!args.where.id || g.id === args.where.id),
          ) ?? null,
        ),
      ),
      findMany: vi.fn((args: { where: { workspaceId: string; status: string } }) =>
        Promise.resolve(
          gaps.filter(
            (g) => g.workspaceId === args.where.workspaceId && g.status === args.where.status,
          ),
        ),
      ),
      create: vi.fn((args: { data: (typeof gaps)[number] }) => {
        gaps.push({ ...args.data, status: 'open' });
        return Promise.resolve(args.data);
      }),
      updateMany: vi.fn((args: { where: { id: string }; data: Partial<(typeof gaps)[number]> }) => {
        const gap = gaps.find((g) => g.id === args.where.id);
        if (gap) Object.assign(gap, args.data);
        return Promise.resolve({ count: gap ? 1 : 0 });
      }),
    },
  };
  return { tx: tx as unknown as Tx, rows, gaps, sql, execute, query, updateMany, raw: tx };
}

describe('hafiza bakimi repository', () => {
  it('uzun kaynak baglami kisa recall butcesinde guncel cevabi gizlemez', () => {
    const content = memoryGapAnswerContent('Unvanin ne?', 'Yazilim muhendisiyim.', [
      { ...sources[0]!, content: 'Onceki not. '.repeat(500) },
    ]);
    const recall = buildRecallBlock([
      { id: 'answer', content, sourceType: 'answer', sourceId: 'gap', similarity: 1 },
    ]);
    expect(recall).toContain('Yazilim muhendisiyim.');
  });
  it('uc kaynak tek konsolide kayda baglanir, kaynak icerikleri korunur', async () => {
    const f = fixture();
    expect(
      await consolidateMemories(f.tx, scope, {
        sources,
        content: 'Cihan sade kahve icer.',
        embedding: [1, 0],
      }),
    ).toBe(3);
    expect(f.rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(f.rows.slice(0, 3).map((r) => r.content)).toEqual(sources.map((r) => r.content));
    expect(f.rows.slice(0, 3).every((r) => r.supersededById === f.rows[3]?.id)).toBe(true);
    expect(
      await consolidateMemories(f.tx, scope, { sources, content: 'tekrar', embedding: [1, 0] }),
    ).toBe(0);
    expect(f.rows).toHaveLength(4);
  });

  it.each(['secret', 'public'])('personal ile %s birlestirilmez', async (sensitivity) => {
    const f = fixture();
    const mixed = sources.map((s, i) => (i === 0 ? { ...s, sensitivity } : s));
    expect(
      await consolidateMemories(f.tx, scope, { sources: mixed, content: 'x', embedding: [1] }),
    ).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('profile ve degismis snapshot korunur', async () => {
    const f = fixture();
    expect(
      await consolidateMemories(f.tx, scope, {
        sources: sources.map((s) => ({ ...s, sourceType: 'profile' })),
        content: 'x',
        embedding: [1],
      }),
    ).toBe(0);
    f.rows[0]!.content = 'guncel bilgi';
    expect(await consolidateMemories(f.tx, scope, { sources, content: 'x', embedding: [1] })).toBe(
      0,
    );
    expect(f.rows).toHaveLength(3);
  });

  it('dislanan kaynak konsolide edilmez ve dislanan konuda bosluk acilmaz', async () => {
    const f = fixture();
    const excludedSources = [{ ...sources[0]!, sourceId: 'obsidian:acme/a.md' }, sources[1]!];
    expect(
      await consolidateMemories(f.tx, scope, {
        sources: excludedSources,
        content: 'karisik ozet',
        embedding: [1],
        contextExclude: 'obsidian:acme/*,kw:acme',
      }),
    ).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();

    expect(
      await openMemoryGap(f.tx, scope, {
        sources: [sources[0]!],
        question: "Acme'te unvanin ne?",
        reason: 'Eksik',
        contextExclude: 'kw:acme',
      }),
    ).toBe(false);
    expect(f.gaps).toHaveLength(0);
  });

  it('eski dislanan bosluklari find ve list yollarinda gizler', async () => {
    const f = fixture();
    f.gaps.push({
      id: 'gap_old',
      workspaceId: scope.workspaceId,
      sourceMemoryIds: [sources[0]!.id],
      question: 'Unvan ne?',
      status: 'open',
      dedupeKey: 'old',
    });
    f.rows[0]!.sourceId = 'obsidian:acme/a.md';

    await expect(findMemoryGap(f.tx, scope, 'gap_old', 'obsidian:acme/*')).resolves.toBeNull();
    await expect(listMemoryGaps(f.tx, scope, 'open', 100, 'obsidian:acme/*')).resolves.toEqual([]);
  });

  it('ayni kaynak boslugu yeniden acilmaz, kapali olsa da acilmaz', async () => {
    const f = fixture();
    const input = {
      sources: [sources[0]!],
      question: 'Globex projesindeki rolun ne?',
      reason: 'Unvan bilinmiyor.',
    };
    expect(await openMemoryGap(f.tx, scope, input)).toBe(true);
    expect(
      await openMemoryGap(f.tx, scope, {
        ...input,
        question: 'Globex rolunu soyleyebilir misin?',
      }),
    ).toBe(false);
    f.gaps[0]!.status = 'dismissed';
    expect(await openMemoryGap(f.tx, scope, input)).toBe(false);
    expect(f.gaps).toHaveLength(1);
  });

  it('bosluga bagli kaynak sikistirilmaz', async () => {
    const f = fixture();
    await openMemoryGap(f.tx, scope, {
      sources: [sources[0]!],
      question: 'Unvanin ne?',
      reason: 'Eksik',
    });
    expect(await consolidateMemories(f.tx, scope, { sources, content: 'x', embedding: [1] })).toBe(
      0,
    );
  });

  it('cevap ayni transaction ile boslugu kapatir ve kaynaklari supersede eder', async () => {
    const f = fixture();
    await openMemoryGap(f.tx, scope, { sources, question: 'Unvanin ne?', reason: 'Eksik' });
    const gap = f.gaps[0]!;
    const id = await answerMemoryGap(f.tx, scope, {
      id: gap.id,
      question: gap.question,
      answer: 'Yazilim muhendisiyim.',
      embedding: [1],
      sources,
    });
    expect(gap.status).toBe('answered');
    expect(gap.answerMemoryId).toBe(id);
    expect(f.rows.filter((r) => r.status === 'superseded')).toHaveLength(3);
    await expect(
      answerMemoryGap(f.tx, scope, {
        id: gap.id,
        question: gap.question,
        answer: 'ikinci',
        embedding: [1],
        sources,
      }),
    ).rejects.toBeInstanceOf(MemoryGapConflict);
    expect(f.rows).toHaveLength(4);
  });

  it('asked idempotent, dismissed terminaldir', async () => {
    const f = fixture();
    await openMemoryGap(f.tx, scope, { sources, question: 'Unvanin ne?', reason: 'Eksik' });
    const id = f.gaps[0]!.id;
    expect(await transitionMemoryGap(f.tx, scope, id, 'asked')).toBe('ok');
    expect(await transitionMemoryGap(f.tx, scope, id, 'asked')).toBe('ok');
    expect(await transitionMemoryGap(f.tx, scope, id, 'dismissed')).toBe('ok');
    expect(await transitionMemoryGap(f.tx, scope, id, 'asked')).toBe('conflict');
    expect(await transitionMemoryGap(f.tx, scope, 'missing', 'asked')).toBe('missing');
  });

  it('recall SQL aktif filtresi, dashboard opsiyonel gecmis filtresi tasir', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const findMany = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: query, memory: { findMany } } as unknown as Tx;
    await searchMemories(tx, scope, [1]);
    expect((query.mock.calls[0]?.[0] as TemplateStringsArray).join('?')).toContain(
      '"status" = \'active\'',
    );
    await listMemories(tx, scope);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: scope.workspaceId, status: 'active' } }),
    );
    await listMemories(tx, scope, { includeSuperseded: true });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: scope.workspaceId } }),
    );
  });

  it('tekrar indeksleme superseded kaynak gecmisini ezmez', async () => {
    const execute = vi.fn().mockResolvedValue(0);
    await upsertMemory({ $executeRaw: execute } as unknown as Tx, scope, {
      sourceType: 'note',
      sourceId: 'old',
      content: 'x',
      embedding: [1],
    });
    expect((execute.mock.calls[0]?.[0] as TemplateStringsArray).join('?')).toContain(
      'pg_advisory_xact_lock',
    );
    expect((execute.mock.calls[1]?.[0] as TemplateStringsArray).join('?')).toContain(
      'WHERE "Memory"."status" = \'active\'',
    );
    expect((execute.mock.calls[1]?.[0] as TemplateStringsArray).join('?')).toContain(
      'm."content" IS DISTINCT FROM i."content"',
    );
    expect((execute.mock.calls[1]?.[0] as TemplateStringsArray).join('?')).toContain(
      "':superseded:'",
    );
  });

  it('pgvector esigi, tenant ve sinif filtresi SQL icindedir; zincir benzerligi kume yapmaz', async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce([
      { a: 'mem_1', b: 'mem_2' },
      { a: 'mem_2', b: 'mem_3' },
    ] as never);
    const groups = await findMemoryClusters(f.tx, scope, {
      similarity: 0.92,
      limit: 10,
      day: '2026-10-03',
    });
    expect(groups.map((g) => g.map((s) => s.id))).toEqual([['mem_1', 'mem_2']]);
    const sql = (f.query.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    expect(sql).toContain('<=>');
    expect(sql).toContain('a."sensitivity" = b."sensitivity"');
    expect(sql).toContain('m."workspaceId" = ?');
    expect(f.query.mock.calls[0]).toContain(0.92);
  });

  it('ucuz aday taramasi ve kapali bosluklar SQLde elenir', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await findGapCandidates({ $queryRaw: query } as unknown as Tx, scope, {
      limit: 10,
      day: '2026-10-03',
    });
    const sql = (query.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    expect(sql).toContain('bilinm');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('"MemoryGap"');
    expect(sql).toContain('"status" = \'active\'');
  });
});
