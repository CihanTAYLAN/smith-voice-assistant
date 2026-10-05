import type { DbHandle, Tx } from '@smith/db';
import { memoryMaintenanceEnvSchema } from '@smith/env';
import type { LlmRouter } from '@smith/llm';
import * as memory from '@smith/memory';
import type { MemoryMaintenanceJob } from '@smith/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMemoryMaintenance } from './memory-maintenance.js';
import { isQuotaError } from './memory-maintenance-model.js';

vi.mock('@smith/memory', async (original) => ({
  ...(await original<typeof memory>()),
  findMemoryClusters: vi.fn(),
  findGapCandidates: vi.fn(),
  consolidateMemories: vi.fn(),
  searchMemories: vi.fn(),
  openMemoryGap: vi.fn(),
}));
const payload: MemoryMaintenanceJob = {
  workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa',
  actorId: 'act_bbbbbbbbbbbbbbbbbbbb',
};
const unknownTitle =
  'Globex projesindeki tam rol KAMUYA ACIK HICBIR KAYNAKTA YOKTUR; rolu hakkinda varsayim kurulmamali, sorulursa bilinmedigi soylenmelidir.';
const source = (id: string, content = unknownTitle): memory.MaintenanceMemory => ({
  id,
  content,
  sourceType: 'note',
  sourceId: `note:${id}`,
  sensitivity: 'personal',
});

afterEach(() => vi.unstubAllEnvs());

function setup(responses: unknown[] = []) {
  const config = memoryMaintenanceEnvSchema.parse({});
  const streamChat = vi
    .fn()
    .mockImplementation(() => Promise.resolve({ text: JSON.stringify(responses.shift()) }));
  const llm = { streamChat } as unknown as LlmRouter;
  const embedder = {
    model: 'test',
    embed: vi.fn().mockResolvedValue([1]),
    embedBatch: vi
      .fn()
      .mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => [1]))),
  };
  const membership = vi.fn().mockResolvedValue({ actorId: payload.actorId });
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    membership: { findFirst: membership },
  } as unknown as Tx;
  const db = {
    prisma: { $transaction: <T>(fn: (tx: Tx) => Promise<T>) => fn(tx) },
  } as unknown as DbHandle;
  const log = vi.fn();
  return { db, llm, streamChat, embedder, config, log, membership };
}

beforeEach(() => {
  vi.mocked(memory.findMemoryClusters).mockReset().mockResolvedValue([]);
  vi.mocked(memory.findGapCandidates).mockReset().mockResolvedValue([]);
  vi.mocked(memory.searchMemories).mockReset().mockResolvedValue([]);
  vi.mocked(memory.consolidateMemories).mockReset().mockResolvedValue(3);
  vi.mocked(memory.openMemoryGap).mockReset().mockResolvedValue(true);
});

