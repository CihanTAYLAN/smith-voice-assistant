import { newActorId, newWorkspaceId, type DbHandle } from '@smith/db';
import type { Embedder } from '@smith/memory';
import { createSystemScope, createWorkspaceScope } from '@smith/tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAgentRegistry, prepareMemoryWrite } from './tools.js';

/** Kaynakta secret gorunumlu literal birakmamak icin (pre-commit tarayicisi) kurulur. */
const SECRET = `sk-${'A'.repeat(40)}`;

afterEach(() => vi.unstubAllEnvs());

const fakeDeps = {
  db: { prisma: {} } as unknown as DbHandle,
  embedder: { embed: () => Promise.resolve([]) } as unknown as Embedder,
};

function memberScope() {
  return createWorkspaceScope({
    workspaceId: newWorkspaceId(),
    actorId: newActorId(),
    role: 'member',
  });
}

/** `withScope`'un gercek `$transaction` yolunu `tx` sahtesiyle calistirir. */
function dbWithTx(tx: object): DbHandle {
  return {
    prisma: { $transaction: <T>(fn: (value: object) => Promise<T>) => fn(tx) },
  } as unknown as DbHandle;
}

describe('buildAgentRegistry', () => {
  it('hafiza araclarini kaydeder', () => {
    const reg = buildAgentRegistry(fakeDeps);
    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['cihaz_bilgisi', 'cihazlarim', 'hafizada_ara', 'hafizaya_kaydet']);
  });

  it('system scope reddedilir; DB/embedder cagirilmadan doner', async () => {
    const reg = buildAgentRegistry(fakeDeps);
    const tool = reg.get('hafizada_ara');
    const result = await tool?.execute?.(
      { query: 'x' },
      { scope: createSystemScope('arac testi') },
    );
    expect(result).toEqual({ error: 'workspace scope gerekli' });
  });

  it('cihazlarim da system scope reddeder (DB cagirilmadan)', async () => {
    const reg = buildAgentRegistry(fakeDeps);
    const tool = reg.get('cihazlarim');
    const result = await tool?.execute?.({}, { scope: createSystemScope('arac testi') });
    expect(result).toEqual({ error: 'workspace scope gerekli' });
  });

  it('cihaz_bilgisi device-locus (gateway yurutmez, execute yok)', () => {
    const reg = buildAgentRegistry(fakeDeps);
    const tool = reg.get('cihaz_bilgisi');
    expect(tool?.locus).toBe('device');
    expect(tool?.execute).toBeUndefined();
  });

  it('32 bit FNV-1a cakismali iki not icin farkli sourceId uretir', async () => {
    const reg = buildAgentRegistry({
      db: dbWithTx({ $executeRaw: () => Promise.resolve(1) }),
      embedder: { model: 'test', embed: () => Promise.resolve([]) } as unknown as Embedder,
    });
    const tool = reg.get('hafizaya_kaydet');
    const scope = memberScope();

    // 'costarring' ve 'liquid' eski FNV-1a anahtarinda ayni degeri uretiyordu.
    const first = (await tool?.execute?.({ content: 'costarring' }, { scope })) as {
      sourceId: string;
    };
    const second = (await tool?.execute?.({ content: 'liquid' }, { scope })) as {
      sourceId: string;
    };

    expect(first.sourceId).not.toBe(second.sourceId);
  });

  it('dislanan notu embedding ve transaction oncesi no-op yapar', async () => {
    vi.stubEnv('SMITH_CONTEXT_EXCLUDE', 'kw:acme');
    const embed = vi.fn(() => Promise.resolve([]));
    const transaction = vi.fn();
    const reg = buildAgentRegistry({
      db: { prisma: { $transaction: transaction } } as unknown as DbHandle,
      embedder: { model: 'test', embed } as unknown as Embedder,
    });

    const result = await reg
      .get('hafizaya_kaydet')
      ?.execute?.({ content: 'ACME karari' }, { scope: memberScope() });

    expect(result).toMatchObject({ ok: true, excluded: true });
    expect(embed).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('iptal embedding sirasinda gelirse kalici yazim yapmaz', async () => {
    let resolveEmbedding: ((value: number[]) => void) | undefined;
    const embed = vi.fn(
      () =>
        new Promise<number[]>((resolve) => {
          resolveEmbedding = resolve;
        }),
    );
    const transaction = vi.fn();
    const reg = buildAgentRegistry({
      db: { prisma: { $transaction: transaction } } as unknown as DbHandle,
      embedder: { model: 'test', embed } as unknown as Embedder,
    });
    const controller = new AbortController();

    const executing = reg
      .get('hafizaya_kaydet')
      ?.execute?.(
        { content: 'iptal edilmis not' },
        { scope: memberScope(), signal: controller.signal },
      );
    controller.abort();
    resolveEmbedding?.([]);

    await expect(executing).rejects.toMatchObject({ name: 'AbortError' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('iptal RLS transaction kurulurken gelirse Memory INSERT yapmaz', async () => {
    let resolveScope: (() => void) | undefined;
    const executeRaw = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveScope = () => resolve(1);
        }),
    );
    const reg = buildAgentRegistry({
      db: dbWithTx({ $executeRaw: executeRaw }),
      embedder: { model: 'test', embed: () => Promise.resolve([]) } as unknown as Embedder,
    });
    const controller = new AbortController();

    const executing = reg
      .get('hafizaya_kaydet')
      ?.execute?.(
        { content: 'transaction sirasinda iptal' },
        { scope: memberScope(), signal: controller.signal },
      );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    resolveScope?.();

    await expect(executing).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeRaw).toHaveBeenCalledTimes(1); // yalniz RLS set_config; Memory INSERT yok
  });
});

/** Embedding saglayicisina GIDEN metni ve iptal sinyalini yakalar. */
function recordingEmbedder() {
  const calls: Array<{ text: string; signal: AbortSignal | undefined }> = [];
  const embedder: Embedder = {
    model: 'test',
    embed: (text, options) => {
      calls.push({ text, signal: options?.signal });
      return Promise.resolve([]);
    },
    embedBatch: () => Promise.resolve([]),
  };
  return { embedder, calls };
}

/** Yerel DB'ye yazilan Memory satirlarini (icerik + gizlilik sinifi) yakalar. */
function recordingDb() {
  const writes: Array<{ content: unknown; sensitivity: unknown }> = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('INSERT INTO "Memory"')) {
        writes.push({ content: values[4], sensitivity: values[6] });
      }
      return Promise.resolve(1);
    },
    $queryRaw: () => Promise.resolve([]),
  };
  return { db: dbWithTx(tx), writes };
}

