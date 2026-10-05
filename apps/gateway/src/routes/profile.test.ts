import { issueAccessToken } from '@smith/auth';
import { newActorId, newWorkspaceId, type DbHandle } from '@smith/db';
import type { Embedder } from '@smith/memory';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createToolRoutes } from './tools.js';

const SECRET = 'profile-route-test-secret';
const workspaceId = newWorkspaceId();
const actorId = newActorId();
const otherWorkspaceId = newWorkspaceId();
/** Kaynakta secret gorunumlu literal birakmamak icin (pre-commit tarayicisi) kurulur. */
const API_KEY = `sk-${'A'.repeat(40)}`;

afterEach(() => vi.unstubAllEnvs());
/** Kaynak ASCII kalsin diye ASCII disi degerler kod noktasindan kurulur. */
const TURKISH_KEY = `${String.fromCharCode(0x15f)}ehir`;
const EMOJI = String.fromCodePoint(0x1f600);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

interface MemoryRecord {
  id: string;
  workspaceId: string;
  sourceType: string;
  sourceId: string;
  content: string;
  sensitivity: string;
  createdAt: Date;
}

interface DeviceRecord {
  id: string;
  workspaceId: string;
  surface: string;
  name: string;
  lastSeenAt: Date;
  createdAt: Date;
}

interface Where {
  workspaceId?: string;
  sourceType?: string;
  sourceId?: string;
  sensitivity?: { in: string[] };
}

interface ProfileResponse {
  entries: { anahtar: string; deger: string; guncellendi: string }[];
  cihazlar: { ad: string; yuzey: string; sonGorulme: string }[];
}

/**
 * Gercek JWT ve withScope, yalniz Prisma sahte. RLS taklit EDILMEZ: tenant
 * iddialari uygulamanin kendi `where` filtrelerini sinar; `rlsWorkspaces` ise
 * her islemin dogru workspace'e baglandigini ayrica kanitlar.
 *
 * Postgres'ten tasidigi iki davranis, yazim guvenligi testlerinin dayanagidir:
 * `$transaction` hata firlatinca islemi GERI ALIR ve Memory INSERT'u ON
 * CONFLICT yoksa benzersizlik ihlalinde hata verir.
 */
class Store {
  memories: MemoryRecord[] = [];
  devices: DeviceRecord[] = [];
  rlsWorkspaces: unknown[] = [];
  transactions = 0;
  /**
   * Her Memory INSERT'inden once calisir: yazimi kesmek (hata firlatarak) ya da
   * eszamanli islemleri hizalamak (bariyer) icin kanca.
   */
  beforeInsert: () => Promise<void> = () => Promise.resolve();
  private clock = Date.parse('2026-10-03T06:00:00.000Z');
  private seq = 0;

