import {
  generatePairingCode,
  generateRefreshToken,
  hashPassword,
  issueAccessToken,
} from '@smith/auth';
import type * as AuthExports from '@smith/auth';
import { newActorId, newWorkspaceId, type DbHandle } from '@smith/db';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * bcrypt (saf JS, maliyet 12) deneme basina ~1 sn surer; hiz siniri testleri
 * onlarca deneme yapar. Hash ve dogrulama sahtelenir, boylece `verifyPassword`
 * cagri sayisi "bcrypt HIC kosulmadi" kanitidir. Gercek bcrypt davranisi
 * packages/auth testlerinde.
 */
const passwordMocks = vi.hoisted(() => ({
  hashPassword: vi.fn((plain: string) => Promise.resolve(`hash:${plain}`)),
  verifyPassword: vi.fn((plain: string, hash: string) => Promise.resolve(hash === `hash:${plain}`)),
  burnPasswordCost: vi.fn(() => Promise.resolve()),
}));

vi.mock('@smith/auth', async (importActual) => ({
  ...(await importActual<typeof AuthExports>()),
  ...passwordMocks,
}));

import { createAuthRoutes } from './auth.js';
import {
  PAIRING_EXCHANGE_POLICY,
  PAIRING_START_POLICY,
  REGISTER_POLICY,
} from './attempt-limiter.js';

const SECRET = 'auth-route-test-secret';

interface RefreshRow {
  id: string;
  actorId: string;
  workspaceId: string;
  tokenHash: string;
  family: string;
  deviceLabel: string;
  surface: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface PairingRow {
  id: string;
  codeHash: string;
  surface: string;
  status: string;
  expiresAt: Date;
  approvedActorId: string | null;
  approvedWorkspaceId: string | null;
  approvedRole: string | null;
}

class AuthStore {
  readonly workspaceId = newWorkspaceId();
  readonly actorId = newActorId();
  readonly email = 'cihan@example.com';
  passwordHash = '';
  refreshTokens: RefreshRow[] = [];
  pairings: PairingRow[] = [];
  queryCount = 0;
  failRefreshCreate = false;
  /** FOR UPDATE ile kilitlenen anahtarlar (sirayla). */
  locks: string[] = [];
  private lockTail = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    this.locks.push(key);
    const previous = this.lockTail.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    this.lockTail.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await previous;
    return release;
  }
}