describe('hafiza araclari: embedding girdisi ve iptal sinyali', () => {
  it('hafizada_ara sorguyu maskeler ve arac sinyalini embedding istegine iletir', async () => {
    const { embedder, calls } = recordingEmbedder();
    const reg = buildAgentRegistry({ db: recordingDb().db, embedder });
    const controller = new AbortController();

    await reg
      .get('hafizada_ara')
      ?.execute?.(
        { query: `${SECRET} anahtarimi hatirla` },
        { scope: memberScope(), signal: controller.signal },
      );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('[GIZLI] anahtarimi hatirla');
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it('hafizada_ara sinyal yokken de calisir', async () => {
    const { embedder, calls } = recordingEmbedder();
    const reg = buildAgentRegistry({ db: recordingDb().db, embedder });

    await reg.get('hafizada_ara')?.execute?.({ query: 'tema' }, { scope: memberScope() });

    expect(calls[0]).toEqual({ text: 'tema', signal: undefined });
  });

  it('hafizaya_kaydet TAM metni yerel DB ye yazar, embedding e maskeli metni gonderir', async () => {
    const { embedder, calls } = recordingEmbedder();
    const { db, writes } = recordingDb();
    const reg = buildAgentRegistry({ db, embedder });
    const controller = new AbortController();
    const content = `anahtarim ${SECRET}, bunu hatirla`;

    await reg
      .get('hafizaya_kaydet')
      ?.execute?.({ content }, { scope: memberScope(), signal: controller.signal });

    expect(calls[0]?.text).toBe('anahtarim [GIZLI], bunu hatirla');
    expect(calls[0]?.text).not.toContain(SECRET);
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(writes).toEqual([{ content, sensitivity: 'secret' }]);
  });

  it('yalniz sirdan ibaret icerik de kaydedilir (secret, vektor maskeli metinden)', async () => {
    const { embedder, calls } = recordingEmbedder();
    const { db, writes } = recordingDb();
    const reg = buildAgentRegistry({ db, embedder });

    await reg
      .get('hafizaya_kaydet')
      ?.execute?.({ content: 'parola=avci2', sensitivity: 'public' }, { scope: memberScope() });

    expect(calls[0]?.text).toBe('parola=[GIZLI]');
    expect(writes).toEqual([{ content: 'parola=avci2', sensitivity: 'secret' }]);
  });

  it('fiziksel anahtar notu personal yazilir (secret olursa Live hatirlayamazdi)', async () => {
    const { embedder, calls } = recordingEmbedder();
    const { db, writes } = recordingDb();
    const reg = buildAgentRegistry({ db, embedder });

    await reg
      .get('hafizaya_kaydet')
      ?.execute?.({ content: 'ev anahtari: mavi cekmece' }, { scope: memberScope() });

    expect(calls[0]?.text).toBe('ev anahtari: mavi cekmece');
    expect(writes).toEqual([{ content: 'ev anahtari: mavi cekmece', sensitivity: 'personal' }]);
  });

  it.each([
    [undefined, 'personal'],
    ['public', 'public'],
    ['personal', 'personal'],
    ['secret', 'secret'],
  ] as const)('sir yoksa istenen sinif (%s) korunur: %s', async (requested, stored) => {
    const { embedder, calls } = recordingEmbedder();
    const { db, writes } = recordingDb();
    const reg = buildAgentRegistry({ db, embedder });

    await reg.get('hafizaya_kaydet')?.execute?.(
      {
        content: 'tema koyu olsun',
        ...(requested ? { sensitivity: requested } : {}),
      },
      { scope: memberScope() },
    );

    expect(calls[0]?.text).toBe('tema koyu olsun');
    expect(writes).toEqual([{ content: 'tema koyu olsun', sensitivity: stored }]);
  });
});

describe('prepareMemoryWrite', () => {
  it('sir yoksa metne dokunmaz, istenen sinifi (varsayilan personal) dondurur', () => {
    expect(prepareMemoryWrite('tema koyu')).toEqual({
      embeddingText: 'tema koyu',
      sensitivity: 'personal',
    });
    expect(prepareMemoryWrite('tema koyu', 'public').sensitivity).toBe('public');
  });

  it('masum "anahtar" notu (fiziksel anahtar) secret OLMAZ: Live hatirlayabilsin', () => {
    expect(prepareMemoryWrite('ev anahtari: mavi cekmece')).toEqual({
      embeddingText: 'ev anahtari: mavi cekmece',
      sensitivity: 'personal',
    });
  });

  it('kimlik bilgisi seklindeki api anahtari secret olur', () => {
    expect(prepareMemoryWrite('api anahtarim: abc123def456')).toEqual({
      embeddingText: 'api anahtarim: [GIZLI]',
      sensitivity: 'secret',
    });
  });

  it('sir bulununca embedding girdisini maskeler ve sinifi secret yapar', () => {
    expect(prepareMemoryWrite(`not ${SECRET}`, 'personal')).toEqual({
      embeddingText: 'not [GIZLI]',
      sensitivity: 'secret',
    });
  });
});