describe('hafiza bakimi dongusu', () => {
  it('dislanan adayi embedding ve LLM oncesi atlar, bosluk acmaz', async () => {
    vi.stubEnv('SMITH_CONTEXT_EXCLUDE', 'kw:acme');
    vi.mocked(memory.findGapCandidates).mockResolvedValue([
      source('excluded', 'Acme isveren notu'),
    ]);
    const deps = setup();

    await handleMemoryMaintenance(deps, payload);

    expect(deps.embedder.embedBatch).not.toHaveBeenCalled();
    expect(deps.streamChat).not.toHaveBeenCalled();
    expect(memory.openMemoryGap).not.toHaveBeenCalled();
  });
  it('uc kayit icin tek LLM cagrisi ve tek konsolidasyon', async () => {
    const sources = [
      source('a', 'sade kahve'),
      source('b', 'kahvesi sade'),
      source('c', 'Cihan sade kahve sever'),
    ];
    vi.mocked(memory.findMemoryClusters).mockResolvedValue([sources]);
    const deps = setup([
      { kind: 'consolidated', preservesAllFacts: true, content: 'Cihan sade kahve sever.' },
    ]);
    await handleMemoryMaintenance(deps, payload);
    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(deps.streamChat).toHaveBeenCalledWith(
      'summarizer',
      expect.anything(),
      expect.not.objectContaining({ singleAttempt: true }),
    );
    expect(memory.consolidateMemories).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: payload.workspaceId }),
      expect.objectContaining({ sources }),
    );
    expect(deps.log).toHaveBeenCalledWith({
      clusters: 1,
      superseded: 3,
      gaps: 0,
      skipped: 0,
      stopped: 'complete',
      stage: 'gap',
    });
  });

  it('gecici cluster hatasi sonraki cluster ve bosluk asamasini engellemez', async () => {
    vi.mocked(memory.findMemoryClusters).mockResolvedValue([
      [source('a'), source('b')],
      [source('c'), source('d')],
    ]);
    vi.mocked(memory.findGapCandidates).mockResolvedValue([source('gap')]);
    const deps = setup([
      { kind: 'consolidated', preservesAllFacts: true, content: 'Birlesik kayit.' },
      [{ id: 'gap', kind: 'skip' }],
    ]);
    deps.streamChat.mockRejectedValueOnce(new Error('upstream', { cause: { status: 503 } }));
    await handleMemoryMaintenance(deps, payload);
    expect(memory.consolidateMemories).toHaveBeenCalledTimes(1);
    expect(memory.findGapCandidates).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ clusters: 2, superseded: 3, skipped: 2, stopped: 'partial' }),
    );
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'Error', errorMessage: 'upstream' }),
    );
  });

  it('uc ardisik gecici hata devre kesiciyi acar', async () => {
    vi.mocked(memory.findMemoryClusters).mockResolvedValue([
      [source('a')],
      [source('b')],
      [source('c')],
      [source('d')],
    ]);
    const deps = setup();
    deps.streamChat.mockRejectedValue(new Error('upstream', { cause: { status: 503 } }));
    await handleMemoryMaintenance(deps, payload);
    expect(deps.streamChat).toHaveBeenCalledTimes(3);
    expect(memory.findGapCandidates).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        clusters: 4,
        skipped: 4,
        stopped: 'partial',
        errorClass: 'CircuitBreaker',
        errorMessage: 'Ardisik 3 gecici hata; kalan kalemler denenmedi.',
        firstErrorClass: 'Error',
        firstErrorMessage: 'upstream',
      }),
    );
  });

  it('ornek kayit tek dogal soru acar; toplu islem yapar', async () => {
    vi.mocked(memory.findGapCandidates).mockResolvedValue([source('a')]);
    const deps = setup([
      [
        {
          id: 'a',
          kind: 'gap',
          question: 'Globex projesindeki tam rolun ne?',
          reason: 'Unvan bilinmiyor.',
        },
      ],
    ]);
    await handleMemoryMaintenance(deps, payload);
    expect(memory.openMemoryGap).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ question: 'Globex projesindeki tam rolun ne?' }),
    );
    expect(deps.embedder.embedBatch).toHaveBeenCalledTimes(1);
    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.objectContaining({ gaps: 1 }));
    expect(deps.log).toHaveBeenCalledWith(expect.objectContaining({ stage: 'answer-check' }));
  });

  it('ikinci calismada tekrar bosluk acilmaz', async () => {
    vi.mocked(memory.findGapCandidates)
      .mockResolvedValueOnce([source('a')])
      .mockResolvedValueOnce([]);
    const deps = setup([[{ id: 'a', kind: 'gap', question: 'Unvanin ne?', reason: 'Bilinmiyor' }]]);
    await handleMemoryMaintenance(deps, payload);
    await handleMemoryMaintenance(deps, payload);
    expect(memory.openMemoryGap).toHaveBeenCalledTimes(1);
    expect(deps.streamChat).toHaveBeenCalledTimes(1);
  });

  it('recall cevabi zaten buluyorsa bosluk acilmaz', async () => {
    vi.mocked(memory.findGapCandidates).mockResolvedValue([source('a')]);
    vi.mocked(memory.searchMemories).mockResolvedValue([
      {
        id: 'answer',
        content: 'Globex rolu yazilim muhendisi.',
        similarity: 0.9,
        sourceType: 'answer',
        sourceId: 'x',
      },
    ]);
    const deps = setup([[{ id: 'a', kind: 'answered', answerEvidenceId: 'answer' }]]);
    await handleMemoryMaintenance(deps, payload);
    expect(memory.openMemoryGap).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.streamChat.mock.calls)).toContain('yazilim muhendisi');
  });

  it('celiskide kaynaklar birlestirilmez, soru acilir', async () => {
    vi.mocked(memory.findMemoryClusters).mockResolvedValue([
      [source('a', 'Unvani CEO'), source('b', 'Unvani CTO')],
    ]);
    const deps = setup([
      { kind: 'conflict' },
      [
        {
          id: 'a',
          kind: 'gap',
          question: 'Guncel unvanin CEO mu CTO mu?',
          reason: 'Iki farkli unvan var.',
        },
      ],
    ]);
    await handleMemoryMaintenance(deps, payload);
    expect(memory.consolidateMemories).not.toHaveBeenCalled();
    expect(memory.openMemoryGap).toHaveBeenCalledTimes(1);
  });

  it('secret icerik ve token buluta gitmez', async () => {
    vi.mocked(memory.findMemoryClusters).mockResolvedValue([
      [{ ...source('a'), sensitivity: 'secret' }, source('b')],
      [source('c', `anahtar: sk-${'A'.repeat(40)}`), source('d')],
    ]);
    const deps = setup();
    await handleMemoryMaintenance(deps, payload);
    expect(deps.streamChat).not.toHaveBeenCalled();
    expect(deps.embedder.embed).not.toHaveBeenCalled();
    expect(memory.consolidateMemories).not.toHaveBeenCalled();
  });

  it('429 kalan kumeleri durdurur ve tek ozet yazar', async () => {
    vi.mocked(memory.findMemoryClusters).mockResolvedValue([
      [source('a'), source('b')],
      [source('c'), source('d')],
    ]);
    const deps = setup();
    deps.streamChat.mockRejectedValue(new Error('wrapper', { cause: { status: 429 } }));
    await handleMemoryMaintenance(deps, payload);
    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(memory.findGapCandidates).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ stopped: 'quota', superseded: 0 }),
    );
  });

  it('embedding 429 bosluk modelini ve yazimi durdurur', async () => {
    vi.mocked(memory.findGapCandidates).mockResolvedValue([source('a')]);
    const deps = setup();
    vi.mocked(deps.embedder.embedBatch).mockRejectedValue({ status: 429 });
    await handleMemoryMaintenance(deps, payload);
    expect(deps.streamChat).not.toHaveBeenCalled();
    expect(memory.openMemoryGap).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.objectContaining({ stopped: 'quota' }));
  });

  it('bozuk JSON kalemi atlar, kaynak degismez ve is partial tamamlanir', async () => {
    vi.mocked(memory.findMemoryClusters).mockResolvedValue([[source('a'), source('b')]]);
    const deps = setup();
    deps.streamChat.mockResolvedValue({ text: 'not json' });
    await handleMemoryMaintenance(deps, payload);
    expect(memory.consolidateMemories).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        stopped: 'partial',
        stage: 'gap',
        errorClass: 'Error',
        errorMessage: 'Bakim modeli gecerli JSON dondurmedi.',
      }),
    );
  });

  it('bosluk hatasinin en derin nedenini tek satir ve maskeli loglar', async () => {
    vi.mocked(memory.findGapCandidates).mockResolvedValue([source('a')]);
    const deps = setup();
    deps.embedder.embedBatch.mockRejectedValue(
      new Error('wrapper', { cause: new Error('DB_PASSWORD=hunter2\nbaglanti koptu') }),
    );
    await expect(handleMemoryMaintenance(deps, payload)).rejects.toThrow('Hafiza bakimi basarisiz');
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        stopped: 'error',
        stage: 'gap',
        errorClass: 'Error',
        errorMessage: 'DB_PASSWORD=[GIZLI] baglanti koptu',
      }),
    );
  });

  it('kapali bayrak veya kaldirilmis uyelik LLM cagirmaz', async () => {
    const deps = setup();
    deps.config.SMITH_MEMORY_MAINTENANCE = '0';
    await handleMemoryMaintenance(deps, payload);
    expect(deps.membership).not.toHaveBeenCalled();
    deps.config.SMITH_MEMORY_MAINTENANCE = '1';
    deps.membership.mockResolvedValue(null);
    await handleMemoryMaintenance(deps, payload);
    expect(deps.streamChat).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenLastCalledWith(expect.objectContaining({ stopped: 'unauthorized' }));
  });

  it('kota sinyali neden zincirinde taninir, diger hatalar kota degildir', () => {
    expect(isQuotaError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
    expect(isQuotaError(new Error('bad schema'))).toBe(false);
  });
});
