import { newActorId, newMessageId, newWorkspaceId, type DbHandle } from '@smith/db';
import { EMBED_TIMEOUT_MS, type Embedder } from '@smith/memory';
import { QueueName, parseQueuePayload } from '@smith/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMemoryIndex } from './memory-index.js';

const workspaceId = newWorkspaceId();
const actorId = newActorId();

function fakeDb(text: string): { handle: DbHandle; writes: string[] } {
  const writes: string[] = [];
  const messageId = newMessageId();
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('INSERT INTO "Memory"')) writes.push(String(values[4]));
      return Promise.resolve(1);
    },
    message: {
      findFirst: () => Promise.resolve({ id: messageId, text }),
    },
  };
  return {
    handle: {
      prisma: { ...tx, $transaction: <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx) },
      pool: null,
      close: () => Promise.resolve(),
    } as unknown as DbHandle,
    writes,
  };
}

function payload(sourceId: string) {
  return parseQueuePayload(QueueName.MEMORY_INDEX, {
    workspaceId,
    actorId,
    kind: 'message',
    sourceId,
  });
}

describe('handleMemoryIndex secret kapisi', () => {
  it('secret parcayi embedding ve Memory yazimindan once maskeler', async () => {
    const secret = `sk-${'A'.repeat(40)}`;
    const db = fakeDb(`tema koyu, anahtar ${secret}`);
    const embedded: string[] = [];
    const embedder: Embedder = {
      model: 'sahte',
      embed: (text) => {
        embedded.push(text);
        return Promise.resolve([0.1]);
      },
      embedBatch: () => Promise.resolve([]),
    };

    await handleMemoryIndex({ db: db.handle, embedder }, payload(newMessageId()));
    expect(embedded[0]).toBe('tema koyu, anahtar [GIZLI]');
    expect(db.writes[0]).toBe('tema koyu, anahtar [GIZLI]');
  });

  it('dislanan mesaji embedding ve Memory yazimindan once atlar', async () => {
    vi.stubEnv('SMITH_CONTEXT_EXCLUDE', 'kw:acme');
    const db = fakeDb('Acme isveren notu');
    const embed = vi.fn(() => Promise.resolve([0.1]));

    await handleMemoryIndex(
      { db: db.handle, embedder: { model: 'sahte', embed } as unknown as Embedder },
      payload(newMessageId()),
    );

    expect(embed).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it('tamami secret olan mesaji embed etmez ve indekslemez', async () => {
    const db = fakeDb('parola=avci2');
    let embedded = false;
    const embedder: Embedder = {
      model: 'sahte',
      embed: () => {
        embedded = true;
        return Promise.resolve([0.1]);
      },
      embedBatch: () => Promise.resolve([]),
    };

    await handleMemoryIndex({ db: db.handle, embedder }, payload(newMessageId()));
    expect(embedded).toBe(false);
    expect(db.writes).toHaveLength(0);
  });
});

describe('handleMemoryIndex zaman asimi', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('embedding istegine zaman asimi sinyali gecirir (asili uc worker kuyrugunu kilitlemesin)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const db = fakeDb('tema koyu olsun');
    const signals: (AbortSignal | undefined)[] = [];
    const embedder: Embedder = {
      model: 'sahte',
      embed: (_text, options) => {
        signals.push(options?.signal);
        return Promise.resolve([0.1]);
      },
      embedBatch: () => Promise.resolve([]),
    };

    await handleMemoryIndex({ db: db.handle, embedder }, payload(newMessageId()));

    expect(timeoutSpy).toHaveBeenCalledWith(EMBED_TIMEOUT_MS);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBe(timeoutSpy.mock.results[0]?.value);
    expect(signals[0]?.aborted).toBe(false);
  });
});
