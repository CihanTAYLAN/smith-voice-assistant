import type { JobsOptions } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { longRunningOptions, QUEUE_JOB_OPTIONS, sideEffectfulOptions } from './options.js';
import { QueueName } from './queue-names.js';

/**
 * BullMQ `exponential` geri cekilme: basarisiz `n`. denemeden sonra bekleme
 * `delay * 2^(n-1)`. Ilk deneme beklemesizdir; bekleme `attempts - 1` kez olur.
 */
function backoffDelaysMs(options: JobsOptions): number[] {
  const attempts = options.attempts ?? 1;
  const backoff = options.backoff;
  if (typeof backoff !== 'object' || backoff.type !== 'exponential') return [];
  const base = backoff.delay ?? 0;
  return Array.from({ length: attempts - 1 }, (_, index) => base * 2 ** index);
}

const MINUTE_MS = 60_000;

describe('uzun suren arka plan isi (ozet, gomme) yeniden denemesi', () => {
  it('kota ve kesinti dakikalarca surer: bekleme penceresi en az 10 dakikaya yayilir', () => {
    const delays = backoffDelaysMs(longRunningOptions);
    expect(delays.length).toBeGreaterThanOrEqual(4);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThanOrEqual(10 * MINUTE_MS);
  });

  it('ilk yeniden deneme saniyeler icinde degil, dakikalik kota penceresinin yarisindan sonradir', () => {
    expect(backoffDelaysMs(longRunningOptions)[0]).toBeGreaterThanOrEqual(30_000);
  });

  it('indeksleme ve ozet kuyruklari bu preset ile calisir', () => {
    expect(QUEUE_JOB_OPTIONS[QueueName.MEMORY_INDEX]).toBe(longRunningOptions);
    expect(QUEUE_JOB_OPTIONS[QueueName.SESSION_SUMMARY]).toBe(longRunningOptions);
  });
});

describe('ajan kosusu yeniden denemesi', () => {
  it('motor yeniden CALISTIRILMAZ: attempts 1 (idempotency veritabaninda, yeniden deneme karari insanda)', () => {
    expect(sideEffectfulOptions.attempts).toBe(1);
    expect(QUEUE_JOB_OPTIONS[QueueName.AGENT_RUN]).toBe(sideEffectfulOptions);
  });
});
