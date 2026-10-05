import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAttemptLimiter,
  limitByIp,
  LOGIN_POLICY,
  PAIRING_EXCHANGE_POLICY,
  PAIRING_START_POLICY,
  REGISTER_POLICY,
  WS_TICKET_POLICY,
  type AttemptPolicy,
} from './attempt-limiter.js';

function limiterWithClock(policy: AttemptPolicy = LOGIN_POLICY) {
  const clock = { now: 1_000_000 };
  const limiter = createAttemptLimiter({
    secret: 'limiter-test-secret',
    policy,
    now: () => clock.now,
  });
  return { limiter, clock };
}

function failTimes(limiter: ReturnType<typeof createAttemptLimiter>, key: string, times: number) {
  for (let i = 0; i < times; i += 1) limiter.recordFailure(key);
}

describe('createAttemptLimiter (giris politikasi)', () => {
  it('esigin altindaki hatalar beklemeye yol acmaz', () => {
    const { limiter } = limiterWithClock();

    failTimes(limiter, 'anahtar', LOGIN_POLICY.threshold - 1);

    expect(limiter.retryAfterMs('anahtar')).toBe(0);
  });

  it('esikte taban beklemeyi uygular, her yeni hata beklemeyi ikiye katlar', () => {
    const { limiter, clock } = limiterWithClock();

    failTimes(limiter, 'anahtar', LOGIN_POLICY.threshold);
    expect(limiter.retryAfterMs('anahtar')).toBe(LOGIN_POLICY.baseMs);

    clock.now += LOGIN_POLICY.baseMs;
    expect(limiter.retryAfterMs('anahtar')).toBe(0);

    limiter.recordFailure('anahtar');
    expect(limiter.retryAfterMs('anahtar')).toBe(LOGIN_POLICY.baseMs * 2);
  });

  it('bekleme tavani asmaz', () => {
    const { limiter } = limiterWithClock();

    failTimes(limiter, 'anahtar', LOGIN_POLICY.threshold + 40);

    expect(limiter.retryAfterMs('anahtar')).toBe(LOGIN_POLICY.maxMs);
  });

  it('basarili giris sayaci sifirlar', () => {
    const { limiter } = limiterWithClock();
    failTimes(limiter, 'anahtar', LOGIN_POLICY.threshold - 1);

    limiter.recordSuccess('anahtar');
    failTimes(limiter, 'anahtar', LOGIN_POLICY.threshold - 1);

    expect(limiter.retryAfterMs('anahtar')).toBe(0);
  });

  it('uzun suredir hata almayan anahtarin sayaci unutulur', () => {
    const { limiter, clock } = limiterWithClock();
    failTimes(limiter, 'anahtar', LOGIN_POLICY.threshold - 1);

    clock.now += LOGIN_POLICY.retentionMs + 1;
    failTimes(limiter, 'anahtar', LOGIN_POLICY.threshold - 1);

    expect(limiter.retryAfterMs('anahtar')).toBe(0);
  });

  it('anahtar adres ve normallestirilmis e-postadan turetilir, uzunlugu sabittir', () => {
    const { limiter } = limiterWithClock();
    const key = limiter.keyFor('1.1.1.1', 'ali@example.com');

    expect(limiter.keyFor('1.1.1.1', ' Ali@Example.com ')).toBe(key);
    expect(limiter.keyFor('2.2.2.2', 'ali@example.com')).not.toBe(key);
    expect(limiter.keyFor('1.1.1.1', 'veli@example.com')).not.toBe(key);
    expect(limiter.keyFor(undefined, 'ali@example.com')).toHaveLength(key.length);
    expect(limiter.keyFor('1.1.1.1', 'x'.repeat(100_000))).toHaveLength(key.length);
  });

  it('tablo dolunca en eski anahtar atilir; yeni anahtar reddedilmez ve sayilir', () => {
    const { limiter } = limiterWithClock();
    limiter.recordFailure('eski');
    for (let i = 0; i < LOGIN_POLICY.maxKeys; i += 1) limiter.recordFailure(`dolgu-${i}`);

    // 'eski' atildi: sayaci sifirlandi, bir hata daha onu esige tasimaz.
    failTimes(limiter, 'eski', LOGIN_POLICY.threshold - 1);
    expect(limiter.retryAfterMs('eski')).toBe(0);

    // Yeni takip edilen anahtar yine esikte bloklanir.
    limiter.recordFailure('eski');
    expect(limiter.retryAfterMs('eski')).toBeGreaterThan(0);
  });

  it('ayni anahtarin gorevlerini sirayla, farkli anahtarlarinkini paralel kosar', async () => {
    const { limiter } = limiterWithClock();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = limiter.serialize('a', async () => {
      order.push('a1 basladi');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('a1 bitti');
    });
    const second = limiter.serialize('a', () => {
      order.push('a2');
      return Promise.resolve();
    });
    await limiter.serialize('b', () => {
      order.push('b1');
      return Promise.resolve();
    });
    expect(order).toEqual(['a1 basladi', 'b1']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1 basladi', 'b1', 'a1 bitti', 'a2']);
  });

  it('gorev hata verse de kilit serbest kalir', async () => {
    const { limiter } = limiterWithClock();

    await expect(
      limiter.serialize('a', () => Promise.reject(new Error('patladi'))),
    ).rejects.toThrow('patladi');

    await expect(limiter.serialize('a', () => Promise.resolve('devam'))).resolves.toBe('devam');
  });
});

describe('createAttemptLimiter (kimliksiz uc politikalari)', () => {
  it('anahtar yalniz adresten turetilir; konu verilmezse bos konuyla ayni', () => {
    const { limiter } = limiterWithClock(REGISTER_POLICY);

    expect(limiter.keyFor('1.1.1.1')).toBe(limiter.keyFor('1.1.1.1', ''));
    expect(limiter.keyFor('1.1.1.1')).not.toBe(limiter.keyFor('2.2.2.2'));
    expect(limiter.keyFor(undefined)).toHaveLength(limiter.keyFor('1.1.1.1').length);
  });

  it('admit esige kadar her istegi serbest birakir ve sayar', () => {
    const { limiter } = limiterWithClock(REGISTER_POLICY);

    for (let i = 0; i < REGISTER_POLICY.threshold; i += 1) {
      expect(limiter.admit('ip')).toBe(0);
    }
    // Esige ulasan istek serbestti; bir sonrakini taban bekleme karsilar.
    expect(limiter.admit('ip')).toBe(REGISTER_POLICY.baseMs);
  });

  it('bekleme suresince gelen istekler sayilmaz, sure dolunca bekleme ikiye katlanir', () => {
    const { limiter, clock } = limiterWithClock(REGISTER_POLICY);
    for (let i = 0; i < REGISTER_POLICY.threshold; i += 1) limiter.admit('ip');

    // 100 reddedilen istek sayaci sismirmez: sure dolunca tek yeni istek serbest.
    for (let i = 0; i < 100; i += 1) expect(limiter.admit('ip')).toBeGreaterThan(0);
    clock.now += REGISTER_POLICY.baseMs;
    expect(limiter.admit('ip')).toBe(0);

    expect(limiter.admit('ip')).toBe(REGISTER_POLICY.baseMs * 2);
  });

  it('adresler birbirinin kotasini tuketmez', () => {
    const { limiter } = limiterWithClock(PAIRING_START_POLICY);
    for (let i = 0; i < PAIRING_START_POLICY.threshold + 1; i += 1) limiter.admit('a');

    expect(limiter.admit('a')).toBeGreaterThan(0);
    expect(limiter.admit('b')).toBe(0);
  });

  it('sessiz kalan anahtarin kotasi retentionMs sonra yenilenir', () => {
    const { limiter, clock } = limiterWithClock(WS_TICKET_POLICY);
    for (let i = 0; i < WS_TICKET_POLICY.threshold + 1; i += 1) limiter.admit('ip');
    expect(limiter.admit('ip')).toBeGreaterThan(0);

    clock.now += WS_TICKET_POLICY.retentionMs + WS_TICKET_POLICY.maxMs + 1;

    expect(limiter.admit('ip')).toBe(0);
  });

  it('eslestirme degisimi politikasi polling akisina yer birakir', () => {
    const { limiter } = limiterWithClock(PAIRING_EXCHANGE_POLICY);

    // 10 dakikalik kod omru boyunca 2 saniyede bir yoklama (300 istek) sinira takilmaz.
    for (let i = 0; i < 300; i += 1) expect(limiter.admit('ip')).toBe(0);
  });
});

describe('varsayilan saat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Date.now() e gec baglanir: sonradan kurulan sahte zamanlayicilarla da ilerler', () => {
    // Sinirlayici GERCEK saatle kurulur (index.ts'te modul seviyesinde olusur), sahte
    // zamanlayici sonra devreye girer: saat olusum aninda degil cagri aninda okunmali.
    const limiter = createAttemptLimiter({
      secret: 'limiter-test-secret',
      policy: REGISTER_POLICY,
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < REGISTER_POLICY.threshold; i += 1) limiter.admit('ip');
    expect(limiter.admit('ip')).toBe(REGISTER_POLICY.baseMs);

    vi.setSystemTime(1_000_000 + REGISTER_POLICY.baseMs);

    expect(limiter.admit('ip')).toBe(0);
  });
});