function sahteHandle(store: AuthStore): DbHandle {
  const baseTx = {
    $executeRaw: () => Promise.resolve(1),
    $queryRaw: (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
    actor: {
      findUnique: (args: { where: { email: string } }) => {
        store.queryCount += 1;
        return Promise.resolve(
          args.where.email === store.email
            ? {
                id: store.actorId,
                email: store.email,
                displayName: 'Cihan',
                workspaceIds: [store.workspaceId],
              }
            : null,
        );
      },
    },
    credential: {
      findUnique: (args: { where: { actorId: string } }) => {
        store.queryCount += 1;
        return Promise.resolve(
          args.where.actorId === store.actorId
            ? { actorId: store.actorId, passwordHash: store.passwordHash }
            : null,
        );
      },
    },
    membership: {
      findFirst: (args: { where: { workspaceId: string; actorId: string } }) => {
        store.queryCount += 1;
        return Promise.resolve(
          args.where.workspaceId === store.workspaceId && args.where.actorId === store.actorId
            ? { workspaceId: store.workspaceId, actorId: store.actorId, role: 'owner' }
            : null,
        );
      },
    },
    refreshToken: {
      findFirst: (args: {
        where: { tokenHash: string; revokedAt: null; expiresAt: { gt: Date } };
      }) => {
        store.queryCount += 1;
        return Promise.resolve(
          store.refreshTokens.find(
            (row) =>
              row.tokenHash === args.where.tokenHash &&
              row.revokedAt === null &&
              row.expiresAt > args.where.expiresAt.gt,
          ) ?? null,
        );
      },
      findUnique: (args: { where: { tokenHash?: string; id?: string } }) => {
        store.queryCount += 1;
        return Promise.resolve(
          store.refreshTokens.find(
            (row) =>
              (args.where.tokenHash !== undefined && row.tokenHash === args.where.tokenHash) ||
              (args.where.id !== undefined && row.id === args.where.id),
          ) ?? null,
        );
      },
      create: (args: { data: RefreshRow }) => {
        store.queryCount += 1;
        if (store.failRefreshCreate) return Promise.reject(new Error('refresh insert failed'));
        const row = {
          ...args.data,
          createdAt: args.data.createdAt ?? new Date(),
          lastUsedAt: args.data.lastUsedAt ?? new Date(),
          revokedAt: args.data.revokedAt ?? null,
        };
        store.refreshTokens.push(row);
        return Promise.resolve(row);
      },
      update: (args: { where: { id: string }; data: Partial<RefreshRow> }) => {
        store.queryCount += 1;
        const row = store.refreshTokens.find((candidate) => candidate.id === args.where.id);
        if (!row) return Promise.reject(new Error('refresh not found'));
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
      updateMany: (args: {
        where: { family?: string; revokedAt?: null };
        data: Partial<RefreshRow>;
      }) => {
        store.queryCount += 1;
        let count = 0;
        for (const row of store.refreshTokens) {
          if (args.where.family !== undefined && row.family !== args.where.family) continue;
          if (args.where.revokedAt === null && row.revokedAt !== null) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return Promise.resolve({ count });
      },
    },
    devicePairing: {
      findUnique: (args: { where: { codeHash?: string; id?: string } }) => {
        store.queryCount += 1;
        return Promise.resolve(
          store.pairings.find(
            (row) =>
              (args.where.codeHash !== undefined && row.codeHash === args.where.codeHash) ||
              (args.where.id !== undefined && row.id === args.where.id),
          ) ?? null,
        );
      },
      updateMany: (args: {
        where: { codeHash?: string; id?: string; status: string };
        data: Partial<PairingRow>;
      }) => {
        store.queryCount += 1;
        let count = 0;
        for (const row of store.pairings) {
          if (args.where.codeHash !== undefined && row.codeHash !== args.where.codeHash) continue;
          if (args.where.id !== undefined && row.id !== args.where.id) continue;
          if (row.status !== args.where.status) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return Promise.resolve({ count });
      },
    },
  };

  const prisma = {
    ...baseTx,
    $transaction: async <T>(fn: (tx: typeof baseTx) => Promise<T>): Promise<T> => {
      const refreshSnapshot = structuredClone(store.refreshTokens);
      const pairingSnapshot = structuredClone(store.pairings);
      let release: (() => void) | undefined;
      const tx = {
        ...baseTx,
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join('?');
          if (query.includes('FOR UPDATE')) release = await store.acquire(String(values[0]));
          return [];
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        store.refreshTokens.splice(0, store.refreshTokens.length, ...refreshSnapshot);
        store.pairings.splice(0, store.pairings.length, ...pairingSnapshot);
        throw error;
      } finally {
        release?.();
      }
    },
  };
  return { prisma, pool: null, close: () => Promise.resolve() } as unknown as DbHandle;
}

function socketEnv(address: string) {
  return {
    incoming: { socket: { remoteAddress: address, remotePort: 5000, remoteFamily: 'IPv4' } },
  };
}

function authApp(store: AuthStore, allowRegistration = false): Hono {
  const app = new Hono();
  app.route(
    '/v1/auth',
    createAuthRoutes({ db: sahteHandle(store), sessionSecret: SECRET, allowRegistration }),
  );
  return app;
}

/** Govde oldugu gibi gider (bozuk JSON denemeleri icin). */
async function postRaw(
  app: Hono,
  path: string,
  rawBody: string,
  options: { address?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return app.request(
    `/v1/auth${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: rawBody,
    },
    socketEnv(options.address ?? '127.0.0.1'),
  );
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  address = '127.0.0.1',
): Promise<Response> {
  return postRaw(app, path, JSON.stringify(body), { address });
}

/** Aktif bir refresh token satiri ekler; ham token'i dondurur. */
function seedRefreshToken(store: AuthStore, id: string) {
  const issued = generateRefreshToken();
  store.refreshTokens.push({
    id,
    actorId: store.actorId,
    workspaceId: store.workspaceId,
    tokenHash: issued.tokenHash,
    family: issued.family,
    deviceLabel: 'test',
    surface: 'web',
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  });
  return issued;
}

const activeTokenCount = (store: AuthStore) =>
  store.refreshTokens.filter((row) => row.revokedAt === null).length;

let store: AuthStore;

beforeEach(async () => {
  vi.useRealTimers();
  store = new AuthStore();
  store.passwordHash = await hashPassword('dogru-parola');
  passwordMocks.verifyPassword.mockClear();
  passwordMocks.burnPasswordCost.mockClear();
});

describe('auth route guvenlik regresyonlari', () => {
  it('72 UTF-8 byte ustu parolayi DB ve bcrypt oncesi 400 reddeder', async () => {
    const response = await post(authApp(store), '/login', {
      email: store.email,
      password: 'a'.repeat(73),
    });

    expect(response.status).toBe(400);
    expect(store.queryCount).toBe(0);
    expect(passwordMocks.verifyPassword).not.toHaveBeenCalled();
  });

  it('kayitta da 72 UTF-8 byte ustu parola hash oncesi 400 ile reddedilir', async () => {
    passwordMocks.hashPassword.mockClear();
    const response = await post(authApp(store, true), '/register', {
      email: 'yeni@example.com',
      password: '\u20ac'.repeat(25), // 75 byte, 25 karakter
      displayName: 'Yeni',
      workspaceName: 'Yeni alan',
    });

    expect(response.status).toBe(400);
    expect(store.queryCount).toBe(0);
    expect(passwordMocks.hashPassword).not.toHaveBeenCalled();
  });

  it('bes hatadan sonra ayni IP+hesap icin bcrypt oncesi 429 uygular', async () => {
    const app = authApp(store);
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await post(app, '/login', { email: store.email, password: 'yanlis-parola' })).status,
      ).toBe(401);
    }
    const before = store.queryCount;
    const blocked = await post(app, '/login', { email: store.email, password: 'yanlis-parola' });

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(store.queryCount).toBe(before);
    expect(passwordMocks.verifyPassword).toHaveBeenCalledTimes(5);
  });

  it('sayac IP basinadir: bloklu hesaba baska IP den giris 429 almaz', async () => {
    const app = authApp(store);
    for (let i = 0; i < 5; i += 1) {
      await post(app, '/login', { email: store.email, password: 'yanlis-parola' }, '10.0.0.1');
    }
    const blocked = await post(
      app,
      '/login',
      { email: store.email, password: 'dogru-parola' },
      '10.0.0.1',
    );
    const otherIp = await post(
      app,
      '/login',
      { email: store.email, password: 'dogru-parola' },
      '10.0.0.2',
    );

    expect(blocked.status).toBe(429);
    expect(otherIp.status).toBe(200);
  });

  it('paralel login saldirisini key bazinda serilestirip bes bcrypt ile sinirlar', async () => {
    const app = authApp(store);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        post(app, '/login', { email: store.email, password: 'yanlis-parola' }),
      ),
    );

    expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
    expect(store.queryCount).toBe(10); // actor + credential, yalniz ilk bes deneme
    expect(passwordMocks.verifyPassword).toHaveBeenCalledTimes(5);
  });

  it('eski refresh token 30 saniye icinde birebir ayni yeni cifti replay eder', async () => {
    const issued = seedRefreshToken(store, 'rtk_parent');
    const app = authApp(store);

    const first = await post(app, '/refresh', { refreshToken: issued.token });
    const replay = await post(app, '/refresh', { refreshToken: issued.token });

    expect([first.status, replay.status]).toEqual([200, 200]);
    expect(await replay.json()).toEqual(await first.json());
    expect(activeTokenCount(store)).toBe(1);
  });

  it('paralel refresh isteklerini tek rotasyonda birlestirir', async () => {
    const issued = seedRefreshToken(store, 'rtk_parallel_parent');
    const app = authApp(store);

    const responses = await Promise.all([
      post(app, '/refresh', { refreshToken: issued.token }),
      post(app, '/refresh', { refreshToken: issued.token }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(activeTokenCount(store)).toBe(1);
  });

  it('30 saniye sonraki eski token reuse sinyalinde aileyi iptal eder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
    const issued = seedRefreshToken(store, 'rtk_expiring_parent');
    const app = authApp(store);

    expect((await post(app, '/refresh', { refreshToken: issued.token })).status).toBe(200);
    vi.advanceTimersByTime(30_001);
    const reused = await post(app, '/refresh', { refreshToken: issued.token });

    expect(reused.status).toBe(401);
    expect(activeTokenCount(store)).toBe(0);
  });

  it('tolerans icinde eski token, yeni token tuketildiyse reddedilir ama aileyi iptal etmez', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
    const issued = seedRefreshToken(store, 'rtk_stale_parent');
    const app = authApp(store);

    const second = (await (await post(app, '/refresh', { refreshToken: issued.token })).json()) as {
      refreshToken: string;
    };
    const third = await post(app, '/refresh', { refreshToken: second.refreshToken });
    expect(third.status).toBe(200);

    const stale = await post(app, '/refresh', { refreshToken: issued.token });

    expect(stale.status).toBe(401);
    expect(activeTokenCount(store)).toBe(1); // ucuncu token yasiyor
  });

  it('replacement logout edilirse grace cache eski tokeni yeniden dagitmaz', async () => {
    const issued = seedRefreshToken(store, 'rtk_logout_parent');
    const app = authApp(store);
    const rotated = (await (
      await post(app, '/refresh', { refreshToken: issued.token })
    ).json()) as { refreshToken: string };

    expect((await post(app, '/logout', { refreshToken: rotated.refreshToken })).status).toBe(200);
    const replay = await post(app, '/refresh', { refreshToken: issued.token });

    expect(replay.status).toBe(401);
    expect(activeTokenCount(store)).toBe(0);
  });

  it('pairing consume ve refresh insert ayni transactionda rollback olur', async () => {
    const pairing = generatePairingCode();
    store.pairings.push({
      id: 'dvp_test',
      codeHash: pairing.codeHash,
      surface: 'windows',
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
      approvedActorId: store.actorId,
      approvedWorkspaceId: store.workspaceId,
      approvedRole: 'owner',
    });
    const app = authApp(store);
    store.failRefreshCreate = true;

    const failed = await post(app, '/pairing/exchange', { code: pairing.code });
    expect(failed.status).toBe(500);
    expect(store.pairings[0]?.status).toBe('approved');

    store.failRefreshCreate = false;
    const retry = await post(app, '/pairing/exchange', { code: pairing.code });
    expect(retry.status).toBe(200);
    expect(store.pairings[0]?.status).toBe('consumed');
  });

  it('login basarisinda uretilen access token gecerli kalir', async () => {
    const response = await post(authApp(store), '/login', {
      email: store.email,
      password: 'dogru-parola',
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { accessToken: string }).toHaveProperty('accessToken');
  });
});

describe('kimliksiz uclarin kapisi', () => {
  const registration = {
    email: 'yeni@example.com',
    password: 'yeterince-uzun-parola',
    displayName: 'Yeni',
    workspaceName: 'Yeni alan',
  };

  it('kayit varsayilan KAPALI: gecerli govdeyle de 403, DB ve bcrypt calismaz', async () => {
    passwordMocks.hashPassword.mockClear();

    const response = await post(authApp(store), '/register', registration);

    expect(response.status).toBe(403);
    expect(store.queryCount).toBe(0);
    expect(passwordMocks.hashPassword).not.toHaveBeenCalled();
  });

  it('kayit kapaliyken e-posta kayitli mi sorusuna da cevap vermez (409 yok)', async () => {
    const response = await post(authApp(store), '/register', {
      ...registration,
      email: store.email,
    });

    expect(response.status).toBe(403);
  });

  it('acikca acilinca kayit yolu calisir (kayitli e-posta 409)', async () => {
    const response = await post(authApp(store, true), '/register', {
      ...registration,
      email: store.email,
    });

    expect(response.status).toBe(409);
  });

  it.each([
    ['/register', REGISTER_POLICY.threshold],
    ['/pairing/start', PAIRING_START_POLICY.threshold],
    ['/pairing/exchange', PAIRING_EXCHANGE_POLICY.threshold],
  ])(
    '%s IP basina kota: esikten sonra 429 + Retry-After, rota calismaz',
    async (path, threshold) => {
      const app = authApp(store, true);
      for (let i = 0; i < threshold; i += 1) {
        // Gecersiz govde rotada 400 verir; istek yine de kotaya sayilir.
        expect((await post(app, path, {}, '10.9.9.9')).status).toBe(400);
      }

      const blocked = await post(app, path, {}, '10.9.9.9');

      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await post(app, path, {}, '10.9.9.8')).status).toBe(400);
    },
  );
});

describe('hesap varligi sizintisi', () => {
  it('bilinmeyen e-postada da bcrypt maliyeti odenir ve yanit bilinen hesapla ayni olur', async () => {
    const app = authApp(store);

    const unknown = await post(app, '/login', {
      email: 'yok@example.com',
      password: 'herhangi-parola',
    });
    const wrong = await post(app, '/login', { email: store.email, password: 'yanlis-parola' });

    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(passwordMocks.burnPasswordCost).toHaveBeenCalledTimes(1);
    expect(passwordMocks.burnPasswordCost).toHaveBeenCalledWith('herhangi-parola');
    // Gercek dogrulama yalniz bilinen hesap icin kosar.
    expect(passwordMocks.verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('dogru parolada sahte maliyet odenmez', async () => {
    const response = await post(authApp(store), '/login', {
      email: store.email,
      password: 'dogru-parola',
    });

    expect(response.status).toBe(200);
    expect(passwordMocks.burnPasswordCost).not.toHaveBeenCalled();
  });
});

describe('bozuk JSON govdesi', () => {
  const broken = '{"email":"a@b.com","password":hunter2hunter2}';

  it.each([
    '/register',
    '/login',
    '/refresh',
    '/logout',
    '/pairing/start',
    '/pairing/approve',
    '/pairing/exchange',
  ])('%s 500 degil 400 JSON doner ve govdeyi loga dusurmez', async (path) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const token = issueAccessToken(SECRET, {
      workspaceId: store.workspaceId,
      actorId: store.actorId,
      role: 'owner',
    });

    const response = await postRaw(authApp(store, true), path, broken, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error).toBe('string');
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

describe('logout', () => {
  it('rotasyonla iptal edilmis eski token sunulursa ailenin guncel token i da iptal edilir', async () => {
    const issued = seedRefreshToken(store, 'rtk_logout_stale');
    const app = authApp(store);
    expect((await post(app, '/refresh', { refreshToken: issued.token })).status).toBe(200);
    expect(activeTokenCount(store)).toBe(1);

    const response = await post(app, '/logout', { refreshToken: issued.token });

    expect(response.status).toBe(200);
    expect(activeTokenCount(store)).toBe(0);
  });

  it('token satirini rotasyonla ayni kilitle alir (eszamanli rotasyon yeni token i canli birakamaz)', async () => {
    const issued = seedRefreshToken(store, 'rtk_logout_lock');

    await post(authApp(store), '/logout', { refreshToken: issued.token });

    expect(store.locks).toEqual([issued.tokenHash]);
  });

  it('eszamanli rotasyon ve logout sonunda aileden aktif token kalmaz', async () => {
    const issued = seedRefreshToken(store, 'rtk_logout_race');
    const app = authApp(store);

    await Promise.all([
      post(app, '/refresh', { refreshToken: issued.token }),
      post(app, '/logout', { refreshToken: issued.token }),
    ]);

    expect(activeTokenCount(store)).toBe(0);
  });

  it('bilinmeyen token da basarili doner (bilgi sizdirmaz)', async () => {
    const response = await post(authApp(store), '/logout', { refreshToken: 'yok-boyle-token' });

    expect(response.status).toBe(200);
  });
});