  /** Her yazima artan zaman damgasi: siralama iddialari saate bagli olmaz. */
  private tick(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  seed(input: Pick<MemoryRecord, 'sourceId' | 'content'> & Partial<MemoryRecord>): MemoryRecord {
    const row: MemoryRecord = {
      id: `mem_seed${this.seq++}`,
      workspaceId,
      sourceType: 'profile',
      sensitivity: 'personal',
      createdAt: this.tick(),
      ...input,
    };
    this.memories.push(row);
    return row;
  }

  entry(key: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
    return this.seed({ sourceId: `profile:${key}`, content, ...overrides });
  }

  /** `upsertMemory`in ham INSERT'u: sira (id, ws, tur, kaynak, icerik, vektor, sinif). */
  private upsert(sql: string, values: unknown[]): void {
    const [id, ws, sourceType, sourceId, content, , sensitivity] = values as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const existing = this.memories.find(
      (row) => row.workspaceId === ws && row.sourceType === sourceType && row.sourceId === sourceId,
    );
    if (!existing) {
      this.memories.push({
        id,
        workspaceId: ws,
        sourceType,
        sourceId,
        content,
        sensitivity,
        createdAt: this.tick(),
      });
      return;
    }
    if (!sql.includes('ON CONFLICT ("workspaceId", "sourceType", "sourceId")')) {
      throw new Error(
        'duplicate key value violates unique constraint "Memory_workspaceId_sourceType_sourceId_key"',
      );
    }
    Object.assign(existing, { content, sensitivity });
  }

  private matching(where: Where): MemoryRecord[] {
    return this.memories.filter(
      (row) =>
        (where.workspaceId === undefined || row.workspaceId === where.workspaceId) &&
        (where.sourceType === undefined || row.sourceType === where.sourceType) &&
        (where.sourceId === undefined || row.sourceId === where.sourceId) &&
        (where.sensitivity === undefined || where.sensitivity.in.includes(row.sensitivity)),
    );
  }

  handle(): DbHandle {
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('set_config')) this.rlsWorkspaces.push(values[1]);
        else if (sql.includes('pg_advisory_xact_lock'))
          expect(values[0]).toBe(`memory:${workspaceId}`);
        else if (sql.includes('INSERT INTO "Memory"')) {
          await this.beforeInsert();
          this.upsert(sql, values);
        } else throw new Error(`beklenmeyen SQL: ${sql}`);
        return 1;
      },
      memory: {
        findMany: ({ where, take }: { where: Where; take: number }) =>
          Promise.resolve(
            this.matching(where)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .slice(0, take)
              .map((row) => ({ ...row })),
          ),
        deleteMany: ({ where }: { where: Where }) => {
          const doomed = this.matching(where);
          this.memories = this.memories.filter((row) => !doomed.includes(row));
          return Promise.resolve({ count: doomed.length });
        },
        count: ({ where }: { where: Where }) => Promise.resolve(this.matching(where).length),
      },
      device: {
        findMany: ({ where }: { where: { workspaceId: string } }) =>
          Promise.resolve(
            this.devices
              .filter((device) => device.workspaceId === where.workspaceId)
              .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
              .map((device) => ({ ...device })),
          ),
      },
    };
    return {
      prisma: {
        // Geri alma = islem oncesi goruntuye donus. Es zamanli islemler arasi
        // yalitimi MODELLEMEZ; yalniz "yarim kalan islem iz birakmaz" iddiasi icindir.
        $transaction: async <T>(fn: (value: typeof tx) => Promise<T>) => {
          this.transactions += 1;
          const snapshot = this.memories.map((row) => ({ ...row }));
          try {
            return await fn(tx);
          } catch (error) {
            this.memories = snapshot;
            throw error;
          }
        },
      },
    } as unknown as DbHandle;
  }
}

/** `parties` kisi gelene kadar hepsini bekletir, sonra birlikte birakir. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) release();
    return open;
  };
}

function createApp() {
  const store = new Store();
  const embed = vi.fn<Embedder['embed']>(() => Promise.resolve([]));
  const app = new Hono();
  app.route(
    '/v1/tools',
    createToolRoutes({
      db: store.handle(),
      sessionSecret: SECRET,
      embedder: { model: 'test', embed } as unknown as Embedder,
    }),
  );
  return { app, store, embed };
}

type Role = 'member' | 'viewer';
interface CallOptions {
  /** `null` token gondermez. */
  role?: Role | null;
  body?: unknown;
  signal?: AbortSignal;
}