describe('limitByIp', () => {
  function appWith(limiter: ReturnType<typeof createAttemptLimiter>) {
    const app = new Hono();
    app.use('/uc', limitByIp(limiter));
    app.post('/uc', (c) => c.json({ ok: true }));
    return app;
  }

  const fromAddress = (address: string) => ({
    incoming: { socket: { remoteAddress: address, remotePort: 5000, remoteFamily: 'IPv4' } },
  });

  it('esige kadar govdeyi isleyen rotaya gecirir, sonra 429 + Retry-After doner', async () => {
    const { limiter } = limiterWithClock(REGISTER_POLICY);
    const app = appWith(limiter);
    const call = (address = '10.0.0.1') =>
      app.request('/uc', { method: 'POST' }, fromAddress(address));

    for (let i = 0; i < REGISTER_POLICY.threshold; i += 1) {
      expect((await call()).status).toBe(200);
    }
    const blocked = await call();

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe(String(REGISTER_POLICY.baseMs / 1000));
    expect(await blocked.json()).toEqual({
      error: 'Cok fazla istek.',
      retryAfterSeconds: REGISTER_POLICY.baseMs / 1000,
    });
    // Baska adres etkilenmez.
    expect((await call('10.0.0.2')).status).toBe(200);
  });

  it('soket bilgisi olmayan istekler tek "bilinmeyen" kovada toplanir', async () => {
    const { limiter } = limiterWithClock(REGISTER_POLICY);
    const app = appWith(limiter);

    for (let i = 0; i < REGISTER_POLICY.threshold; i += 1) {
      expect((await app.request('/uc', { method: 'POST' })).status).toBe(200);
    }

    expect((await app.request('/uc', { method: 'POST' })).status).toBe(429);
  });
});
