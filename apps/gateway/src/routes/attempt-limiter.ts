import { createHmac } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

import { resolveRemoteAddress } from '../network.js';

/**
 * DENEME HIZ SINIRI. Bellek ici ve tek surec: gateway tek surectir, yeniden
 * baslatma sayaclari sifirlar (kabul edilen sinir).
 *
 * Anahtar = IP (+ konu: giriste e-posta, bilette dogrulanmis actor). Baska bir
 * IP'deki saldirgan mesru kullaniciyi kilitleyemez; HMAC ozeti anahtari sabit uzunlukta tutar, boylece
 * uzun bir e-posta bellegi sisirmez. NOT: nginx arkasinda gateway yalniz proxy
 * adresini gorur (X-Forwarded-For bilerek okunmaz, bkz. network.ts), yani
 * orada IP basina ayrim nginx `limit_req` katmaninda yapilir.
 *
 * `threshold` denemeden sonra her yeni deneme bekleme suresini ikiye katlar
 * (taban `baseMs`, tavan `maxMs`); bekleme suresince gelen istekler sayilmaz.
 * Sayac `retentionMs` boyunca deneme gelmezse unutulur. Iki kullanim:
 *
 * - Giris: yalniz BASARISIZ parola denemesi sayilir (`recordFailure`), basari
 *   sayaci sifirlar (`recordSuccess`). Bekleme suresince bcrypt HIC kosulmaz:
 *   saf JS bcrypt (maliyet 12) CPU'yu tuketmenin en ucuz yoludur.
 * - Kimliksiz uclar (kayit, eslestirme, bilet): HER istek bir denemedir
 *   (`admit`, `limitByIp`); kota dolunca govde okunmadan ve DB'ye inilmeden 429.
 */
export interface AttemptPolicy {
  /** Bekleme baslamadan once serbest deneme sayisi. */
  readonly threshold: number;
  /** Esik asilinca ilk bekleme (ms); her yeni deneme ikiye katlar. */
  readonly baseMs: number;
  readonly maxMs: number;
  /** Bu kadar suredir deneme gelmeyen anahtarin sayaci unutulur. */
  readonly retentionMs: number;
  /**
   * Sayac tablosunun siniri. Dolunca EN ESKI anahtar atilir; yeni anahtar asla
   * reddedilmez, yoksa tablo sahte anahtarlarla doldurularak herkes kapatilabilirdi.
   */
  readonly maxKeys: number;
}

const MAX_KEYS = 10_000;

/** Giris: anahtar = IP + e-posta, yalniz basarisiz parola sayilir. */
export const LOGIN_POLICY: AttemptPolicy = {
  threshold: 5,
  baseMs: 1_000,
  maxMs: 60_000,
  retentionMs: 15 * 60_000,
  maxKeys: MAX_KEYS,
};

/** Kayit (yalniz SMITH_ALLOW_REGISTRATION=1 iken): bcrypt + kalici workspace yazar. */
export const REGISTER_POLICY: AttemptPolicy = {
  threshold: 5,
  baseMs: 60_000,
  maxMs: 15 * 60_000,
  retentionMs: 60 * 60_000,
  maxKeys: MAX_KEYS,
};

/** Eslestirme kodu uretimi: kimliksiz satir yazar. */
export const PAIRING_START_POLICY: AttemptPolicy = {
  threshold: 10,
  baseMs: 5_000,
  maxMs: 5 * 60_000,
  retentionMs: 15 * 60_000,
  maxKeys: MAX_KEYS,
};

/**
 * Eslestirme kodu degisimi: istemci onay beklerken yoklar (kod omru 10 dk,
 * 2 sn aralikla ~300 istek). Kod 31^8 olasilikli oldugundan bu kota kaba kuvveti
 * de anlamsiz kilar.
 */
export const PAIRING_EXCHANGE_POLICY: AttemptPolicy = {
  threshold: 300,
  baseMs: 5_000,
  maxMs: 5 * 60_000,
  retentionMs: 10 * 60_000,
  maxKeys: MAX_KEYS,
};

