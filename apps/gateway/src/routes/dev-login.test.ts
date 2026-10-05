import { verifyAccessToken } from '@smith/auth';
import { newActorId, newWorkspaceId, type DbHandle } from '@smith/db';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDevLoginRoutes } from './dev-login.js';

/**
 * `/v1/dev/login`: sifresiz token basan gelistirme kisayolu. Savunma iki
 * kosulun BIRLIKTE saglanmasi: NODE_ENV=development ve loopback istek.
 *
 * Prisma sahtelenir ama `withScope`, token uretimi ve dogrulamasi GERCEKTIR.
 * Uzak adres Hono'nun `app.request(.., env)` ucuncu argumaniyla, Node'un
 * `c.env.incoming.socket` bicimiyle verilir; yani varsayilan (uretimdeki)
 * adres cozucusu de test edilir.
 */

const SECRET = 'test-secret-yalnizca-testte-kullanilir';
const EMAIL = 'cihan@example.com';

const workspaceId = newWorkspaceId();
const actorId = newActorId();

interface SahteVeri {
  aktorler: { id: string; email: string }[];
  uyelikler: { workspaceId: string; actorId: string; role: string }[];
  sorgular: number;
}

function sahteHandle(veri: SahteVeri): DbHandle {
  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    actor: {
      findUnique: (args: { where: { email: string } }) => {
        veri.sorgular += 1;
        const bulunan = veri.aktorler.find((a) => a.email === args.where.email);
        return Promise.resolve(
          bulunan ? { ...bulunan, displayName: 'Cihan', workspaceIds: [] } : null,
        );
      },
    },
    membership: {
      findFirst: (args: { where: { workspaceId: string; actorId: string } }) => {
        veri.sorgular += 1;
        return Promise.resolve(
          veri.uyelikler.find(
            (m) => m.workspaceId === args.where.workspaceId && m.actorId === args.where.actorId,
          ) ?? null,
        );
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };
  return { prisma, pool: null, close: () => Promise.resolve() } as unknown as DbHandle;
}

function soketEnv(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress, remotePort: 51234, remoteFamily: 'IPv4' } } };
}

let veri: SahteVeri;

function uygulama(nodeEnv: 'development' | 'test' | 'production'): Hono {
  const app = new Hono();
  app.route(
    '/v1/dev',
    createDevLoginRoutes({ db: sahteHandle(veri), sessionSecret: SECRET, nodeEnv }),
  );
  return app;
}

function giris(app: Hono, remoteAddress: string | undefined, extra: Record<string, string> = {}) {
  return app.request(
    '/v1/dev/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ email: EMAIL, workspaceId }),
    },
    remoteAddress === undefined ? undefined : soketEnv(remoteAddress),
  );
}

beforeEach(() => {
  veri = {
    aktorler: [{ id: actorId, email: EMAIL }],
    uyelikler: [{ workspaceId, actorId, role: 'owner' }],
    sorgular: 0,
  };
});

describe('development + loopback', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    '%s adresinden 200 ve gecerli token',
    async (adres) => {
      const response = await giris(uygulama('development'), adres);

      expect(response.status).toBe(200);
      const govde = (await response.json()) as { token: string; actorId: string; role: string };
      expect(govde.actorId).toBe(actorId);
      expect(govde.role).toBe('owner');
      const kapsam = verifyAccessToken(SECRET, govde.token);
      expect(kapsam.workspaceId).toBe(workspaceId);
      expect(kapsam.actorId).toBe(actorId);
    },
  );

  it('uyelik yoksa loopback olsa da 403', async () => {
    veri.uyelikler = [];
    const response = await giris(uygulama('development'), '127.0.0.1');
    expect(response.status).toBe(403);
  });

  it('gecersiz govde 400 (loopback kapisini gecen istek)', async () => {
    const response = await uygulama('development').request(
      '/v1/dev/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'e-posta-degil' }),
      },
      soketEnv('127.0.0.1'),
    );
    expect(response.status).toBe(400);
  });

  it('bozuk JSON govdesi 500 degil 400 JSON doner ve govdeyi loga dusurmez', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await uygulama('development').request(
      '/v1/dev/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email":"a@b.com","workspaceId":hunter2hunter2}',
      },
      soketEnv('127.0.0.1'),
    );

    expect(response.status).toBe(400);
    const govde = (await response.json()) as { error?: unknown };
    expect(typeof govde.error).toBe('string');
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

describe('loopback disi istek', () => {
  it.each(['192.168.1.20', '10.0.0.5', '203.0.113.7', '2001:db8::1', '::ffff:192.168.1.20'])(
    'development olsa bile %s adresinden 403, veritabanina dokunulmaz',
    async (adres) => {
      const response = await giris(uygulama('development'), adres);

      expect(response.status).toBe(403);
      expect(veri.sorgular).toBe(0);
      expect(await response.text()).not.toContain('token');
    },
  );

  it('uydurma X-Forwarded-For basligi kapiyi acmaz', async () => {
    const response = await giris(uygulama('development'), '203.0.113.7', {
      'X-Forwarded-For': '127.0.0.1',
      'X-Real-IP': '127.0.0.1',
    });
    expect(response.status).toBe(403);
    expect(veri.sorgular).toBe(0);
  });

  it('adres bilinmiyorsa (soket yok) reddeder', async () => {
    const response = await giris(uygulama('development'), undefined);
    expect(response.status).toBe(403);
    expect(veri.sorgular).toBe(0);
  });
});

describe('development disi ortam', () => {
  it.each(['production', 'test'] as const)('%s ortaminda loopback bile 403', async (ortam) => {
    const response = await giris(uygulama(ortam), '127.0.0.1');

    expect(response.status).toBe(403);
    expect(veri.sorgular).toBe(0);
  });
});