function call(
  app: Hono,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: CallOptions = {},
) {
  const role = options.role === undefined ? 'member' : options.role;
  const { body } = options;
  return app.request(`/v1/tools/profile${path}`, {
    method,
    headers: {
      ...(role
        ? { authorization: `Bearer ${issueAccessToken(SECRET, { workspaceId, actorId, role })}` }
        : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** `POST /v1/tools/profile {anahtar, deger}`. */
function write(
  app: Hono,
  anahtar: unknown,
  deger: unknown,
  options: Omit<CallOptions, 'body'> = {},
) {
  return call(app, 'POST', '', { ...options, body: { anahtar, deger } });
}

async function read(response: Response): Promise<ProfileResponse> {
  return (await response.json()) as ProfileResponse;
}

describe('/v1/tools/profile kimlik ve rol', () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it.each([
    ['GET', '', undefined],
    ['POST', '', { anahtar: 'sehir', deger: 'Istanbul' }],
    ['DELETE', '/sehir', undefined],
  ] as const)(
    '%s token olmadan 401 doner, embedding ve DB calismaz',
    async (method, path, body) => {
      const response = await call(ctx.app, method, path, { role: null, body });

      expect(response.status).toBe(401);
      expect(ctx.embed).not.toHaveBeenCalled();
      expect(ctx.store.transactions).toBe(0);
    },
  );

  it('viewer okuyabilir', async () => {
    ctx.store.entry('sehir', 'Istanbul');

    const response = await call(ctx.app, 'GET', '', { role: 'viewer' });

    expect(response.status).toBe(200);
    expect((await read(response)).entries.map((entry) => entry.anahtar)).toEqual(['sehir']);
  });

  it.each([
    ['POST', '', { anahtar: 'sehir', deger: 'Ankara' }],
    ['DELETE', '/sehir', undefined],
  ] as const)('viewer %s yapamaz: 403, embedding ve DB oncesi', async (method, path, body) => {
    ctx.store.entry('sehir', 'Istanbul');

    const response = await call(ctx.app, method, path, { role: 'viewer', body });

    expect(response.status).toBe(403);
    expect(ctx.embed).not.toHaveBeenCalled();
    expect(ctx.store.transactions).toBe(0);
    expect(ctx.store.memories.map((row) => row.content)).toEqual(['Istanbul']);
  });

  it('PUT rotasi yok: yazma ve guncelleme POST ile yapilir', async () => {
    const response = await call(ctx.app, 'PUT', '/sehir', { body: { deger: 'Ankara' } });

    expect(response.status).toBe(404);
    expect(ctx.embed).not.toHaveBeenCalled();
    expect(ctx.store.transactions).toBe(0);
  });
});

describe('POST /v1/tools/profile dogrulama', () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it.each(['a', 'Sehir', 'dogum-gunu', 'sehir adi', 'x'.repeat(41), TURKISH_KEY, ''])(
    'gecersiz anahtar %j 400, embedding ve DB calismaz',
    async (anahtar) => {
      const response = await write(ctx.app, anahtar, 'Istanbul');

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: expect.stringMatching(/^anahtar /) as string,
      });
      expect(ctx.embed).not.toHaveBeenCalled();
      expect(ctx.store.transactions).toBe(0);
    },
  );

  it.each(['ab', 'a'.repeat(40), 'dogum_gunu2'])(
    'gecerli anahtar %j kabul edilir',
    async (anahtar) => {
      const response = await write(ctx.app, anahtar, 'x');

      expect(response.status).toBe(200);
    },
  );

  const sehir = (deger: unknown) => ({ anahtar: 'sehir', deger });
  const invalidBodies: [name: string, body: unknown, errorStart: string][] = [
    ['govde yok', undefined, 'govde'],
    ['json degil', 'bu json degil', 'govde'],
    ['govde nesne degil', '[]', 'govde'],
    ['anahtar yok', { deger: 'Istanbul' }, 'anahtar'],
    ['deger yok', { anahtar: 'sehir' }, 'deger'],
    ['bos deger', sehir(''), 'deger'],
    ['yalniz bosluk', sehir('   '), 'deger'],
    ['sayi', sehir(42), 'deger'],
    ['301 karakter', sehir('x'.repeat(301)), 'deger'],
    ['301 kod noktasi', sehir(EMOJI.repeat(301)), 'deger'],
    ['cok satirli', sehir('ilk satir\nikinci satir'), 'deger'],
    ['satir ayiraci', sehir(`ilk${LINE_SEPARATOR}ikinci`), 'deger'],
  ];

  it.each(invalidBodies)(
    'gecersiz govde (%s) 400, embedding ve DB calismaz',
    async (_name, body, errorStart) => {
      const response = await call(ctx.app, 'POST', '', { body });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error.startsWith(errorStart)).toBe(
        true,
      );
      expect(ctx.embed).not.toHaveBeenCalled();
      expect(ctx.store.transactions).toBe(0);
    },
  );

  it.each([
    ['300 karakter', 'x'.repeat(300)],
    ['300 kod noktasi (surrogate cifti)', EMOJI.repeat(300)],
  ])('%s sinirda kabul edilir', async (_name, deger) => {
    const response = await write(ctx.app, 'sehir', deger);

    expect(response.status).toBe(200);
    expect(ctx.store.memories[0]?.content).toBe(deger);
  });

  it('16 KiB ustu govdeyi 413 ile reddeder (mevcut hatirlatma siniri)', async () => {
    const response = await write(ctx.app, 'sehir', 'x'.repeat(20_000));

    expect(response.status).toBe(413);
    expect(ctx.embed).not.toHaveBeenCalled();
  });

  it.each(['a', 'Sehir', 'x'.repeat(41), '%C5%9Fehir', 'sehir%20adi'])(
    'DELETE gecersiz anahtar %j 400, DB calismaz',
    async (key) => {
      const response = await call(ctx.app, 'DELETE', `/${key}`);

      expect(response.status).toBe(400);
      expect(ctx.store.transactions).toBe(0);
    },
  );
});