/** WS bileti: baglanti basina bir bilet; anahtar = IP + actor (dogrulanmis token'dan). */
export const WS_TICKET_POLICY: AttemptPolicy = {
  threshold: 30,
  baseMs: 1_000,
  maxMs: 60_000,
  retentionMs: 5 * 60_000,
  maxKeys: MAX_KEYS,
};

interface AttemptState {
  failures: number;
  blockedUntil: number;
  lastFailureAt: number;
}

export interface AttemptLimiter {
  keyFor(remoteAddress: string | undefined, subject?: string): string;
  /** Ayni anahtarin denemelerini sirayla kosar; paralel istekler sayaci delemez. */
  serialize<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Kalan bekleme (ms); 0 ise deneme serbest. */
  retryAfterMs(key: string): number;
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
  /**
   * Kimliksiz uclar icin: bekleme varsa onu (ms) dondurur ve istegi SAYMAZ;
   * yoksa istegi bir deneme olarak sayar ve 0 dondurur. Kontrol ve sayim ayni
   * senkron adimda oldugundan paralel istekler kotayi delemez.
   */
  admit(key: string): number;
}

export function createAttemptLimiter(input: {
  secret: string;
  policy: AttemptPolicy;
  now?: () => number;
}): AttemptLimiter {
  const { policy } = input;
  const now = input.now ?? (() => Date.now());
  /** Map ekleme sirasi en eski -> en yeni; her hata anahtari sona tasir. */
  const attempts = new Map<string, AttemptState>();
  const queues = new Map<string, Promise<void>>();

  /** Suresi dolmus sayaci unutur; yoksa gecerli durumu dondurur. */
  const liveState = (key: string): AttemptState | undefined => {
    const state = attempts.get(key);
    if (!state) return undefined;
    const current = now();
    if (current >= state.blockedUntil && current - state.lastFailureAt > policy.retentionMs) {
      attempts.delete(key);
      return undefined;
    }
    return state;
  };

  const retryAfterMs = (key: string): number => {
    const state = liveState(key);
    return state ? Math.max(0, state.blockedUntil - now()) : 0;
  };

  const recordFailure = (key: string): void => {
    const current = now();
    const failures = (liveState(key)?.failures ?? 0) + 1;
    const blockedUntil =
      failures < policy.threshold
        ? 0
        : current + Math.min(policy.baseMs * 2 ** (failures - policy.threshold), policy.maxMs);
    attempts.delete(key);
    attempts.set(key, { failures, blockedUntil, lastFailureAt: current });

    if (attempts.size > policy.maxKeys) {
      const oldest = attempts.keys().next();
      if (!oldest.done) attempts.delete(oldest.value);
    }
  };

  return {
    keyFor(remoteAddress, subject = '') {
      return createHmac('sha256', input.secret)
        .update(remoteAddress ?? 'unknown')
        .update('\0')
        .update(subject.trim().toLowerCase())
        .digest('base64url');
    },

    async serialize(key, task) {
      const previous = queues.get(key) ?? Promise.resolve();
      let release: () => void = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      queues.set(key, current);
      await previous;
      try {
        return await task();
      } finally {
        release();
        if (queues.get(key) === current) queues.delete(key);
      }
    },

    retryAfterMs,
    recordFailure,

    recordSuccess(key) {
      attempts.delete(key);
    },

    admit(key) {
      const waitingMs = retryAfterMs(key);
      if (waitingMs > 0) return waitingMs;
      recordFailure(key);
      return 0;
    },
  };
}

/** 429 + Retry-After. Giris ve kimliksiz uclar ayni bicimi konusur. */
export function tooManyRequests(c: Context, waitingMs: number, error: string): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(waitingMs / 1000));
  c.header('Retry-After', String(retryAfterSeconds));
  return c.json({ error, retryAfterSeconds }, 429);
}

/** Kimliksiz uc: istek basina IP kotasi; dolunca rota calistirilmadan 429. */
export function limitByIp(limiter: AttemptLimiter): MiddlewareHandler {
  return async (c, next) => {
    const waitingMs = limiter.admit(limiter.keyFor(resolveRemoteAddress(c)));
    if (waitingMs > 0) return tooManyRequests(c, waitingMs, 'Cok fazla istek.');
    await next();
  };
}
