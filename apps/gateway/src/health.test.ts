import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHealthHandler, HEALTH_PROBE_TIMEOUT_MS } from './health.js';

const ok = () => Promise.resolve('tamam');
const fails =
  (message = 'baglanti reddedildi') =>
  () =>
    Promise.reject(new Error(message));
const hangs = () => new Promise<never>(() => undefined);

function appWith(probes: { db: () => Promise<unknown>; redis: () => Promise<unknown> }): Hono {
  const app = new Hono();
  app.get('/v1/health', createHealthHandler(probes));
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createHealthHandler', () => {
  it('DB ve Redis yanit verirse 200 ve eski sozlesme (ok:true, protocolVersion)', async () => {
    const response = await appWith({ db: ok, redis: ok }).request('/v1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true, redis: true, protocolVersion: 1 });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('DB erisilemezse 503 ve db:false (Redis ayri raporlanir)', async () => {
    const response = await appWith({ db: fails(), redis: ok }).request('/v1/health');

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, db: false, redis: true });
  });

  it('Redis erisilemezse 503 ve redis:false', async () => {
    const response = await appWith({ db: ok, redis: fails() }).request('/v1/health');

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, db: true, redis: false });
  });

  it('ikisi birden dusunce ikisi de false', async () => {
    const response = await appWith({ db: fails(), redis: fails() }).request('/v1/health');

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, db: false, redis: false });
  });

  it('yoklama senkron firlatsa da 503 doner', async () => {
    const response = await appWith({
      db: () => {
        throw new Error('havuz kapali');
      },
      redis: ok,
    }).request('/v1/health');

    expect(response.status).toBe(503);
  });

  it('hata ayrintisi (baglanti bilgisi dahil) govdeye sizmaz', async () => {
    const response = await appWith({
      db: fails('password authentication failed for user "smith"'),
      redis: ok,
    }).request('/v1/health');

    const text = await response.text();
    expect(text).not.toContain('password');
    expect(text).not.toContain('smith"');
  });

  it('asili bagimlilik sinir doldugunda false sayilir (yanit sonsuza dek beklemez)', async () => {
    vi.useFakeTimers();
    const pending = appWith({ db: hangs, redis: ok }).request('/v1/health');

    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);
    const response = await pending;

    expect(HEALTH_PROBE_TIMEOUT_MS).toBe(2_000);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, db: false, redis: true });
  });

  it('iki yoklama paralel kosar: ikisi de asili olsa toplam bekleme tek sinirdir', async () => {
    vi.useFakeTimers();
    const pending = appWith({ db: hangs, redis: hangs }).request('/v1/health');

    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);
    const response = await pending;

    expect(await response.json()).toMatchObject({ db: false, redis: false });
  });

  it('hizli yanitta zaman asimi sayaci birakilmaz', async () => {
    vi.useFakeTimers();

    await appWith({ db: ok, redis: ok }).request('/v1/health');

    expect(vi.getTimerCount()).toBe(0);
  });
});