describe('POST /v1/tools/profile sir kapisi', () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it.each([
    ['saglayici anahtari', 'sehir', API_KEY],
    ['etiketli sir degerin icinde', 'not', 'parola: avci2'],
    ['etiket anahtarda (sifre -> 12345)', 'sifre', '12345'],
    ['alt cizgili etiket anahtarda (api_key)', 'api_key', 'abcdef123456'],
    ['alt cizgili parola etiketi anahtarda (db_password)', 'db_password', 'hunter2'],
  ])(
    '%s 400: sir ne embedding e ne DB ye gider, yanitta yankilanmaz',
    async (_name, anahtar, deger) => {
      const response = await write(ctx.app, anahtar, deger);
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(text).toContain('sir icermez');
      expect(text).not.toContain(deger);
      expect(ctx.embed).not.toHaveBeenCalled();
      expect(ctx.store.memories).toEqual([]);
    },
  );

  it('fiziksel anahtar notu sir sayilmaz (Live hatirlayabilsin)', async () => {
    const response = await write(ctx.app, 'ev_anahtari', 'mavi cekmece');

    expect(response.status).toBe(200);
  });
});

describe('POST /v1/tools/profile yazim', () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it('degeri yerel DB ye tam yazar (personal), embedding e etiketli satiri gonderir', async () => {
    const response = await write(ctx.app, 'dogum_gunu', '  12 Mart  ');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, anahtar: 'dogum_gunu' });
    expect(ctx.store.memories).toMatchObject([
      {
        workspaceId,
        sourceType: 'profile',
        sourceId: 'profile:dogum_gunu',
        content: '12 Mart',
        sensitivity: 'personal',
      },
    ]);
    expect(ctx.embed.mock.calls[0]?.[0]).toBe('dogum_gunu: 12 Mart');
    expect(ctx.store.rlsWorkspaces).toEqual([workspaceId]);
  });

  it('dislanan profil degerini embedding ve DB oncesi no-op yapar', async () => {
    vi.stubEnv('SMITH_CONTEXT_EXCLUDE', 'kw:acme');

    const response = await write(ctx.app, 'is', 'Acme isveren bilgisi');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, excluded: true });
    expect(ctx.embed).not.toHaveBeenCalled();
    expect(ctx.store.memories).toHaveLength(0);
  });

  it('istemci iptalini embedding istegine iletir', async () => {
    const controller = new AbortController();

    await write(ctx.app, 'sehir', 'Istanbul', { signal: controller.signal });

    const signal = ctx.embed.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('mevcut anahtari yeniden yazmak tek satir birakir, onu en uste tasir ve guncellendi i tazeler', async () => {
    const sehir = ctx.store.entry('sehir', 'Istanbul');
    ctx.store.entry('dil', 'Turkce');

    await write(ctx.app, 'sehir', 'Ankara');
    const body = await read(await call(ctx.app, 'GET', ''));

    expect(body.entries.map((entry) => [entry.anahtar, entry.deger])).toEqual([
      ['sehir', 'Ankara'],
      ['dil', 'Turkce'],
    ]);
    expect(Date.parse(body.entries[0]?.guncellendi ?? '')).toBeGreaterThan(
      sehir.createdAt.getTime(),
    );
  });
});

/**
 * Memory'de updatedAt yok: guncelleme "sil + yeniden yaz"dir. Bu yontemin iki
 * riski burada sabitlenir: yarim kalan yazim eski degeri silmemeli (tek
 * transaction) ve ayni anahtara eszamanli iki yazim tek satirla bitmeli.
 */
describe('POST /v1/tools/profile transaction ve yaris', () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it('silme ve yeniden yazma TEK transaction: yazim patlarsa eski deger geri gelir', async () => {
    ctx.store.entry('sehir', 'Istanbul');
    ctx.store.beforeInsert = () => Promise.reject(new Error('baglanti koptu'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await write(ctx.app, 'sehir', 'Ankara');

      expect(response.status).toBe(500);
      expect(ctx.store.memories.map((row) => [row.sourceId, row.content])).toEqual([
        ['profile:sehir', 'Istanbul'],
      ]);
      expect(ctx.store.transactions).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  // En kotu araya girme: iki islem de silmeyi bitirmeden hicbiri yazmaya gecmez.
  // Sahte DB, Postgres gibi ON CONFLICT'siz INSERT'u benzersizlik ihlaliyle
  // reddeder; yani bu test upsertMemory'nin ON CONFLICT'ine de dayanir.
  it.each([
    ['yeni anahtar', false],
    ['mevcut anahtar', true],
  ])('ayni anahtara eszamanli iki yazim tek satirla biter (%s)', async (_name, exists) => {
    if (exists) ctx.store.entry('sehir', 'Istanbul');
    ctx.store.beforeInsert = barrier(2);

    const [first, second] = await Promise.all([
      write(ctx.app, 'sehir', 'Ankara'),
      write(ctx.app, 'sehir', 'Izmir'),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(ctx.store.transactions).toBe(2);
    const rows = ctx.store.memories.filter((row) => row.sourceId === 'profile:sehir');
    expect(rows).toHaveLength(1);
    expect(['Ankara', 'Izmir']).toContain(rows[0]?.content);
    expect((await read(await call(ctx.app, 'GET', ''))).entries).toHaveLength(1);
  });
});

describe('POST /v1/tools/profile kota', () => {
  let ctx: ReturnType<typeof createApp>;

  const fill = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      ctx.store.entry(`anahtar_${String(i).padStart(2, '0')}`, `deger ${i}`);
    }
  };

  beforeEach(() => {
    ctx = createApp();
  });

  it('50 anahtar doluyken 51. anahtar 409 alir ve hicbir sey yazilmaz', async () => {
    fill(50);

    const response = await write(ctx.app, 'yeni_anahtar', 'x');

    expect(response.status).toBe(409);
    expect(ctx.store.memories).toHaveLength(50);
    expect(ctx.store.memories.some((row) => row.sourceId === 'profile:yeni_anahtar')).toBe(false);
  });

  it('50 anahtar doluyken mevcut anahtarin guncellemesi serbest', async () => {
    fill(50);

    const response = await write(ctx.app, 'anahtar_07', 'yeni deger');

    expect(response.status).toBe(200);
    expect(ctx.store.memories).toHaveLength(50);
    expect(ctx.store.memories.find((row) => row.sourceId === 'profile:anahtar_07')?.content).toBe(
      'yeni deger',
    );
  });

  it('49 anahtarda yeni anahtar kabul edilir (sinir 50 dahil)', async () => {
    fill(49);

    const response = await write(ctx.app, 'yeni_anahtar', 'x');

    expect(response.status).toBe(200);
    expect(ctx.store.memories).toHaveLength(50);
  });

  it('baska workspace in anahtarlari kotaya sayilmaz', async () => {
    for (let i = 0; i < 50; i += 1) {
      ctx.store.entry(`k_${i}`, 'x', { workspaceId: otherWorkspaceId });
    }

    const response = await write(ctx.app, 'sehir', 'Istanbul');

    expect(response.status).toBe(200);
  });
});

describe('GET /v1/tools/profile', () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it('en yeni guncellenen once doner; secret, baska tur, oneksiz ve baska workspace satiri yok', async () => {
    ctx.store.entry('sehir', 'Istanbul');
    const dil = ctx.store.entry('dil', 'Turkce');
    ctx.store.entry('banka', 'gizli kayit', { sensitivity: 'secret' });
    ctx.store.seed({ sourceType: 'note', sourceId: 'voice:abc', content: 'baska tur' });
    ctx.store.seed({ sourceId: 'oneksiz-id', content: 'profile: oneki yok' });
    ctx.store.entry('baskasi', 'baska workspace', { workspaceId: otherWorkspaceId });

    const response = await call(ctx.app, 'GET', '');
    const body = await read(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.entries).toEqual([
      { anahtar: 'dil', deger: 'Turkce', guncellendi: dil.createdAt.toISOString() },
      { anahtar: 'sehir', deger: 'Istanbul', guncellendi: expect.any(String) as string },
    ]);
    expect(ctx.store.rlsWorkspaces).toEqual([workspaceId]);
  });

  it('en fazla 50 giris doner (en yeniler)', async () => {
    for (let i = 0; i < 60; i += 1) ctx.store.entry(`anahtar_${String(i).padStart(2, '0')}`, 'x');

    const body = await read(await call(ctx.app, 'GET', ''));

    expect(body.entries).toHaveLength(50);
    expect(body.entries[0]?.anahtar).toBe('anahtar_59');
    expect(body.entries[49]?.anahtar).toBe('anahtar_10');
  });

  it('embedding cagirmaz (masaustu her oturum acilisinda cagiracak, hizli kalmali)', async () => {
    ctx.store.entry('sehir', 'Istanbul');

    const response = await call(ctx.app, 'GET', '');

    expect(response.status).toBe(200);
    expect(ctx.embed).not.toHaveBeenCalled();
  });

  it('cihazlar yalniz ad, yuzey ve son gorulme tasir; kimlik ve baska workspace sizmaz', async () => {
    const device = (overrides: Partial<DeviceRecord>): DeviceRecord => ({
      id: 'dev_gizliid',
      workspaceId,
      surface: 'windows',
      name: 'Cihan PC',
      lastSeenAt: new Date('2026-10-03T05:00:00.000Z'),
      createdAt: new Date('2026-08-24T05:00:00.000Z'),
      ...overrides,
    });
    ctx.store.devices.push(
      device({}),
      device({
        surface: 'macos',
        name: 'MacBook Air',
        lastSeenAt: new Date('2026-10-03T07:00:00.000Z'),
      }),
      device({ workspaceId: otherWorkspaceId, name: 'Baskasinin telefonu' }),
    );

    const response = await call(ctx.app, 'GET', '');
    const text = await response.text();
    const body = JSON.parse(text) as ProfileResponse;

    expect(body.cihazlar).toEqual([
      { ad: 'MacBook Air', yuzey: 'macos', sonGorulme: '2026-10-03T07:00:00.000Z' },
      { ad: 'Cihan PC', yuzey: 'windows', sonGorulme: '2026-10-03T05:00:00.000Z' },
    ]);
    expect(text).not.toContain('dev_gizliid');
    expect(text).not.toContain(workspaceId);
    expect(text).not.toContain('Baskasinin');
  });

  it('bos profilde bos listeler doner', async () => {
    const body = await read(await call(ctx.app, 'GET', ''));

    expect(body).toEqual({ entries: [], cihazlar: [] });
  });
});

describe('DELETE /v1/tools/profile/:anahtar', () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it('idempotent: ilki silindi true, tekrari false, ikisi de 200', async () => {
    ctx.store.entry('sehir', 'Istanbul');
    ctx.store.entry('dil', 'Turkce');

    const first = await call(ctx.app, 'DELETE', '/sehir');
    const second = await call(ctx.app, 'DELETE', '/sehir');

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await first.json()).toEqual({ ok: true, silindi: true });
    expect(await second.json()).toEqual({ ok: true, silindi: false });
    expect(ctx.store.memories.map((row) => row.sourceId)).toEqual(['profile:dil']);
  });

  it('baska workspace in ayni anahtarina ve baska turdeki kayda dokunmaz', async () => {
    ctx.store.entry('sehir', 'baska workspace', { workspaceId: otherWorkspaceId });
    ctx.store.seed({ sourceType: 'note', sourceId: 'profile:sehir', content: 'baska tur' });

    const response = await call(ctx.app, 'DELETE', '/sehir');

    expect(await response.json()).toEqual({ ok: true, silindi: false });
    expect(ctx.store.memories).toHaveLength(2);
    expect(ctx.store.rlsWorkspaces).toEqual([workspaceId]);
  });
});
